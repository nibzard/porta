import { randomUUID } from "node:crypto";
import { ControlStore } from "../../store/control-store.js";
import { PolicyAuthority } from "../../core/policy.js";
import { operationUnknownError, portableError } from "../../core/errors.js";
import type { PortableError } from "../../schema/error.js";
import type { EnvironmentLease, CancellationResult } from "../../schema/adapter.js";
import type { AttachmentSummary } from "../../schema/session.js";
import type { EnvironmentManifest } from "../../schema/capability.js";
import {
  PROCESS_CAPABILITY_ID,
  processCapabilityDescriptor,
} from "../../runtime/process-capability.js";
import type {
  ProcessAttributeDeclarations,
  ProcessInspectResult,
  ProcessRunResult,
  ProcessTerminateResult,
} from "../../runtime/process-capability.js";
import { admitInvocation } from "../../runtime/admission.js";
import {
  markOperationDispatched,
  reconcileOperation,
  settleOperation,
} from "../../runtime/outcomes.js";
import { cancelOperation } from "../../runtime/cancellation.js";
import type { ConformanceCase, ConformanceContext } from "../runner.js";
import type { ConformanceCaseAnswer } from "../runner.js";

/**
 * Process and operation conformance cases (SPEC.md section 21).
 *
 * The process area drives the loaded adapter's `exec.process@1`
 * capability and checks what the provider itself reports: argument
 * preservation, working directory, environment additions, binary
 * output, exit codes, output limits, timeouts, and descendant
 * termination claims.
 *
 * The operations area drives the durable operation protocol in an
 * in-memory store: duplicate request keys, mismatched inputs, lost
 * responses after effects, unconfirmed cancellation, and
 * reconciliation that preserves uncertainty history without
 * re-executing unsafe effects.
 *
 * Cases that drive the loaded adapter declare external effects: a
 * provider may allocate or charge, and spawned processes are real.
 * The operation cases touch an in-memory store only.
 */

/** Extension keys the trails of one operation record live under. */
const CANCELLATION_KEY = "portable.runtime.cancellation";
const RECONCILIATION_KEY = "portable.runtime.reconciliation";

/** One in-memory session the operation cases own. */
interface Bench {
  store: ControlStore;
  sessionId: string;
}

function bench(): Bench {
  const store = ControlStore.inMemory();
  const sessionId = `sess-${randomUUID()}`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId: `ws-${randomUUID()}`,
    eventSequence: 0,
    policyRef: "policy://conformance",
    createdAt: new Date().toISOString(),
  });
  return { store, sessionId };
}

/** One active attachment the admission path accepts. */
function attachmentOf(state: Bench): AttachmentSummary {
  const record: AttachmentSummary = {
    sessionId: state.sessionId,
    attachmentId: `att-${randomUUID()}`,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: [PROCESS_CAPABILITY_ID],
  };
  state.store.insertAttachment(record);
  return record;
}

/** Admit one run invocation under its request key. */
function admit(state: Bench, attached: AttachmentSummary, requestKey: string, input: unknown) {
  return admitInvocation(state.store, state.sessionId, {
    requestKey,
    attachment: {
      sessionId: state.sessionId,
      attachmentId: attached.attachmentId,
      generation: attached.generation,
    },
    capability: PROCESS_CAPABILITY_ID,
    operation: "run",
    input,
  }, {
    authority: PolicyAuthority.fromPolicy({
      schemaVersion: 1,
      operations: [PROCESS_CAPABILITY_ID],
    }),
  });
}

/** Acquire one environment from the loaded adapter. */
async function acquireOnce(context: ConformanceContext): Promise<EnvironmentLease> {
  return context.adapter.acquire({
    acquisitionId: `acq-${randomUUID()}`,
    request: { name: "worker", providerId: context.adapter.id, requires: {} },
    authority: { principal: "conformance", policyRef: "policy://conformance" },
  });
}

/**
 * The skip for a capability the loaded adapter never offered, or null.
 *
 * The process cases test one capability profile, so an adapter that
 * never claimed it reports a skip — never a failure: unclaimed
 * support is unestablished, not violated (SPEC.md section 21).
 */
async function notOffered(
  context: ConformanceContext,
): Promise<ConformanceCaseAnswer | null> {
  const offers = await context.adapter.describe();
  const offered = offers.some((entry) =>
    entry.capabilities.some((capability) => capability.id === PROCESS_CAPABILITY_ID),
  );
  if (offered) {
    return null;
  }
  return {
    outcome: "skip",
    reason: "capability-not-offered",
    detail: "The loaded adapter offers no exec.process@1 capability.",
  };
}

