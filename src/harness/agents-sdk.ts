import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { relative } from "node:path";
import { invalidRequestError, policyDeniedError } from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import type { PolicyAuthority } from "../core/policy.js";
import type { ManagedSession } from "../runtime/session.js";
import type { ReopenReport } from "../runtime/release.js";
import type { BlobStore } from "../store/blob-store.js";
import type { EnvironmentLease } from "../schema/adapter.js";
import type { AttachmentSummary } from "../schema/session.js";

/**
 * Harness integration for the OpenAI Agents SDK (SPEC.md section 17).
 *
 * The Agents SDK owns the agent loop and the conversation. This toolkit
 * routes the managed part of each turn — running work on attached
 * environments, synchronizing local edits, and reporting environment
 * changes — through the Portable contracts. It never manages context
 * and never claims to restore a conversation.
 *
 * The toolkit produces tool definitions whose shape the SDK adopts
 * directly: `tool({ name, description, parameters, execute })`. The
 * library stays independent of the SDK package, so the embedding
 * application stays on its own SDK version.
 */

/** One tool definition the harness adopts into its agent loop. */
export interface HarnessTool {
  name: string;
  description: string;
  /** JSON schema of the tool input. */
  parameters: Record<string, unknown>;
  /** Run the tool and return its result text to the model. */
  execute(input: Record<string, unknown>): Promise<string>;
}

/**
 * The route of the harness's built-in shell and file tools (SPEC.md
 * section 17).
 *
 * `local-bridge`: the built-in tools operate on one local bridge
 * directory, and the toolkit synchronizes that directory's edits into
 * the workspace through the checkpoint contract. The harness's own
 * permission system governs those tools; they are not managed work, so
 * Portable policy never mediates them.
 *
 * `excluded`: the embedding application disables the built-in tools.
 * Shell and file work runs only through attached environments, and
 * every bit of it is managed work under Portable policy.
 */
export type BuiltInToolRoute =
  | { decision: "local-bridge"; bridgeRootPath: string }
  | { decision: "excluded" };

/** Principal schemes an approval may arrive under. */
const APPROVED_BY_SCHEMES = ["user://", "approval://", "operator://"];

/**
 * One trusted harness approval (SPEC.md section 17).
 *
 * The harness constructs this record in its own approval callback, from
 * an authenticated human action. Model-generated text never builds one:
 * a request for a capability inside generated text is input to the
 * agent loop, not approval of it.
 */
export interface HarnessApproval {
  /** The authenticated approver, for example `user://ada`. */
  approvedBy: string;
  /** Capability grants the approval covers, for example `exec.process@1`. */
  operations?: string[];
  /** Provider grants the approval covers. */
  providers?: string[];
  /** Wall-clock expiry; the grant refuses to authorize past it. */
  expiresAt?: string;
}

/** What the toolkit asks the harness's approval flow to authorize. */
export interface ApprovalRequest {
  operations: string[];
  providers?: string[];
}

/** The harness's trusted approval surface. */
export interface HarnessApprovalSource {
  approve(requested: ApprovalRequest): Promise<HarnessApproval | null>;
}

/** The environment context update one tool result carries (SPEC.md 17). */
export interface EnvironmentContextUpdate {
  sessionId: string;
  workspace: { workspaceId: string; headRevisionId?: string };
  attachments: Array<{
    attachmentId: string;
    name: string;
    generation: number;
    status: AttachmentSummary["status"];
    capabilities: string[];
  }>;
  resources: Array<{
    id: string;
    type: string;
    capability: string;
    status: "bound" | "invalidated";
    ownerGeneration: number;
    expiresAt?: string;
  }>;
  builtInToolRoute: BuiltInToolRoute;
  /** Where the harness conversation lives: outside Portable, opaque. */
  harnessContextRef?: string;
}

/** The managed process capability this version of the toolkit routes. */
const PROCESS = "exec.process@1";

