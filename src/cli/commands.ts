import type { CliIo } from "./io.js";
import type { CliConfig, CliConfigInput } from "./config.js";
import {
  loadAdapter,
  loadAuthority,
  openStore,
  readRequest,
  requireSession,
  resolveConfig,
  usageError,
} from "./config.js";
import type { ParsedArguments } from "./args.js";
import { ManagedSession, PortableRuntime } from "../runtime/session.js";
import type { ReplaceFlowOptions } from "../runtime/session.js";
import type { BlobStore } from "../store/blob-store.js";
import { assertValid } from "../schema/validate.js";
import { invalidRequestError, workspaceConflictError } from "../core/errors.js";
import { checkpointRequestSchema } from "../schema/workspace.js";
import type { CheckpointRequest } from "../schema/workspace.js";
import { environmentRequestSchema } from "../schema/capability.js";
import type { EnvironmentRequest } from "../schema/capability.js";
import { invocationRequestSchema } from "../schema/operation.js";
import type { InvocationRequest, OperationRecord } from "../schema/operation.js";
import { replaceRequestSchema } from "../schema/handoff.js";
import type { ReplaceRequest } from "../schema/handoff.js";
import type {
  EnvironmentAdapter,
  EnvironmentLease,
} from "../schema/adapter.js";
import { runConformance } from "../conformance/runner.js";
import type { ConformanceCase } from "../conformance/runner.js";
import { acquisitionPolicyCases } from "../conformance/cases/acquisition-policy.js";
import { workspaceCases } from "../conformance/cases/workspace.js";
import { processOperationCases } from "../conformance/cases/process-operations.js";
import { pythonCases } from "../conformance/cases/python.js";
import { replacementResourceCases } from "../conformance/cases/replacement-resources.js";
import { eventsCases } from "../conformance/cases/events.js";
import { bundleCases } from "../conformance/cases/bundle.js";

/**
 * Command implementations of the Portable CLI (SPEC.md section 16).
 *
 * Every command is thin over the library contracts: it resolves
 * configuration, reads request files, calls one facade method, and
 * prints the returned record as one line of JSON. No command
 * implements a lifecycle rule of its own.
 */

/** An adapter that can hand out the lease of one environment. */
type LeasedAdapter = EnvironmentAdapter & {
  lease(environmentId: string): EnvironmentLease | Promise<EnvironmentLease>;
};

/** Run one parsed runtime command and return its exit code. */
export async function openRuntimeCommand(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const command = parsed.words.join(" ");
  switch (command) {
    case "session create":
      return sessionCreate(parsed, io);
    case "describe":
      return describeSession(parsed, io);
    case "checkpoint":
      return checkpoint(parsed, io);
    case "materialize":
      return materialize(parsed, io);
    case "attach":
      return attach(parsed, io);
    case "invoke":
      return invoke(parsed, io);
    case "operation inspect":
      return inspectOperation(parsed, io);
    case "operation cancel":
      return cancelOperation(parsed, io);
    case "workspace propose":
      return proposeWorkspace(parsed, io);
    case "workspace accept":
      return acceptWorkspace(parsed, io);
    case "replace":
      return replace(parsed, io);
    case "release":
      return release(parsed, io);
    case "events":
      return events(parsed, io);
    case "recover":
      return recover(parsed, io);
    case "conformance":
      return conformance(parsed, io);
    default:
      throw usageError(`Unknown command: ${command}`);
  }
}

/** Create one durable session and print its record. */
async function sessionCreate(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const config = resolveConfig(configInputOf(parsed));
  const { store } = openStore(config);
  const runtime = new PortableRuntime(store);
  const workspace = parsed.values.get("--workspace");
  const session = await runtime.createSession({
    policyRef: valueOf(parsed, "--policy-ref"),
    ...(workspace !== undefined ? { bridgeRootPath: workspace } : {}),
  });
  emit(io, session.record());
  return 0;
}

/** Print the persisted description of one session. */
async function describeSession(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session } = await openInvocation(parsed);
  emit(io, await session.describe());
  return 0;
}

/**
 * Checkpoint one source into a workspace revision.
 *
 * The caller declares how the source's writers were made quiescent;
 * an undeclared source cannot be proven atomic and refuses.
 */
async function checkpoint(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const opened = await openInvocation(parsed);
  const request = validated(valueOf(parsed, "--request"), checkpointRequestSchema) as CheckpointRequest;
  const detail = parsed.values.get("--stability-detail");
  emit(
    io,
    await opened.session.checkpoint(opened.blobs, request, {
      stability: {
        kind: stabilityOf(parsed),
        ...(detail !== undefined ? { detail } : {}),
      },
    }),
  );
  return 0;
}