/**
 * Run one process through the loaded adapter and return its result.
 *
 * A run that does not complete is a finding about the adapter; the
 * thrown message carries the reported error for the report.
 */
async function runProcess(
  lease: EnvironmentLease,
  input: Record<string, unknown>,
): Promise<ProcessRunResult> {
  const answered = await lease.invoke({
    operationId: `op-${randomUUID()}`,
    capability: PROCESS_CAPABILITY_ID,
    operation: "run",
    input,
    environmentId: lease.environmentId,
    limits: {},
  });
  if (answered.status !== "completed") {
    throw new Error(
      `The run did not complete: ${JSON.stringify((answered as { error?: unknown }).error)}`,
    );
  }
  return answered.result as ProcessRunResult;
}

/** The decoded text of one captured stream. */
function textOf(capture: { dataBase64?: string }): string {
  return Buffer.from(capture.dataBase64 ?? "", "base64").toString("utf8");
}

/** Read one portable error's code, or null for anything else. */
function codeOf(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

/** The answer of one observation that must refuse with a code. */
async function expectCode(
  run: () => unknown,
  wanted: string,
): Promise<ConformanceCaseAnswer | void> {
  try {
    await run();
  } catch (error) {
    const code = codeOf(error);
    if (code === wanted) {
      return undefined;
    }
    return {
      outcome: "fail",
      reason: `expected ${wanted}, saw ${code ?? "no portable error"}`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { outcome: "fail", reason: `expected ${wanted}, the call succeeded` };
}

/** The process attribute declarations of the loaded adapter. */
async function declaredAttributes(
  lease: EnvironmentLease,
): Promise<ProcessAttributeDeclarations> {
  const manifest: EnvironmentManifest = await lease.manifest();
  const entry = manifest.capabilities.find(
    (capability) => capability.id === PROCESS_CAPABILITY_ID,
  );
  return (entry?.attributes ?? processCapabilityDescriptor().attributes) as unknown as ProcessAttributeDeclarations;
}

/** The declared reach of termination into descendants, or null. */
async function descendantClaim(
  lease: EnvironmentLease,
): Promise<ProcessAttributeDeclarations["descendantTermination"] | null> {
  const attributes = await declaredAttributes(lease);
  return attributes.descendantTermination ?? null;
}

/** Whether the environment can run `pgrep` for third-party checks. */
async function pgrepUsable(lease: EnvironmentLease): Promise<boolean> {
  try {
    const probe = await runProcess(lease, {
      command: "pgrep",
      args: ["-f", `porta-probe-${randomUUID()}`],
    });
    // Exit code 1 means the tool ran and found nothing.
    return probe.exitCode === 1;
  } catch {
    return false;
  }
}

/** The process and operation case pack. */
export function processOperationCases(): ConformanceCase[] {
  return [
    {
      id: "process.argument-preservation",
      area: "process",
      capability: "exec.process@1",
      summary: "Arguments pass verbatim: no splitting, globbing, or quoting.",
      effects: { external: true },
      async run(context) {
        const unoffered = await notOffered(context);
        if (unoffered !== null) {
          return unoffered;
        }
        const lease = await acquireOnce(context);
        const arguments_ = ["a b", "c$d", "*.no-glob", "it's", "tab\tand-new\nline"];
        const result = await runProcess(lease, {
          command: "printf",
          args: ["%s\n", ...arguments_],
        });
        const expected = `${arguments_.join("\n")}\n`;
        if (textOf(result.stdout) !== expected) {
          return {
            outcome: "fail",
            reason: "the provider changed the argument values",
            detail: JSON.stringify(textOf(result.stdout)),
          };
        }
        return undefined;
      },
    },
    {
      id: "process.working-directory",
      area: "process",
      capability: "exec.process@1",
      summary: "A relative working directory resolves inside the authorized copy.",
      effects: { external: true },
      async run(context) {
        const unoffered = await notOffered(context);
        if (unoffered !== null) {
          return unoffered;
        }
        const lease = await acquireOnce(context);
        const defaultDir = textOf((await runProcess(lease, { command: "pwd" })).stdout).trim();
        if (defaultDir.length === 0 || !defaultDir.startsWith("/")) {
          return {
            outcome: "fail",
            reason: "the default working directory is not an absolute path",
            detail: defaultDir,
          };
        }
        await runProcess(lease, { command: "mkdir", args: ["-p", "porta-conf-dir"] });
        const inside = textOf(
          (await runProcess(lease, { command: "pwd", cwd: "porta-conf-dir" })).stdout,
        ).trim();
        if (!inside.endsWith("/porta-conf-dir") || !inside.startsWith(defaultDir)) {
          return {
            outcome: "fail",
            reason: "the relative working directory did not resolve under the copy",
            detail: `${inside} under ${defaultDir}`,
          };
        }
        return undefined;
      },
    },
    {
      id: "process.environment-merge",
      area: "process",
      capability: "exec.process@1",
      summary: "Declared environment additions reach the process; undeclared names do not.",
      effects: { external: true },
      async run(context) {
        const unoffered = await notOffered(context);
        if (unoffered !== null) {
          return unoffered;
        }
        const lease = await acquireOnce(context);
        const name = `PORTA_CONF_PROBE_${randomUUID().slice(0, 8)}`;
        const probe = `printf %s "\${${name}-UNSET}"`;
        const granted = textOf(
          (await runProcess(lease, { command: "sh", args: ["-c", probe], env: { [name]: "granted" } }))
            .stdout,
        );
        if (granted !== "granted") {
          return {
            outcome: "fail",
            reason: "the declared environment addition did not reach the process",
            detail: granted,
          };
        }
        const absent = textOf((await runProcess(lease, { command: "sh", args: ["-c", probe] })).stdout);
        if (absent !== "UNSET") {
          return {
            outcome: "fail",
            reason: "an undeclared environment name reached the process",
            detail: absent,
          };
        }
        return undefined;
      },
    },
    {
      id: "process.binary-output",
      area: "process",
      capability: "exec.process@1",
      summary: "Captures carry bytes outside UTF-8 text without damage.",
      effects: { external: true },
      async run(context) {
        const unoffered = await notOffered(context);
        if (unoffered !== null) {
          return unoffered;
        }
        const lease = await acquireOnce(context);
        const attributes = await declaredAttributes(lease);
        if (attributes.binaryOutput !== true) {
          return {
            outcome: "skip",
            reason: "binary-output-not-declared",
            detail: "The provider declares no binary output support.",
          };
        }
        const result = await runProcess(lease, {
          command: "printf",
          args: ["\\000\\377\\176\\001\\r\\n"],
        });
        const bytes = Buffer.from(result.stdout.dataBase64 ?? "", "base64");
        const expected = Buffer.from([0x00, 0xff, 0x7e, 0x01, 0x0d, 0x0a]);
        if (!bytes.equals(expected)) {
          return {
            outcome: "fail",
            reason: "binary output changed between the process and the capture",
            detail: `${bytes.toString("hex")} != ${expected.toString("hex")}`,
          };
        }
        return undefined;
      },
    },
    {
      id: "process.exit-codes",
      area: "process",
      capability: "exec.process@1",
      summary: "Any exit code completes the operation and reports the code.",
      effects: { external: true },
      async run(context) {
        const unoffered = await notOffered(context);
        if (unoffered !== null) {
          return unoffered;
        }
        const lease = await acquireOnce(context);
        const clean = await runProcess(lease, { command: "sh", args: ["-c", "exit 0"] });
        if (clean.exitCode !== 0) {
          return {
            outcome: "fail",
            reason: "a zero exit did not report exit code 0",
            detail: JSON.stringify(clean.exitCode),
          };
        }
        const failing = await runProcess(lease, { command: "sh", args: ["-c", "exit 7"] });
        if (failing.exitCode !== 7) {
          return {
            outcome: "fail",
            reason: "a nonzero exit did not report its code",
            detail: JSON.stringify(failing.exitCode),
          };
        }
        return {
          outcome: "pass",
          detail: "A nonzero exit is a completed run carrying its exit code.",
        };
      },
    },
    {
      id: "process.output-limits",
      area: "process",
      capability: "exec.process@1",
      summary: "A declared capture limit truncates and says so.",
      effects: { external: true },
      async run(context) {
        const unoffered = await notOffered(context);
        if (unoffered !== null) {
          return unoffered;
        }
        const lease = await acquireOnce(context);
        const result = await runProcess(lease, {
          command: "printf",
          args: ["%s", "A".repeat(64)],
          outputLimits: { maxBytesPerStream: 16 },
        });
        if (result.stdout.byteLength > 16) {
          return {
            outcome: "fail",
            reason: "the capture exceeded the declared limit",
            detail: `${result.stdout.byteLength} bytes`,
          };
        }
        if (result.stdout.truncated !== true) {
          return {
            outcome: "fail",
            reason: "the truncated capture does not say so",
            detail: `held ${result.stdout.byteLength} of 64 bytes`,
          };
        }
        return undefined;
      },
    },
    {
      id: "process.timeout",
      area: "process",
      capability: "exec.process@1",
      summary: "A wall-clock timeout ends the process and reports it as timed out.",
      effects: { external: true },
      async run(context) {
        const unoffered = await notOffered(context);
        if (unoffered !== null) {
          return unoffered;
        }
        const lease = await acquireOnce(context);
        const started = Date.now();
        const result = await runProcess(lease, {
          command: "sleep",
          args: ["30"],
          timeoutMs: 150,
        });
        const wall = Date.now() - started;
        if (result.timedOut !== true) {
          return {
            outcome: "fail",
            reason: "the timeout did not end the process",
            detail: `timedOut ${result.timedOut}, wall ${wall} ms`,
          };
        }
        if (wall > 10_000) {
          return {
            outcome: "fail",
            reason: "the timed-out process was left running",
            detail: `the run held the caller for ${wall} ms`,
          };
        }
        return undefined;
      },
    },
    {
      id: "process.descendant-termination",
      area: "process",
      capability: "exec.process@1",
      summary: "The declared descendant termination claim matches observed behavior.",
      effects: { external: true },
      async run(context): Promise<ConformanceCaseAnswer> {
        const unoffered = await notOffered(context);
        if (unoffered !== null) {
          return unoffered;
        }
        const lease = await acquireOnce(context);
        const claim = await descendantClaim(lease);
        if (claim === null || claim === "none") {
          return {
            outcome: "skip",
            reason: "no-descendant-termination",
            detail: "The provider declares no reach into descendant processes.",
          };
        }
        if (!(await pgrepUsable(lease))) {
          return {
            outcome: "skip",
            reason: "pgrep-unavailable",
            detail: "The environment offers no pgrep for a third-party check.",
          };
        }
        const marker = `porta-conf-${randomUUID().slice(0, 8)}`;
        const started = await lease.invoke({
          operationId: `op-${randomUUID()}`,
          capability: PROCESS_CAPABILITY_ID,
          operation: "start",
          input: { command: "sh", args: ["-c", `sleep 987654 # ${marker}`] },
          environmentId: lease.environmentId,
          limits: {},
        });
        if (started.status !== "completed") {
          return {
            outcome: "fail",
            reason: "the start did not complete",
            detail: JSON.stringify((started as { error?: unknown }).error),
          };
        }
        // The adapter layer names the provider resource; composing the
        // portable ResourceRef is the runtime binding flow's job.
        const start = started.result as { resourceId: string };
        const terminated = await lease.invoke({
          operationId: `op-${randomUUID()}`,
          capability: PROCESS_CAPABILITY_ID,
          operation: "terminate",
          input: { resourceId: start.resourceId },
          environmentId: lease.environmentId,
          limits: {},
        });
        const stop = terminated.result as ProcessTerminateResult;
        if (stop.confirmed !== true || stop.descendantsStopped !== true) {
          return {
            outcome: "fail",
            reason: `the ${claim} claim did not hold`,
            detail: `confirmed ${stop.confirmed}, descendantsStopped ${stop.descendantsStopped}`,
          };
        }
        if (claim === "confirmed") {
          // Third-party truth: the descendant must be gone from the
          // process table, not just reported as stopped.
          let gone = false;
          for (let attempt = 0; attempt < 5 && !gone; attempt += 1) {
            const looked = await runProcess(lease, {
              command: "pgrep",
              args: ["-f", marker],
            });
            gone = looked.exitCode === 1;
            if (!gone) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
          if (!gone) {
            return {
              outcome: "fail",
              reason: "a descendant survived the confirmed termination",
              detail: `pgrep still matched ${marker}`,
            };
          }
        }
        const inspected = await lease.invoke({
          operationId: `op-${randomUUID()}`,
          capability: PROCESS_CAPABILITY_ID,
          operation: "inspect",
          input: { resourceId: start.resourceId },
          environmentId: lease.environmentId,
          limits: {},
        });
        const observation = inspected.result as ProcessInspectResult;
        if (observation.state !== "terminated") {
          return {
            outcome: "fail",
            reason: "the terminated process does not inspect as terminated",
            detail: observation.state,
          };
        }
        return {
          outcome: "pass",
          detail: `Declared ${claim}; the stop confirmed and the group died.`,
        };
      },
    },
    {
      id: "operations.duplicate-request",
      area: "operations",
      summary: "One request key owns one operation, whatever status it holds.",
      async run() {
        const state = bench();
        const attached = attachmentOf(state);
        const key = `op-${randomUUID()}`;
        const first = admit(state, attached, key, { command: "true" });
        const second = admit(state, attached, key, { command: "true" });
        if (first.deduplicated !== false || second.deduplicated !== true) {
          return {
            outcome: "fail",
            reason: "the repeated key did not deduplicate",
            detail: `${first.deduplicated} then ${second.deduplicated}`,
          };
        }
        if (first.operation.id !== second.operation.id) {
          return {
            outcome: "fail",
            reason: "the repeated key created a second operation",
            detail: `${first.operation.id} != ${second.operation.id}`,
          };
        }
        // The key keeps answering after the operation settles; it
        // never dispatches again.
        markOperationDispatched(state.store, state.sessionId, first.operation.id);
        settleOperation(state.store, state.sessionId, first.operation.id, {
          kind: "completed",
          resultRef: "result://once",
        });
        const settled = admit(state, attached, key, { command: "true" });
        if (
          settled.deduplicated !== true ||
          settled.operation.id !== first.operation.id ||
          settled.operation.status !== "completed"
        ) {
          return {
            outcome: "fail",
            reason: "the settled operation was not returned as recorded",
            detail: `${settled.operation.status} for ${settled.operation.id}`,
          };
        }
        return undefined;
      },
    },
    {
      id: "operations.mismatched-input",
      area: "operations",
      summary: "One request key with different input is a conflict, not a retry.",
      async run() {
        const state = bench();
        const attached = attachmentOf(state);
        const key = `op-${randomUUID()}`;
        admit(state, attached, key, { command: "true" });
        return expectCode(
          () => admit(state, attached, key, { command: "false" }),
          "RequestConflict",
        );
      },
    },
    {
      id: "operations.lost-response-after-effects",
      area: "operations",
      summary: "A lost response after effects stays unknown until evidence resolves it.",
      async run() {
        const state = bench();
        const attached = attachmentOf(state);
        const admitted = admit(state, attached, `op-${randomUUID()}`, { command: "touch", args: ["out"] });
        const operationId = admitted.operation.id;
        markOperationDispatched(state.store, state.sessionId, operationId);
        // The response never arrived; the effects may have run.
        const unknown = settleOperation(state.store, state.sessionId, operationId, {
          kind: "unknown",
          error: operationUnknownError(operationId, "The response was lost after dispatch."),
        });
        if (unknown.status !== "unknown") {
          return {
            outcome: "fail",
            reason: "the lost response did not settle as unknown",
            detail: unknown.status,
          };
        }
        // Replaying may double the effects: dispatch refuses.
        const replay = await expectCode(
          () => markOperationDispatched(state.store, state.sessionId, operationId),
          "InvalidRequest",
        );
        if (replay !== undefined) {
          return replay;
        }
        // Provider evidence resolves the outcome exactly once.
        const resolved = reconcileOperation(state.store, state.sessionId, operationId, {
          kind: "completed",
          resultRef: "result://effects-once",
          detail: "The provider journal shows one execution.",
        });
        if (resolved.status !== "completed" || resolved.resultRef !== "result://effects-once") {
          return {
            outcome: "fail",
            reason: "the evidence did not resolve the record",
            detail: `${resolved.status}/${resolved.resultRef}`,
          };
        }
        return undefined;
      },
    },
    {
      id: "operations.unconfirmed-cancellation",
      area: "operations",
      summary: "A stop nobody confirmed leaves the outcome unknown with the attempt recorded.",
      async run() {
        const state = bench();
        const attached = attachmentOf(state);
        const admitted = admit(state, attached, `op-${randomUUID()}`, { command: "sleep", args: ["30"] });
        const operationId = admitted.operation.id;
        const unconfirmed: CancellationResult = {
          outcome: "best-effort",
          stopped: false,
          detail: "The signal was sent; nobody confirmed the stop.",
        };
        const transport = {
          cancel: async () => unconfirmed,
        };
        const first = await cancelOperation(state.store, state.sessionId, operationId, transport);
        if (first.operation.status !== "unknown") {
          return {
            outcome: "fail",
            reason: "the unconfirmed stop settled the outcome",
            detail: first.operation.status,
          };
        }
        const second = await cancelOperation(state.store, state.sessionId, operationId, transport);
        if (second.operation.status !== "unknown") {
          return {
            outcome: "fail",
            reason: "the repeated unconfirmed stop settled the outcome",
            detail: second.operation.status,
          };
        }
        const record = state.store.getOperation(operationId)!;
        const trail = record.extensions?.[CANCELLATION_KEY] as { attempts: unknown[] };
        if (trail?.attempts?.length !== 2) {
          return {
            outcome: "fail",
            reason: "the trail does not carry both unconfirmed attempts",
            detail: JSON.stringify(trail),
          };
        }
        // Reconciliation with evidence closes the uncertainty.
        const cancelled = reconcileOperation(state.store, state.sessionId, operationId, {
          kind: "cancelled",
          error: portableError("InvalidRequest", `Operation ${operationId} was cancelled.`),
          detail: "The provider confirmed the stop after the fact.",
        });
        if (cancelled.status !== "cancelled") {
          return {
            outcome: "fail",
            reason: "the late confirmation did not settle the cancellation",
            detail: cancelled.status,
          };
        }
        const final_ = state.store.getOperation(operationId)!;
        const kept = final_.extensions?.[CANCELLATION_KEY] as { attempts: unknown[] };
        if (kept?.attempts?.length !== 2) {
          return {
            outcome: "fail",
            reason: "settling dropped the uncertainty history",
            detail: JSON.stringify(kept),
          };
        }
        return undefined;
      },
    },
    {
      id: "operations.reconciliation-history",
      area: "operations",
      summary: "Reconciliation keeps the original uncertainty and every pass, oldest first.",
      async run() {
        const state = bench();
        const attached = attachmentOf(state);
        const admitted = admit(state, attached, `op-${randomUUID()}`, { command: "true" });
        const operationId = admitted.operation.id;
        markOperationDispatched(state.store, state.sessionId, operationId);
        settleOperation(state.store, state.sessionId, operationId, {
          kind: "unknown",
          error: operationUnknownError(operationId, "The connection dropped mid-flight."),
        });
        // The first pass finds no evidence yet.
        const open = reconcileOperation(state.store, state.sessionId, operationId, {
          kind: "still-unknown",
          detail: "The provider kept no journal.",
        });
        if (open.status !== "unknown") {
          return {
            outcome: "fail",
            reason: "a still-unknown pass moved the status",
            detail: open.status,
          };
        }
        const closed = reconcileOperation(state.store, state.sessionId, operationId, {
          kind: "completed",
          resultRef: "result://late",
          detail: "A late audit found the outcome.",
        });
        if (closed.status !== "completed") {
          return {
            outcome: "fail",
            reason: "the resolving pass did not move the status",
            detail: closed.status,
          };
        }
        const trail = closed.extensions?.[RECONCILIATION_KEY] as {
          originalError: PortableError;
          observations: Array<{ outcome: string }>;
        };
        if (trail?.observations?.length !== 2 || trail.observations[0]?.outcome !== "still-unknown") {
          return {
            outcome: "fail",
            reason: "the trail does not carry every pass in order",
            detail: JSON.stringify(trail?.observations),
          };
        }
        if (trail.originalError?.code !== "OperationUnknown") {
          return {
            outcome: "fail",
            reason: "the trail lost the original uncertainty",
            detail: JSON.stringify(trail.originalError),
          };
        }
        // A resolved record holds no uncertainty: further passes
        // refuse, and so does another dispatch.
        const repeat = await expectCode(
          () =>
            reconcileOperation(state.store, state.sessionId, operationId, {
              kind: "still-unknown",
              detail: "A late duplicate pass.",
            }),
          "InvalidRequest",
        );
        if (repeat !== undefined) {
          return repeat;
        }
        return expectCode(
          () => markOperationDispatched(state.store, state.sessionId, operationId),
          "InvalidRequest",
        );
      },
    },
  ];
}