/** Options of one toolkit bound to one managed session. */
export interface AgentsToolkitOptions {
  session: ManagedSession;
  blobs: BlobStore;
  /** The built-in shell and file tool decision this integration runs. */
  route: BuiltInToolRoute;
  /** The operator's trusted base authority. Approvals only narrow it. */
  authority: PolicyAuthority;
  /** The harness's trusted approval surface. */
  approvals: HarnessApprovalSource;
  /** The authenticated principal the harness runs as. */
  principal: string;
  /** Reach the lease of one attached environment. */
  leaseOf(environmentId: string): Promise<EnvironmentLease>;
  /**
   * Root the verification copies materialize under. The environment
   * adapter's working-copy root must be the same directory, so a
   * relative working directory resolves inside the verification copy.
   */
  runsRoot?: string;
  /** Opaque harness conversation reference, carried uninterpreted. */
  harnessContextRef?: string;
}

/**
 * Translate one trusted harness approval into bounded runtime
 * authority (SPEC.md section 17).
 *
 * The result is a narrowing of the base authority: it can only lose
 * grants, never add one. An approval that names a capability the base
 * withholds grants nothing, because the intersection stays empty. The
 * record must come from the harness's approval flow; a value shaped by
 * model output refuses here.
 */
export function authorityForApproval(
  base: PolicyAuthority,
  approval: HarnessApproval,
): PolicyAuthority {
  if (approval === null || typeof approval !== "object") {
    throw invalidRequestError("An approval must be one trusted record.");
  }
  const approvedBy = approval.approvedBy;
  if (
    typeof approvedBy !== "string" ||
    !APPROVED_BY_SCHEMES.some((scheme) => approvedBy.startsWith(scheme))
  ) {
    throw invalidRequestError(
      "The approval names no authenticated approver, so it grants nothing.",
      { approvedBy: String(approvedBy) },
    );
  }
  if (
    approval.expiresAt !== undefined &&
    Number.isFinite(Date.parse(approval.expiresAt)) &&
    Date.parse(approval.expiresAt) <= Date.now()
  ) {
    throw policyDeniedError("The approval expired; it grants nothing.", {
      approvedBy,
      expiresAt: approval.expiresAt,
    });
  }
  return base.derive({
    schemaVersion: 1,
    ...(approval.operations !== undefined ? { operations: approval.operations } : {}),
    ...(approval.providers !== undefined ? { providers: approval.providers } : {}),
  });
}

/** The report of one reopen, with the harness limits stated plainly. */
export interface ReopenOutcome {
  report: ReopenReport;
  /** Always false: Portable restores records, never a conversation. */
  readonly conversationRestored: false;
  /** The plain-language limits the harness operator reads. */
  harnessNotice: string;
}

/** The toolkit one harness embeds around a managed session. */
export class AgentsToolkit {
  private readonly options: AgentsToolkitOptions;
  private checkpoints = 0;
  private runs = 0;

  constructor(options: AgentsToolkitOptions) {
    this.options = options;
  }

  /** The tools this toolkit offers the harness's agent loop. */
  tools(): HarnessTool[] {
    const tools: HarnessTool[] = [environmentTool(this), runTool(this)];
    if (this.options.route.decision === "local-bridge") {
      tools.splice(1, 0, checkpointTool(this));
    }
    return tools;
  }

  /**
   * The environment context update (SPEC.md section 17).
   *
   * The update reports the capabilities of every attachment, the
   * validity of every resource binding, the workspace head, and the
   * built-in tool route. Tool results carry the same record, so an
   * agent that just changed the environment sees the change without a
   * separate call.
   */
  async environmentContext(): Promise<EnvironmentContextUpdate> {
    const description = await this.options.session.describe();
    const bindings = this.options.session.controlStore.listResourceBindings(
      this.options.session.id,
    );
    return {
      sessionId: this.options.session.id,
      workspace: description.workspace,
      attachments: description.attachments.map((attachment) => ({
        attachmentId: attachment.attachmentId,
        name: attachment.name,
        generation: attachment.generation,
        status: attachment.status,
        capabilities: [...attachment.capabilityIds],
      })),
      resources: bindings.map((binding) => ({
        id: binding.id,
        type: binding.type,
        capability: binding.capability,
        status: binding.status,
        ownerGeneration: binding.owner.generation,
        ...(binding.expiresAt !== undefined ? { expiresAt: binding.expiresAt } : {}),
      })),
      builtInToolRoute: this.options.route,
      ...(this.options.harnessContextRef !== undefined
        ? { harnessContextRef: this.options.harnessContextRef }
        : {}),
    };
  }