/**
 * Materialize one revision into a local directory.
 *
 * Transfer policy is checked before any byte is read. A `proposal`
 * copy is private: it reaches the authoritative head only through an
 * accepted proposal (SPEC.md sections 11.3 and 11.6).
 */
async function materialize(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session, config, blobs } = await openInvocation(parsed);
  const copy = await session.materialize(
    blobs,
    valueOf(parsed, "--revision"),
    valueOf(parsed, "--destination"),
    {
      authority: loadAuthority(config),
      mode: modeOf(parsed),
    },
  );
  emit(io, copy);
  return 0;
}

/** Attach one environment through the durable acquisition protocol. */
async function attach(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session, config } = await openInvocation(parsed);
  const adapter = await loadAdapter(valueOf(parsed, "--adapter"));
  const request = validated(valueOf(parsed, "--request"), environmentRequestSchema) as EnvironmentRequest;
  emit(
    io,
    await session.attach({
      adapter,
      request,
      requestKey: valueOf(parsed, "--request-key"),
      principal: valueOf(parsed, "--principal"),
      authority: loadAuthority(config),
    }),
  );
  return 0;
}

/** Admit one invocation and print its durable operation record. */
async function invoke(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session, config } = await openInvocation(parsed);
  const request = validated(valueOf(parsed, "--request"), invocationRequestSchema) as InvocationRequest;
  const operation = await session.invoke(request, { authority: loadAuthority(config) });
  emit(io, operation);
  return 0;
}

/**
 * Print one operation record exactly as stored.
 *
 * An unknown outcome still prints; it exits 3 so the caller cannot
 * mistake an unresolved operation for a settled one.
 */
async function inspectOperation(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session } = await openInvocation(parsed);
  const operation = await session.inspectOperation(valueOf(parsed, "--operation"));
  emit(io, operation);
  return operation.status === "unknown" ? 3 : 0;
}

/** Cancel one operation at its provider through the adapter lease. */
async function cancelOperation(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session } = await openInvocation(parsed);
  const operationId = valueOf(parsed, "--operation");
  const operation = await session.inspectOperation(operationId);
  const environmentId = await environmentOf(session, operation);
  const lease = await leaseOf(await loadAdapter(valueOf(parsed, "--adapter")), environmentId);
  const cancelled = await session.cancelOperation(operationId, {
    cancel: (target) => lease.cancel(target),
  });
  emit(io, { operation: cancelled.operation, cancellation: cancelled.result });
  return 0;
}

/** Offer one working copy's content as a proposal. */
async function proposeWorkspace(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session, blobs } = await openInvocation(parsed);
  const detail = parsed.values.get("--stability-detail");
  const outcome = await session.propose(
    blobs,
    {
      requestKey: valueOf(parsed, "--request-key"),
      copyId: valueOf(parsed, "--copy"),
      attachment: {
        sessionId: session.id,
        attachmentId: valueOf(parsed, "--attachment"),
        generation: generationOf(parsed),
      },
    },
    {
      stability: {
        kind: stabilityOf(parsed),
        ...(detail !== undefined ? { detail } : {}),
      },
    },
  );
  emit(io, outcome);
  return 0;
}

/**
 * Accept one proposal under an expected head.
 *
 * The caller names the head the acceptance expects; a moved head is a
 * known failure, never a surprise overwrite.
 */
async function acceptWorkspace(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session } = await openInvocation(parsed);
  const expected = valueOf(parsed, "--expected-head");
  const current = (await session.describe()).workspace.headRevisionId ?? "none";
  if (current !== expected) {
    throw workspaceConflictError(expected, current);
  }
  emit(io, await session.accept(valueOf(parsed, "--proposal")));
  return 0;
}

/**
 * Plan or run one replacement.
 *
 * The request file wraps the replacement request in `request` and the
 * destination flow in `destination` (adapterModule, copyRoot,
 * principal). `--plan` plans without side effects.
 */