  /**
   * Synchronize local edits through the workspace checkpoint contract.
   *
   * The declaration says the bridge's writers are quiescent because the
   * harness runs one tool at a time. An integration that allows
   * parallel tool calls must not claim that; its operator disables
   * them or stops using this toolkit.
   */
  async synchronizeBridge(): Promise<{ revisionId: string; created: boolean }> {
    if (this.options.route.decision !== "local-bridge") {
      throw policyDeniedError("The integration excluded its built-in tools, so it names no bridge to synchronize.", {
        route: this.options.route.decision,
      });
    }
    this.checkpoints += 1;
    const current = (await this.options.session.describe()).workspace.headRevisionId;
    const outcome = await this.options.session.checkpoint(
      this.options.blobs,
      {
        requestKey: `bridge-${randomUUID()}`,
        source: { kind: "bridge", rootPath: this.options.route.bridgeRootPath },
        ...(current !== undefined ? { expectedHead: current } : {}),
      },
      {
        stability: {
          kind: "locked",
          detail: "The harness runs one tool at a time; no bridge writer is active during a tool call.",
        },
      },
    );
    return { revisionId: outcome.revision.id, created: outcome.created };
  }

  /**
   * Reopen the session and state the limits honestly (SPEC.md 17).
   *
   * Portable restores durable records: attachments, the workspace
   * head, obligations, and in-flight operations exactly as stored. It
   * does not restore the harness conversation, and it does not resume
   * the agent loop. The harness keeps its conversation; the reference
   * it carries here stays opaque.
   */
  async reopen(): Promise<ReopenOutcome> {
    const report = await this.options.session.reopen();
    const harnessNotice = [
      "Portable reopened the durable records of this session: attachment",
      "states, the workspace head, pending cleanup, and in-flight",
      "operations exactly as stored.",
      "Portable did not restore the harness conversation and did not",
      "resume the agent loop. The harness owns both; hand it its own",
      "conversation state or start a fresh conversation over the same",
      "records.",
      this.options.harnessContextRef !== undefined
        ? `The harness conversation reference travels separately as ${this.options.harnessContextRef}; Portable stores it uninterpreted.`
        : "No harness conversation reference was configured for this session.",
    ].join(" ");
    return { report, conversationRestored: false, harnessNotice };
  }

  /**
   * Run one managed process through the attached environment.
   *
   * Every run passes through the harness's approval flow first. A run
   * the approver does not cover refuses before admission, and a
   * refusal is data in the tool result, not a crash of the loop.
   */
  async run(input: {
    command: string;
    args?: string[];
    requestKey?: string;
    verify?: boolean;
  }): Promise<Record<string, unknown>> {
    const context = await this.environmentContext();
    const attachment = context.attachments.find((entry) => entry.status === "active");
    if (attachment === undefined) {
      return refused("no-active-attachment", "No active attachment runs managed work.", context);
    }
    const approval = await this.options.approvals.approve({ operations: [PROCESS] });
    if (approval === null || approval === undefined) {
      return refused(
        "no-approval",
        "The harness approval flow returned no approval, so the run never started.",
        context,
      );
    }
    let authority: PolicyAuthority;
    try {
      authority = authorityForApproval(this.options.authority, approval);
    } catch (error) {
      return refusedAsRecord(error, context);
    }
    const attachmentRef = {
      sessionId: this.options.session.id,
      attachmentId: attachment.attachmentId,
      generation: attachment.generation,
    };
    const launch = {
      command: input.command,
      ...(input.args !== undefined ? { args: input.args } : {}),
    };
    const requestKey = input.requestKey ?? `harness-run-${randomUUID()}`;
    let operation;
    try {
      operation = await this.options.session.invoke(
        {
          requestKey,
          attachment: attachmentRef,
          capability: PROCESS,
          operation: "run",
          input: launch,
        },
        { authority },
      );
    } catch (error) {
      return refusedAsRecord(error, context);
    }

    let verification: Record<string, unknown> | undefined;
    let processInput: Record<string, unknown> = { ...launch };
    if (input.verify === true) {
      const prepared = await this.prepareVerification(operation, attachmentRef, launch, authority);
      if (prepared.status === "refused") {
        return { ...prepared, environment: context };
      }
      verification = prepared.verify;
      processInput = { ...processInput, cwd: prepared.cwd };
    }

    const environmentId = await this.environmentIdOf(attachment.attachmentId);
    const settled = await this.dispatchAndSettle(operation.id, processInput, environmentId);
    if (verification !== undefined && settled.status === "completed") {
      // The run happened inside a verification copy; measure what
      // changed against the tested revision.
      try {
        const measured = await this.options.session.settleVerificationRun(
          this.options.blobs,
          { operationId: operation.id, attachment: attachmentRef },
        );
        verification = {
          ...verification,
          changedPaths: measured.changedPaths,
          outputRootHash: measured.outputRootHash,
        };
      } catch (error) {
        return refusedAsRecord(error, context);
      }
    }
    return {
      status: settled.status,
      operationId: operation.id,
      ...(settled.status === "completed" ? { result: settled.result } : { error: settled.error }),
      ...(verification !== undefined ? { verify: verification } : {}),
      environment: context,
    };
  }

  /** Prepare one verification run: synchronize, then stage the copies. */
  private async prepareVerification(
    operation: { id: string },
    attachmentRef: { sessionId: string; attachmentId: string; generation: number },
    launch: { command: string; args?: string[] },
    authority: PolicyAuthority,
  ): Promise<
    | { status: "refused"; code: string; message: string }
    | { status: "prepared"; cwd: string; verify: Record<string, unknown> }
  > {
    if (this.options.runsRoot === undefined) {
      return {
        status: "refused",
        code: "InvalidRequest",
        message: "The toolkit was configured without a runs root, so it stages no verification copies.",
      };
    }
    // Remote verification first synchronizes local edits through the
    // checkpoint contract (SPEC.md section 17).
    let synchronized: { revisionId: string; created: boolean };
    try {
      synchronized = await this.synchronizeBridge();
    } catch (error) {
      return refusalOf(error);
    }
    const description = await this.options.session.describe();
    const head = description.workspace.headRevisionId;
    if (head === undefined) {
      return {
        status: "refused",
        code: "InvalidRequest",
        message: "The synchronized bridge produced no workspace head to verify against.",
      };
    }
    this.runs += 1;
    const copyRoot = `${this.options.runsRoot}/copy-${this.runs}`;
    const verificationRoot = `${this.options.runsRoot}/verify-${this.runs}`;
    mkdirSync(copyRoot, { recursive: true });
    mkdirSync(verificationRoot, { recursive: true });
    try {
      const copy = await this.options.session.materialize(
        this.options.blobs,
        head,
        copyRoot,
        { authority, mode: "proposal" },
      );
      const prepared = await this.options.session.prepareVerificationRun(
        this.options.blobs,
        {
          operationId: operation.id,
          attachment: attachmentRef,
          capability: PROCESS,
          operation: "run",
          arguments: launch,
          workingCopyId: copy.record.id,
        },
        { authority, destination: verificationRoot },
      );
      const cwd = relative(this.options.runsRoot, verificationRoot);
      return {
        status: "prepared",
        cwd,
        verify: {
          synchronizedRevisionId: synchronized.revisionId,
          synchronizedNewRevision: synchronized.created,
          testedRevisionId: prepared.provenance.testedRevisionId,
          verificationCopyId: prepared.verificationCopy.id,
        },
      };
    } catch (error) {
      return refusalOf(error);
    }
  }

  /** Dispatch one admitted operation through its lease and settle it. */
  private async dispatchAndSettle(
    operationId: string,
    processInput: Record<string, unknown>,
    environmentId: string,
  ): Promise<
    | { status: "completed"; result: unknown }
    | { status: "refused"; code: string; message: string; error?: unknown }
  > {
    try {
      await this.options.session.markDispatched(operationId);
      const lease = await this.options.leaseOf(environmentId);
      const answered = await lease.invoke({
        operationId,
        capability: PROCESS,
        operation: "run",
        input: processInput,
        environmentId,
        limits: {},
      });
      if (answered.status !== "completed") {
        const error = providerError(answered.error);
        await this.options.session.settle(operationId, { kind: "failed", error });
        return { status: "refused", code: error.code, message: error.message, error };
      }
      await this.options.session.settle(operationId, {
        kind: "completed",
        resultRef: JSON.stringify(answered.result ?? null),
      });
      return { status: "completed", result: answered.result };
    } catch (error) {
      return {
        status: "refused",
        code: codeOf(error) ?? "ProviderUnavailable",
        message: messageOf(error),
        error,
      };
    }
  }