async function replace(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session, config, blobs } = await openInvocation(parsed);
  const envelope = readRequest(valueOf(parsed, "--request"));
  const request = validateField(envelope, "request", replaceRequestSchema) as ReplaceRequest;
  if (parsed.booleans.has("--plan")) {
    emit(io, await session.planReplace(request));
    return 0;
  }
  const destination = objectField(envelope, "destination");
  const adapterModule = stringField(destination, "adapterModule");
  const copyRoot = stringField(destination, "copyRoot");
  const principal = stringField(destination, "principal");
  const adapter = await loadAdapter(adapterModule);
  const flow: ReplaceFlowOptions = {
    destination: {
      adapter,
      leaseOf: (environmentId) => leaseOf(adapter, environmentId),
      bind: refusingTransport,
      blobs,
      copyRoot,
      principal,
      authority: loadAuthority(config),
    },
  };
  emit(io, await session.replace(request, flow));
  return 0;
}

/** Release one attachment and print its outcome. */
async function release(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session, config } = await openInvocation(parsed);
  const outcome = await session.release(
    {
      sessionId: session.id,
      attachmentId: valueOf(parsed, "--attachment"),
      generation: generationOf(parsed),
    },
    valueOf(parsed, "--request-key"),
    {
      adapter: await loadAdapter(valueOf(parsed, "--adapter")),
      principal: valueOf(parsed, "--principal"),
      authority: loadAuthority(config),
    },
  );
  emit(io, outcome);
  // An unresolved release is an unresolved outcome, not a command
  // failure: the record prints and the exit code stays honest.
  return outcome.status === "unresolved" ? 3 : 0;
}

/** Print the session journal as newline-delimited JSON. */
async function events(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session } = await openInvocation(parsed);
  const after = parsed.values.get("--after");
  const afterSequence = after === undefined ? 0 : nonNegativeInteger(after, "--after");
  for await (const event of session.events(afterSequence)) {
    io.out(JSON.stringify(event));
  }
  return 0;
}

/** Reopen the session and print the recovery report. */
async function recover(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const { session } = await openInvocation(parsed);
  emit(io, await session.reopen());
  return 0;
}

/**
 * The case packs a conformance run can select (SPEC.md section 21).
 *
 * A profile names one pack; omitting `--profile` selects every pack.
 */
const CONFORMANCE_PACKS: Readonly<Record<string, () => ConformanceCase[]>> = {
  "acquisition-policy": acquisitionPolicyCases,
  workspace: workspaceCases,
  "process-operations": processOperationCases,
  python: pythonCases,
  "replacement-resources": replacementResourceCases,
  events: eventsCases,
  bundle: bundleCases,
};

/**
 * Run the conformance packs against one loaded adapter.
 *
 * The report prints as one machine record. Failures and skips stay
 * distinct everywhere: a failing run exits 1, a run whose only blemish
 * is a skip exits 3, because skipped support is not established
 * support. Effect and payment grants default refused; the report
 * records the authority the run actually had.
 */
async function conformance(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const adapter = await loadAdapter(valueOf(parsed, "--adapter"));
  const selected = parsed.values.get("--profile");
  const profiles = selected === undefined ? Object.keys(CONFORMANCE_PACKS) : selected.split(",");
  const unknown = profiles.filter((name) => CONFORMANCE_PACKS[name] === undefined);
  if (unknown.length > 0) {
    throw usageError(`Unknown conformance profile: ${unknown.join(", ")}.`);
  }
  const cases = profiles.flatMap((name) => CONFORMANCE_PACKS[name]!());
  const offers = await adapter.describe();
  const timeout = parsed.values.get("--case-timeout-ms");
  const report = await runConformance(
    { name: profiles.join("+"), adapter, cases },
    {
      authority: {
        principal: parsed.values.get("--principal") ?? "conformance://cli",
        policyRef: parsed.values.get("--policy-ref") ?? "policy://conformance",
        externalEffects: parsed.booleans.has("--external-effects"),
        paidAllocation: parsed.booleans.has("--paid-allocation"),
      },
      adapterVersion: valueOf(parsed, "--adapter-version"),
      // The adapter's own offers state the provider configuration the
      // run executed against (SPEC.md section 21).
      providerConfiguration: {
        offers: offers.map((offer) => ({
          providerId: offer.providerId,
          adapterId: offer.adapterId,
          platform: offer.platform,
          capabilities: offer.capabilities.map((capability) => capability.id),
          enforcement: offer.enforcement,
        })),
      },
      ...(timeout !== undefined ? { caseTimeoutMs: positiveInteger(timeout, "--case-timeout-ms") } : {}),
    },
  );
  emit(io, report);
  if (report.verdict === "fail") {
    return 1;
  }
  return report.verdict === "incomplete" ? 3 : 0;
}