  /** The environment one attachment currently runs on. */
  private async environmentIdOf(attachmentId: string): Promise<string> {
    const description = await this.options.session.describe();
    const found = description.attachments.find(
      (candidate) => candidate.attachmentId === attachmentId,
    );
    const environmentId = found?.environmentId;
    if (environmentId === undefined) {
      throw invalidRequestError(
        `Attachment ${attachmentId} names no environment to run on.`,
        { attachmentId },
      );
    }
    return environmentId;
  }
}

/** The environment context tool: the explicit context update surface. */
function environmentTool(toolkit: AgentsToolkit): HarnessTool {
  return {
    name: "portable_environment",
    description:
      "Report the managed environments: attachment capabilities, resource validity, the workspace revision, and where built-in shell and file tools run. Read this after any attachment or replacement change.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(): Promise<string> {
      return JSON.stringify(await toolkit.environmentContext());
    },
  };
}

/** The bridge checkpoint tool: synchronize local edits. */
function checkpointTool(toolkit: AgentsToolkit): HarnessTool {
  return {
    name: "portable_checkpoint",
    description:
      "Synchronize the local bridge directory's edits into a workspace revision. Run this before offering local work as verified or authoritative.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(): Promise<string> {
      try {
        const outcome = await toolkit.synchronizeBridge();
        return JSON.stringify({
          status: "checkpointed",
          ...outcome,
          environment: await toolkit.environmentContext(),
        });
      } catch (error) {
        return JSON.stringify({
          status: "refused",
          code: codeOf(error) ?? "Unknown",
          message: messageOf(error),
        });
      }
    },
  };
}

/** The managed run tool: approval-gated environment execution. */
function runTool(toolkit: AgentsToolkit): HarnessTool {
  return {
    name: "portable_run",
    description:
      "Run one command on the attached managed environment. The run passes the harness approval flow first; a run without an approval refuses. Set verify true to synchronize local edits first and run inside a private verification copy of the workspace head.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable to run." },
        args: { type: "array", items: { type: "string" }, description: "Arguments, passed verbatim." },
        requestKey: { type: "string", description: "Logical request key; a retry under it recovers the same operation." },
        verify: { type: "boolean", description: "Synchronize the bridge first and run inside a verification copy." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<string> {
      return JSON.stringify(
        await toolkit.run({
          command: String(input.command),
          ...(Array.isArray(input.args) ? { args: input.args.map(String) } : {}),
          ...(typeof input.requestKey === "string" ? { requestKey: input.requestKey } : {}),
          ...(input.verify === true ? { verify: true } : {}),
        }),
      );
    },
  };
}

/** One refusal record for a tool result. */
function refused(
  code: string,
  message: string,
  context: EnvironmentContextUpdate,
): Record<string, unknown> {
  return { status: "refused", code, message, environment: context };
}

/** Map one thrown error into a refusal record for a tool result. */
function refusedAsRecord(error: unknown, context: EnvironmentContextUpdate): Record<string, unknown> {
  return refused(codeOf(error) ?? "Unknown", messageOf(error), context);
}

/** The refusal view of one thrown value. */
function refusalOf(error: unknown): { status: "refused"; code: string; message: string } {
  return { status: "refused", code: codeOf(error) ?? "Unknown", message: messageOf(error) };
}

/** The portable code of one thrown value, when it carries one. */
function codeOf(error: unknown): string | null {
  if (error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return null;
}

/** The message of one thrown value. */
function messageOf(error: unknown): string {
  if (error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** The portable error of an adapter answer, or a provider fallback. */
function providerError(error: unknown): PortableError {
  if (error !== null && typeof error === "object" && "code" in error && "message" in error) {
    return error as PortableError;
  }
  return policyDeniedError("The environment answered without a portable error.", {
    detail: JSON.stringify(error ?? null),
  });
}