/** The default bind transport: it refuses, honestly. */
const refusingTransport = {
  async bind() {
    return { status: "unsupported" as const };
  },
};

/** Print one machine record: one line of JSON on standard output. */
function emit(io: CliIo, record: unknown): void {
  io.out(JSON.stringify(record));
}

/**
 * Resolve the invocation one command runs in.
 *
 * The store opens once: the control store connection, its blob store,
 * the runtime, and the session all share it. A second connection
 * would contend with the first on the write lock.
 */
async function openInvocation(
  parsed: ParsedArguments,
): Promise<{
  config: CliConfig;
  session: ManagedSession;
  blobs: BlobStore;
}> {
  const config = resolveConfig(configInputOf(parsed));
  const { store, blobs } = openStore(config);
  const runtime = new PortableRuntime(store);
  const session = await runtime.openSession(requireSession(config));
  return { config, session, blobs };
}

/** Map parsed configuration flags onto the resolver input. */
export function configInputOf(parsed: ParsedArguments): CliConfigInput {
  const input: CliConfigInput = {};
  const store = parsed.config.get("--store");
  if (store !== undefined) {
    input.storePath = store;
  }
  const policy = parsed.config.get("--policy-file");
  if (policy !== undefined) {
    input.policyPath = policy;
  }
  const session = parsed.config.get("--session");
  if (session !== undefined) {
    input.sessionId = session;
  }
  return input;
}

/** One required valued option. */
function valueOf(parsed: ParsedArguments, flag: string): string {
  const value = parsed.values.get(flag);
  if (value === undefined) {
    throw usageError(`Missing required option ${flag} for ${parsed.words.join(" ")}.`);
  }
  return value;
}

/** One required positive generation number. */
function generationOf(parsed: ParsedArguments): number {
  return positiveInteger(valueOf(parsed, "--generation"), "--generation");
}

/** One required stability declaration. */
function stabilityOf(parsed: ParsedArguments): "locked" | "snapshot" {
  const raw = valueOf(parsed, "--stability");
  if (raw !== "locked" && raw !== "snapshot") {
    throw usageError("Option --stability needs locked or snapshot.");
  }
  return raw;
}

/** One required working-copy mode. */
function modeOf(parsed: ParsedArguments): "read-only" | "proposal" {
  const raw = valueOf(parsed, "--mode");
  if (raw !== "read-only" && raw !== "proposal") {
    throw usageError("Option --mode needs read-only or proposal.");
  }
  return raw;
}

/** Parse one positive integer option value. */
function positiveInteger(raw: string, flag: string): number {  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw usageError(`Option ${flag} needs a positive integer, not ${raw}.`);
  }
  return value;
}

/** Parse one nonnegative integer option value. */
function nonNegativeInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(`Option ${flag} needs a nonnegative integer, not ${raw}.`);
  }
  return value;
}

/** Read and schema-check one request file or standard input. */
function validated(source: string, schema: object): unknown {
  const request = readRequest(source);
  assertValid(schema, request);
  return request;
}

/** One object field of a request envelope. */
function objectField(envelope: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = envelope[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequestError(`The request field ${field} must be one JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** One object field of a request envelope, checked against its schema. */
function validateField(envelope: Record<string, unknown>, field: string, schema: object): unknown {
  const value = objectField(envelope, field);
  assertValid(schema, value);
  return value;
}

/** One string field of a request envelope. */
function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidRequestError(`The request field ${field} must be a nonempty string.`);
  }
  return value;
}

/** The environment one operation's attachment runs on. */
async function environmentOf(session: ManagedSession, operation: OperationRecord): Promise<string> {
  const description = await session.describe();
  const attachment = description.attachments.find(
    (candidate) =>
      candidate.attachmentId === operation.attachment.attachmentId &&
      candidate.generation === operation.attachment.generation,
  );
  const environmentId = attachment?.environmentId;
  if (environmentId === undefined) {
    throw invalidRequestError(
      `Attachment ${operation.attachment.attachmentId} names no environment to cancel on.`,
      { attachmentId: operation.attachment.attachmentId },
    );
  }
  return environmentId;
}

/** Reach one environment lease through the adapter module. */
async function leaseOf(adapter: EnvironmentAdapter, environmentId: string): Promise<EnvironmentLease> {
  const leased = adapter as LeasedAdapter;
  if (typeof leased.lease !== "function") {
    throw usageError(
      "The adapter module exposes no environment lease; cancellation and replacement need one.",
    );
  }
  return leased.lease(environmentId);
}
