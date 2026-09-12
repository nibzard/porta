/**
 * The acceptance demonstration driver (SPEC.md section 22.1).
 *
 * One Portable session walks the seven specification steps over the
 * executable fixture of `fixtures/acceptance`: inspect through
 * lightweight Python, attach local native execution, checkpoint and
 * attach an independent browser, replace local compute with a
 * destination environment, reconnect the browser and record
 * verification artifacts, inject a replacement failure and recover,
 * then release compute and reopen the session. The returned report
 * carries the evidence of every step: identifiers, exit codes,
 * revisions, and the status of every resource handle.
 *
 * Two pieces are stand-ins, and the report says so:
 *
 * - The destination is pluggable. The automated run uses
 *   `remoteLinuxStandin`, a second local process provider, because no
 *   remote Linux credentials exist in a test run. An operator with
 *   credentials passes the E2B adapter instead (see
 *   `docs/adapters/e2b-linux.md`); every other step is unchanged.
 * - The browser driver loads documents over HTTP and follows the data
 *   endpoint each page declares. It executes no page script, and the
 *   report never claims a rendered view; a real integration supplies
 *   a driver backed by a real browser engine.
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

import { PolicyAuthority } from "../core/policy.js";
import { portableError } from "../core/errors.js";
import { BlobStore } from "../store/blob-store.js";
import { ControlStore } from "../store/control-store.js";
import { PortableRuntime } from "../runtime/session.js";
import type { ManagedSession, ReplaceFlowOptions } from "../runtime/session.js";
import type { BindTransport } from "../runtime/resources.js";
import { exposeService, connectService } from "../runtime/service-connections.js";
import { serviceCapabilityDescriptor } from "../runtime/service-capability.js";
import { reconnectBrowserService } from "../runtime/browser-continuity.js";
import type { BrowserContinuityTransport } from "../runtime/browser-continuity.js";
import { HttpBrowserDriver } from "../adapters/http-browser-driver.js";
import type { StandinPageRecord } from "../adapters/http-browser-driver.js";
import { abortReplacement } from "../runtime/replacement.js";
import type { ReplaceRequest } from "../schema/handoff.js";
import type {
  AcquisitionStatus,
  AdapterOperation,
  AuthorizedAcquireRequest,
  BindingResult,
  EnvironmentAdapter,
  EnvironmentLease,
} from "../schema/adapter.js";
import type {
  CapabilityDescriptor,
  EnvironmentOffer,
} from "../schema/capability.js";
import type { AttachmentRef, AttachmentSummary } from "../schema/session.js";
import type { OperationRecord } from "../schema/operation.js";
import { LocalProcessAdapter } from "../adapters/local-process-adapter.js";
import { MontyPythonAdapter } from "../adapters/monty-python-adapter.js";
import { BrowserAdapter } from "../adapters/browser-adapter.js";
import { PROVIDER_SESSION_EXTENSION } from "../adapters/browser-adapter.js";
import type {
  BrowserDriver,
  BrowserDriverCapture,
  BrowserDriverCreate,
  BrowserDriverNavigation,
  BrowserDriverObservation,
  BrowserDriverSession,
} from "../adapters/browser-adapter.js";

// -- The pluggable destination ------------------------------------------------------

/** Options of one demonstration run. */
export interface DemonstrationOptions {
  /** The acceptance fixture root (see `fixtures/acceptance`). */
  fixtureRoot: string;
  /** An empty directory the demonstration owns and fills. */
  workRoot: string;
  /** The destination of step 4; defaults to the honest local stand-in. */
  destination?: DestinationProvider;
}

/** One pluggable destination for the replacement of step 4. */
export interface DestinationProvider {
  /** Honest label the report records. */
  label: string;
  /** Why this destination stands in, when it does. */
  note: string;
  /** The adapter that owns the destination environments. */
  adapter: EnvironmentAdapter;
  /** Reaches one destination environment for work and reads. */
  leaseOf(environmentId: string): Promise<EnvironmentLease>;
  /** Carries candidate resource bindings to the destination lease. */
  bind: BindTransport;
  /**
   * One fresh directory under this provider's working-copy root. The
   * revision materializes at `dir`; `cwd` is the path recipe steps
   * and verification runs name to work inside it.
   */
  freshDir(label: string): { dir: string; cwd: string };
  /** Dispatches this provider has seen; the failure test reads deltas. */
  dispatchCount(): number;
}

/**
 * The destination of the automated run: one honest stand-in.
 *
 * No remote Linux credentials exist in an automated run, so this
 * provider delegates to a second, independent local process provider.
 * It is not the remote Linux of the specification, and the report
 * never claims it is. Substitute the E2B adapter through
 * `DemonstrationOptions.destination` to run the same steps against a
 * real remote machine.
 */
export function remoteLinuxStandin(root: string): DestinationProvider {
  mkdirSync(root, { recursive: true });
  const processes = new LocalProcessAdapter({
    supervisorDir: join(root, "supervisor"),
    workingCopyRoot: root,
    // The stand-in declares its own provider identity: it is a second,
    // independent local provider, and durable records — acquisitions,
    // cleanup obligations — must never confuse it with the first.
    providerId: "remote-linux-standin",
  });
  const adapter = new PortServingAdapter(processes);
  let dispatches = 0;
  return {
    label: "remote-linux-standin",
    note:
      "This run holds no remote Linux credentials, so the destination " +
      "delegates to a second local process provider. Pass the E2B " +
      "adapter (docs/adapters/e2b-linux.md) to run against a real " +
      "remote machine; the steps and their checks do not change.",
    adapter,
    leaseOf: async (environmentId) =>
      countDispatches(adapter.lease(environmentId), () => {
        dispatches += 1;
      }),
    bind: okTransport(),
    freshDir(label) {
      const dir = join(root, label);
      mkdirSync(dir);
      return { dir, cwd: label };
    },
    dispatchCount: () => dispatches,
  };
}

/**
 * One adapter whose environments serve session services beside their
 * processes.
 *
 * The stand-in machine runs real processes that bind real ports, so
 * its offers and manifests honestly declare the service capability
 * too. The delegate stays untouched; the decorator only widens the
 * declaration, the way an operator composes a provider.
 */
class PortServingAdapter implements EnvironmentAdapter {
  constructor(
    private readonly inner: LocalProcessAdapter,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  async describe(): Promise<EnvironmentOffer[]> {
    const offers = await this.inner.describe();
    const service = serviceCapabilityDescriptor();
    return offers.map((offer) => ({
      ...offer,
      capabilities: offer.capabilities.some((entry) => entry.id === service.id)
        ? offer.capabilities
        : [...offer.capabilities, { id: service.id, attributes: service.attributes }],
    }));
  }

  async acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease> {
    return servingLease(await this.inner.acquire(request));
  }

  reconcile(acquisitionId: string): Promise<AcquisitionStatus> {
    return this.inner.reconcile(acquisitionId);
  }

  lease(environmentId: string): EnvironmentLease {
    return servingLease(this.inner.lease(environmentId));
  }
}

/** One lease whose manifest also declares the service capability. */
function servingLease(lease: EnvironmentLease): EnvironmentLease {
  return {
    environmentId: lease.environmentId,
    // The wrapper must keep naming the lease end it inherited: a
    // grant without an expiration cannot be checked against the
    // lifetime ceiling.
    ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
    manifest: async () => {
      const manifest = await lease.manifest();
      return {
        ...manifest,
        capabilities: withServiceCapability(manifest.capabilities),
      };
    },
    invoke: (request) => lease.invoke(request),
    inspect: (operationId) => lease.inspect(operationId),
    cancel: (operationId) => lease.cancel(operationId),
    bind: (resource, context) => lease.bind(resource, context),
    renew: (expiresAt) => lease.renew(expiresAt),
    release: () => lease.release(),
  };
}

/** The capability list with the service capability present once. */
function withServiceCapability(
  capabilities: CapabilityDescriptor[],
): CapabilityDescriptor[] {
  const service = serviceCapabilityDescriptor();
  return capabilities.some((entry) => entry.id === service.id)
    ? capabilities
    : [...capabilities, service];
}

/** Wrap one lease so every invoke is counted. */
function countDispatches(
  lease: EnvironmentLease,
  onInvoke: () => void,
): EnvironmentLease {
  return {
    environmentId: lease.environmentId,
    ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
    manifest: () => lease.manifest(),
    invoke: (request) => {
      onInvoke();
      return lease.invoke(request);
    },
    inspect: (operationId) => lease.inspect(operationId),
    cancel: (operationId) => lease.cancel(operationId),
    bind: (resource, context) => lease.bind(resource, context),
    renew: (expiresAt) => lease.renew(expiresAt),
    release: () => lease.release(),
  };
}

/** One transport that binds every resource it is asked to carry. */
function okTransport(): BindTransport {
  return {
    async bind(resource) {
      return { status: "bound", binding: resource } satisfies BindingResult;
    },
  };
}

// -- The stand-in browser driver ----------------------------------------------------

export { HttpBrowserDriver } from "../adapters/http-browser-driver.js";
export type { StandinPageRecord } from "../adapters/http-browser-driver.js";

// -- The report ---------------------------------------------------------------------

/** Evidence of step 1: the lightweight inspection. */
export interface InspectionEvidence {
  revisionId: string;
  providerId: string;
  attachmentId: string;
  attachmentStatus: string;
  operationId: string;
  value: unknown[];
}

/** Evidence of step 2: local native execution. */
export interface LocalExecutionEvidence {
  attachmentId: string;
  generation: number;
  processResourceId: string;
  recipeSteps: { id: string; operationId: string; exitCode: number }[];
  produced: string[];
  test: { operationId: string; exitCode: number; stdout: string };
}

/** Evidence of step 3: the checkpoint and the independent browser. */
export interface BrowserAttachmentEvidence {
  revisionId: string;
  attachmentId: string;
  generation: number;
  adapterResourceId: string;
  bindingResourceId: string;
  bindingStatus: string;
  providerSessionId: string;
  serviceId: string;
  connectionId: string;
  navigation: { status: number; finalUrl: string; title: string };
  observedSummary: unknown;
  summaryMatchesInspection: boolean;
}

/** Evidence of step 4: the replacement of local compute. */
export interface ReplacementEvidence {
  outcome: string;
  oldGeneration: number;
  newGeneration: number;
  newEnvironmentId: string;
  reconstruction: { recipeId: string; outcome: string }[];
  destinationCopyRoot: string;
  serverPort: number;
  invalidated: { resourceId: string; type: string; status: string }[];
  browserBindingStatus: string;
}

/** Evidence of step 5: the reconnection and the verification artifacts. */
export interface VerificationEvidence {
  reconnectedServiceId: string;
  reconnectedConnectionId: string;
  supersededConnectionId: string | null;
  navigation: { status: number; title: string };
  observedSummary: unknown;
  summaryMatchesInspection: boolean;
  testedRevisionId: string;
  copyModified: boolean;
  changedPaths: { path: string; change: string }[];
  test: { operationId: string; exitCode: number; stdout: string };
  artifact: {
    path: string;
    workspaceRevisionId: string;
    checks: { name: string; passed: boolean }[];
  };
  checker: { exitCode: number; stdout: string };
}

/** Evidence of step 6: the injected failure and the recovery. */
export interface FailureInjectionEvidence {
  outcome: string;
  errorCode: string;
  errorMessage: string;
  failureCondition: string | null;
  transitionPhase: string;
  generationAfterFailure: number;
  computeStatusAfterFailure: string;
  dispatchesForFailingStep: number;
  retry: { refused: boolean; code: string; newDispatches: number };
  /** The explicit abort that returned the source to authority. */
  abort: {
    sourceGeneration: number;
    releasedEnvironmentId: string | null;
    survivingEffects: { kind: string; ref: string }[];
    computeStatus: string;
  };
  recovery: { outcome: string; newGeneration: number; serverPort: number };
  staleHandle: { generation: number; code: string; message: string };
  supersededBindingStatuses: { resourceId: string; status: string }[];
  browserStillValid: { bindingStatus: string; providerState: string };
}

/** Evidence of step 7: the release and the reopen. */
export interface ReleaseReopenEvidence {
  /** One entry per obligation per pass; `pass` names the provider. */
  cleanupOutcomes: { pass: string; cleanupId: string; outcome: string; reason?: string }[];
  releasedAttachmentId: string;
  releaseStatus: string;
  reopen: {
    conversationRestored: boolean;
    headRevisionId: string;
    computeStatus: string;
    browserStatus: string;
    pendingCleanup: number;
  };
  browserLease: {
    bindingStatus: string;
    providerState: string;
    providerSessionId: string;
  };
}

/** Evidence of the workspace-conflict requirement of SPEC.md 22.1. */
export interface ConflictEvidence {
  editPath: string;
  publishedRevisionId: string;
  parentId: string;
  staleWrite: { code: string; expectedHead: string; currentHead: string };
  earlierTestedRevisionId: string;
}

/** Everything one demonstration run retained (SPEC.md section 22.1). */
export interface DemonstrationReport {
  destination: { label: string; note: string };
  inspection: InspectionEvidence;
  localExecution: LocalExecutionEvidence;
  browserAttachment: BrowserAttachmentEvidence;
  replacement: ReplacementEvidence;
  verification: VerificationEvidence;
  failureInjection: FailureInjectionEvidence;
  releaseAndReopen: ReleaseReopenEvidence;
  conflict: ConflictEvidence;
}

// -- Small helpers -------------------------------------------------------------------

/** One captured Portable refusal, or null when the call succeeded. */
async function refuse(
  run: () => unknown | Promise<unknown>,
): Promise<{ code: string; message: string; details?: unknown } | null> {
  try {
    await run();
  } catch (error) {
    const shaped = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof shaped.code === "string") {
      return {
        code: shaped.code,
        message: String(shaped.message ?? ""),
        ...(shaped.details !== undefined ? { details: shaped.details } : {}),
      };
    }
    throw error;
  }
  return null;
}

/** One free TCP port the platform hands out, released right away. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** The policy every step of the demonstration runs under. */
function demonstrationAuthority(): PolicyAuthority {
  return PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: [
      "monty-python",
      "local-process",
      "remote-linux-standin",
      "browser-reference",
    ],
    operations: [
      "exec.python@1",
      "exec.process@1",
      "browser.session@1",
      "service.port@1",
    ],
    transferDestinations: ["local"],
    networkEgress: "unrestricted",
    hostFilesystemAccess: true,
    locations: ["local", "remote"],
    maxEnvironmentLifetimeMs: 86_400_000,
    maxResources: {
      memoryBytes: 4 * 1024 ** 3,
      storageBytes: 4 * 1024 ** 3,
      gpuMemoryBytes: 4 * 1024 ** 3,
    },
    serviceAudiences: ["session"],
  });
}

/** The stability claim behind every bridge checkpoint here. */
function locked(): { kind: "locked"; detail: string } {
  return {
    kind: "locked",
    detail:
      "The demonstration drives one writer at a time; no bridge writer is active during a checkpoint.",
  };
}

/** The decoded stdout of one process run result. */
function stdoutOf(result: unknown): string {
  const shaped = result as { stdout?: { dataBase64?: string } };
  return Buffer.from(shaped.stdout?.dataBase64 ?? "", "base64").toString("utf8");
}

/** The attachment reference of one attached summary. */
function refOf(summary: AttachmentSummary): AttachmentRef {
  return {
    sessionId: summary.sessionId,
    attachmentId: summary.attachmentId,
    generation: summary.generation,
  };
}

/** One recipe document as the fixture declares it. */
interface FixtureRecipe {
  schemaVersion: number;
  recipe: string;
  purpose: string;
  requires?: string[];
  steps: {
    id: string;
    run: string[];
    produces?: string;
    idempotent?: boolean;
    readySignal?: string;
  }[];
}

/** Read one declared recipe from one copy of the fixture. */
async function recipeAt(root: string, name: string): Promise<FixtureRecipe> {
  return JSON.parse(
    await readFile(join(root, "recipes", `${name}.json`), "utf8"),
  ) as FixtureRecipe;
}

/** Start the application server per its recipe and await its signal. */
async function startServer(copyRoot: string, port: number): Promise<ChildProcess> {
  const recipe = await recipeAt(copyRoot, "server");
  const step = recipe.steps[0]!;
  const run = [...step.run];
  const flag = run.indexOf("--port");
  if (flag >= 0 && flag + 1 < run.length) {
    run[flag + 1] = String(port);
  } else {
    run.push("--port", String(port));
  }
  const child = spawn(run[0]!, run.slice(1), { cwd: copyRoot });
  let buffer = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${step.readySignal} line: ${buffer}`)),
        20_000,
      );
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const line = buffer
          .split("\n")
          .find((entry) => entry.startsWith(`${step.readySignal} `));
        if (line !== undefined) {
          clearTimeout(timer);
          const ready = JSON.parse(line.slice(step.readySignal!.length + 1)) as {
            port: number;
          };
          if (ready.port === port) {
            resolve();
          } else {
            reject(new Error(`server bound ${ready.port}, asked for ${port}`));
          }
        }
      });
      child.on("error", reject);
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return child;
}

/** Poll one endpoint until it answers; one reconstructed server proves itself. */
async function awaitHealthy(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Not answering yet; keep waiting.
    }
    if (Date.now() > deadline) {
      throw new Error(`The server at ${url} never answered.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Stop one driver-started server and return once it is gone. */
async function stopServer(child: ChildProcess): Promise<void> {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("exit", resolve));
}

/** A closer that stops one server only while it still runs. */
function stopIfRunning(child: ChildProcess): () => void | Promise<void> {
  return () => {
    if (child.exitCode === null && child.signalCode === null) {
      return stopServer(child);
    }
  };
}

/** The environment one session attachment currently holds. */
async function environmentOf(
  session: ManagedSession,
  attachmentId: string,
): Promise<string> {
  const description = await session.describe();
  const environmentId = description.attachments.find(
    (entry) => entry.attachmentId === attachmentId,
  )?.environmentId;
  if (environmentId === undefined) {
    throw new Error(`Attachment ${attachmentId} reports no environment.`);
  }
  return environmentId;
}

/**
 * The adapter answer a lost claim adopts from the stored record.
 *
 * The result reference of this flow is the JSON encoding of the
 * provider result, so the adopted answer decodes it back. A record a
 * lost claim reads is never `accepted`: the winning claim moved it.
 */
function adoptedAnswer(operationId: string, record: OperationRecord): AdapterOperation {
  return {
    operationId,
    status: record.status === "accepted" ? "running" : record.status,
    ...(record.resultRef !== undefined ? { result: JSON.parse(record.resultRef) } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}

/**
 * Admit, dispatch, and settle one managed operation.
 *
 * The durable record exists before the provider runs; the settle call
 * records the provider's answer under that record.
 */
async function dispatch(
  session: ManagedSession,
  leaseOf: (environmentId: string) => Promise<EnvironmentLease>,
  attachment: AttachmentRef,
  request: {
    capability: string;
    operation: string;
    input: unknown;
    extensions?: Record<string, unknown>;
  },
  authority: PolicyAuthority,
): Promise<AdapterOperation> {
  const admitted = await session.invoke(
    {
      attachment,
      capability: request.capability,
      operation: request.operation,
      input: request.input,
      requestKey: `op-${randomUUID()}`,
    },
    { authority },
  );
  const claim = await session.claimDispatch(admitted.id);
  if (!claim.claimed) {
    return adoptedAnswer(admitted.id, claim.operation);
  }
  const lease = await leaseOf(await environmentOf(session, attachment.attachmentId));
  const answered = await lease.invoke({
    operationId: admitted.id,
    capability: request.capability,
    operation: request.operation,
    input: request.input,
    environmentId: lease.environmentId,
    limits: {},
    ...(request.extensions === undefined ? {} : { extensions: request.extensions }),
  });
  if (answered.status === "completed") {
    await session.settle(admitted.id, {
      kind: "completed",
      resultRef: JSON.stringify(answered.result ?? null),
    });
  } else {
    const error =
      answered.error ??
      portableError("ProviderUnavailable", `The operation answered ${answered.status}.`);
    await session.settle(admitted.id, { kind: "failed", error });
  }
  return answered;
}

/** Run one command as a managed operation; return its durable evidence. */
async function managedRun(
  session: ManagedSession,
  leaseOf: (environmentId: string) => Promise<EnvironmentLease>,
  attachment: AttachmentRef,
  input: { command: string; args: string[]; cwd?: string },
  authority: PolicyAuthority,
): Promise<{ operationId: string; result: unknown }> {
  const answered = await dispatch(
    session,
    leaseOf,
    attachment,
    { capability: "exec.process@1", operation: "run", input },
    authority,
  );
  if (answered.status !== "completed") {
    const error = answered.error as { code?: string; message?: string } | undefined;
    throw new Error(
      `${input.command} failed: ${error?.code ?? answered.status} ${error?.message ?? ""}`,
    );
  }
  return { operationId: answered.operationId, result: answered.result };
}

/** The reconstruction outcomes one transition recorded. */
function reconstructionOf(
  store: ControlStore,
  transitionId: string,
): { recipeId: string; outcome: string }[] {
  const transition = store.getTransition(transitionId);
  const recorded = (transition?.data as { reconstruction?: unknown[] }).reconstruction;
  return (recorded ?? []).map((entry) => entry as { recipeId: string; outcome: string });
}

/** The declared condition one failed recipe matched. */
function reconstructionFailureConditionOf(
  store: ControlStore,
  transitionId: string,
): string | undefined {
  const transition = store.getTransition(transitionId);
  const recorded = (transition?.data as { reconstruction?: unknown[] }).reconstruction;
  return (recorded ?? [])
    .map((entry) => entry as { failureCondition?: string })
    .find((entry) => entry.failureCondition !== undefined)?.failureCondition;
}

// -- The demonstration ----------------------------------------------------------------

/**
 * Run the acceptance demonstration (SPEC.md section 22.1).
 *
 * The seven steps run in order and refuse loudly when any contract
 * above them breaks. Everything the steps retain is in the returned
 * report; the caller asserts the acceptance criteria over it.
 *
 * Whatever opens during the walk closes before the call answers, so
 * a caller's process may exit when the demonstration ends.
 */
export async function runAcceptanceDemonstration(
  options: DemonstrationOptions,
): Promise<DemonstrationReport> {
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
    return await demonstrationOf(options, cleanup);
  } finally {
    for (const close of cleanup) {
      await Promise.resolve(close()).catch(() => undefined);
    }
  }
}

/** The walk itself; `cleanup` collects every closer the run owes. */
async function demonstrationOf(
  options: DemonstrationOptions,
  cleanup: Array<() => void | Promise<void>>,
): Promise<DemonstrationReport> {
  const authority = demonstrationAuthority();
  const principal = "user://acceptance";
  const bridge = join(options.workRoot, "bridge");
  cpSync(options.fixtureRoot, bridge, { recursive: true });

  const store = ControlStore.open(join(options.workRoot, "control.db"));
  const blobs = new BlobStore(join(options.workRoot, "blobs"), store);
  const runtime = new PortableRuntime(store);
  const session = await runtime.createSession({ policyRef: "policy://acceptance" });
  const sessionId = session.id;

  // Step 1: import the fixture and inspect it through the
  // lightweight engine. No machine is allocated for this.
  const imported = await session.checkpoint(
    blobs,
    { requestKey: "import-fixture-1", source: { kind: "bridge", rootPath: bridge } },
    { stability: locked() },
  );
  const revisionOne = imported.revision.id;
  const inspectionRoot = join(options.workRoot, "inspection");
  mkdirSync(inspectionRoot);
  await session.materialize(blobs, revisionOne, inspectionRoot, {
    authority,
    mode: "read-only",
  });
  const monty = new MontyPythonAdapter({ workspaceRoot: inspectionRoot });
  cleanup.push(() => monty.close());
  // The attach flow acquires the attachment's own environment; the
  // provider work below runs through one lease the demonstration
  // holds directly, which is the lease every adapter guarantees its
  // caller. The attachment carries the authority; the lease carries
  // the execution.
  const montyLease = await monty.acquire({
    acquisitionId: `acq-${randomUUID()}`,
    request: { name: "inspection", providerId: monty.id, requires: {} },
    authority: { principal, policyRef: "policy://acceptance" },
    limits: authority.acquisitionLimits(),
  });
  const viaMonty = () => Promise.resolve(montyLease);
  const inspectionAttached = await session.attach({
    adapter: monty,
    request: { name: "inspection", providerId: monty.id, requires: {} },
    requestKey: "attach-inspection-1",
    principal,
    authority,
  });
  const inspectionSource = await readFile(
    join(inspectionRoot, "inspection", "summarize.py"),
    "utf8",
  );
  const inspectionAnswer = await dispatch(
    session,
    viaMonty,
    refOf(inspectionAttached),
    {
      capability: "exec.python@1",
      operation: "evaluate",
      input: {
        source: inspectionSource,
        bindings: [{ name: "data", kind: "workspace", path: "data" }],
      },
    },
    authority,
  );
  const inspectionValue = (inspectionAnswer.result as { value: unknown[] }).value;
  await montyLease.release();
  await session.release(refOf(inspectionAttached), "release-inspection-1", {
    adapter: monty,
    principal,
    authority,
  });

  // Step 2: attach local native execution, reconstruct the
  // dependency, and run the native test.
  const local = new LocalProcessAdapter({
    supervisorDir: join(options.workRoot, "local-supervisor"),
    workingCopyRoot: bridge,
  });
  // The local process adapter needs no closer: its processes run
  // detached and outlive the adapter by design.
  const localLease = (environmentId: string) =>
    Promise.resolve(local.lease(environmentId));
  const compute = await session.attach({
    adapter: local,
    request: { name: "compute", providerId: "local-process", requires: {} },
    requestKey: "attach-compute-1",
    principal,
    authority,
  });
  const computeRefOne = refOf(compute);
  const processBinding = await session.bindResource(
    {
      type: "process.group",
      owner: computeRefOne,
      capability: "exec.process@1",
      lifetime: "attachment",
      recovery: "reconstruct",
    },
    okTransport(),
    { authority },
  );
  const dependenciesRecipe = await recipeAt(bridge, "dependencies");
  const recipeEvidence: { id: string; operationId: string; exitCode: number }[] = [];
  for (const step of dependenciesRecipe.steps) {
    const run = await managedRun(
      session,
      localLease,
      computeRefOne,
      { command: step.run[0]!, args: step.run.slice(1) },
      authority,
    );
    recipeEvidence.push({
      id: step.id,
      operationId: run.operationId,
      exitCode: (run.result as { exitCode?: number }).exitCode ?? -1,
    });
    if (step.produces !== undefined && !existsSync(join(bridge, step.produces))) {
      throw new Error(`Step ${step.id} produced no ${step.produces}.`);
    }
  }
  const nativeTest = await managedRun(
    session,
    localLease,
    computeRefOne,
    { command: "node", args: ["tests/check-data.mjs"] },
    authority,
  );

  // Step 3: checkpoint the resulting workspace and attach the
  // independent browser against the local server.
  const checkpointed = await session.checkpoint(
    blobs,
    {
      requestKey: "checkpoint-compute-1",
      source: { kind: "bridge", rootPath: bridge },
      expectedHead: revisionOne,
    },
    { stability: locked() },
  );
  const revisionTwo = checkpointed.revision.id;
  const localPort = await freePort();
  const remotePort = await freePort();
  const recoveryPort = await freePort();
  const localServer = await startServer(bridge, localPort);
  cleanup.push(stopIfRunning(localServer));

  const driver = new HttpBrowserDriver();
  const collectPages = (): StandinPageRecord[] => driver.pages();
  const browser = new BrowserAdapter({
    driver,
    allowedOrigins: [
      `http://127.0.0.1:${localPort}`,
      `http://127.0.0.1:${remotePort}`,
      `http://127.0.0.1:${recoveryPort}`,
    ],
    blockPrivateRanges: false,
  });
  cleanup.push(() => browser.close());
  // As with the inspection engine: the attachment carries the
  // authority, and one directly held lease carries the execution.
  // The browser session records live under this lease's environment.
  const browserDriverLease = await browser.acquire({
    acquisitionId: `acq-${randomUUID()}`,
    request: { name: "browser-driver", providerId: "browser-reference", requires: {} },
    authority: { principal, policyRef: "policy://acceptance" },
    limits: authority.acquisitionLimits(),
  });
  const viaBrowser = () => Promise.resolve(browserDriverLease);
  const browserAttached = await session.attach({
    adapter: browser,
    request: { name: "browser", providerId: "browser-reference", requires: {} },
    requestKey: "attach-browser-1",
    principal,
    authority,
  });
  const browserRef = refOf(browserAttached);
  const browserEnvironmentId = browserDriverLease.environmentId;
  const created = await dispatch(
    session,
    viaBrowser,
    browserRef,
    {
      capability: "browser.session@1",
      operation: "create",
      input: { name: "acceptance" },
      extensions: {
        "portable.runtime.session-id": sessionId,
        "portable.runtime.attachment-id": browserAttached.attachmentId,
        "portable.runtime.generation": browserAttached.generation,
      },
    },
    authority,
  );
  const createdResource = created.result as {
    resource: { id: string };
    providerSessionId?: string;
  };
  const adapterResourceId = createdResource.resource.id;
  const providerSessionId = createdResource.providerSessionId!;
  const browserBinding = await session.bindResource(
    {
      type: "browser.session",
      owner: browserRef,
      capability: "browser.session@1",
      lifetime: "external",
      recovery: "reattach",
    },
    {
      async bind(resource) {
        return {
          status: "bound",
          binding: {
            ...resource,
            extensions: { [PROVIDER_SESSION_EXTENSION]: providerSessionId },
          },
        } satisfies BindingResult;
      },
    },
    { authority },
  );
  const exposed = exposeService(
    store,
    sessionId,
    {
      processResourceId: processBinding.ref.id,
      port: localPort,
      protocol: "http",
      audience: { kind: "session" },
      expiration: { mode: "duration", durationMs: 600_000 },
    },
    { authority },
  );
  const connected = connectService(
    store,
    sessionId,
    {
      serviceId: exposed.service.ref.id,
      consumer: {
        attachmentId: browserAttached.attachmentId,
        generation: browserAttached.generation,
      },
    },
    { authority },
  );
  const firstPage = await observe(
    session,
    viaBrowser,
    browserRef,
    adapterResourceId,
    `http://127.0.0.1:${localPort}/`,
    collectPages,
    authority,
  );

  // Step 4: replace the local compute with the destination.
  const destination =
    options.destination ?? remoteLinuxStandin(join(options.workRoot, "destination"));
  const firstCopy = destination.freshDir("copy-1");
  const firstReplace = await session.replace(
    replaceRequest({
      source: computeRefOne,
      destinationProviderId: destination.adapter.id,
      workspaceRevisionId: revisionTwo,
      requiredResources: [processBinding.ref.id],
      recipes: [
        recipeOfSteps(
          dependenciesRecipe,
          revisionTwo,
          firstCopy.cwd,
          processBinding.ref.id,
          "first",
        ),
        serverRecipeOf(revisionTwo, firstCopy.cwd, remotePort, [
          exposed.service.ref.id,
        ], "first"),
      ],
      requestKey: `replace-first-${randomUUID()}`,
    }),
    destinationFlow(destination, blobs, principal, authority, firstCopy.dir),
  );
  if (firstReplace.outcome !== "completed") {
    throw new Error(
      `The first replacement did not complete: ${firstReplace.outcome} ` +
        `(${firstReplace.error?.code ?? "no code"}: ` +
        `${firstReplace.error?.message ?? "no message"}).`,
    );
  }
  // The recipe started the server in the background; readiness is
  // the destination's to prove before anything points at it.
  await awaitHealthy(`http://127.0.0.1:${remotePort}/healthz`);
  const computeRefTwo = {
    sessionId,
    attachmentId: compute.attachmentId,
    generation: firstReplace.newGeneration!,
  };

  // What the switch retired, and what survived it.
  const invalidated = [
    store.getResourceBinding(sessionId, processBinding.ref.id)!,
    store.getResourceBinding(sessionId, exposed.service.ref.id)!,
    store.getResourceBinding(sessionId, connected.connection.ref.id)!,
  ];
  const browserBindingAfterSwitch = store.getResourceBinding(
    sessionId,
    browserBinding.ref.id,
  )!;
  await stopServer(localServer);

  // Step 5: reconnect the same browser to the new server and record
  // the verification artifacts with their revision.
  const continuity: BrowserContinuityTransport = {
    async observeSession(resourceId) {
      const binding = store.getResourceBinding(sessionId, resourceId);
      const providerId = binding?.extensions?.[PROVIDER_SESSION_EXTENSION];
      if (typeof providerId !== "string") {
        return { state: "unknown" };
      }
      const record = browser
        .sessionRecordsOf(browserEnvironmentId)
        .find((entry) => entry.providerSessionId === providerId);
      if (record === undefined) {
        return { state: "unknown" };
      }
      return { state: await browser.sessionStateOf(record.resourceId) };
    },
  };
  const adopted = store
    .listResourceBindings(sessionId)
    .find(
      (binding) =>
        binding.type === "process.group" &&
        binding.status === "bound" &&
        binding.owner.attachmentId === compute.attachmentId,
    )!;
  // The switch carried the exposed service to the new generation as
  // an adopted binding; it still describes the same application.
  const adoptedService = store
    .listResourceBindings(sessionId)
    .find(
      (binding) =>
        binding.type === "service.port" &&
        binding.status === "bound" &&
        binding.owner.attachmentId === compute.attachmentId,
    )!;
  const reconnected = await reconnectBrowserService(
    store,
    sessionId,
    {
      browserResourceId: browserBinding.ref.id,
      processResourceId: adopted.id,
      port: remotePort,
      protocol: "http",
      audience: { kind: "session" },
      expiration: { mode: "duration", durationMs: 600_000 },
      supersededServiceId: exposed.service.ref.id,
    },
    { authority, transport: continuity },
  );
  const secondPage = await observe(
    session,
    viaBrowser,
    browserRef,
    adapterResourceId,
    `http://127.0.0.1:${remotePort}/`,
    collectPages,
    authority,
  );

  // The verification run: the native test, prepared and settled
  // through the provenance contract, on the destination copy.
  const verification = destination.freshDir("verify-1");
  const destinationCopy = store.getWorkingCopyByPath(sessionId, firstCopy.dir)!;
  const verifyInput = {
    command: "node",
    args: ["tests/check-data.mjs"],
    cwd: verification.cwd,
  };
  const verifyAdmitted = await session.invoke(
    {
      attachment: computeRefTwo,
      capability: "exec.process@1",
      operation: "run",
      input: verifyInput,
      requestKey: `verify-${randomUUID()}`,
    },
    { authority },
  );
  const prepared = await session.prepareVerificationRun(
    blobs,
    {
      operationId: verifyAdmitted.id,
      attachment: computeRefTwo,
      capability: "exec.process@1",
      operation: "run",
      arguments: verifyInput,
      workingCopyId: destinationCopy.id,
    },
    { authority, destination: verification.dir },
  );
  const verifyClaim = await session.claimDispatch(verifyAdmitted.id);
  const verifyLease = await destination.leaseOf(
    await environmentOf(session, compute.attachmentId),
  );
  const verifyRun = verifyClaim.claimed
    ? await verifyLease.invoke({
        operationId: verifyAdmitted.id,
        capability: "exec.process@1",
        operation: "run",
        input: verifyInput,
        environmentId: verifyLease.environmentId,
        limits: {},
      })
    : adoptedAnswer(verifyAdmitted.id, verifyClaim.operation);
  await session.settle(verifyAdmitted.id, {
    kind: "completed",
    resultRef: JSON.stringify(verifyRun.result ?? null),
  });
  const settled = await session.settleVerificationRun(blobs, {
    operationId: verifyAdmitted.id,
    attachment: computeRefTwo,
  });

  // The artifact names the tested revision, and the checker enforces
  // it on the destination itself.
  const artifactRelative = "verification/acceptance-report.json";
  const artifactPath = join(firstCopy.dir, artifactRelative);
  mkdirSync(dirname(artifactPath), { recursive: true });
  const artifact = {
    schemaVersion: 1,
    kind: "verification",
    workspaceRevisionId: settled.testedRevisionId!,
    recordedAt: new Date().toISOString(),
    producedBy: {
      attachmentId: compute.attachmentId,
      environmentId: verifyLease.environmentId,
    },
    checks: [
      { name: "dashboard-visible", passed: secondPage.status === 200 },
      {
        name: "summary-matches-inspection",
        passed: sameJson(
          tupleOfSummary(secondPage.dataEndpoints["/api/summary"]),
          inspectionValue,
        ),
      },
    ],
  };
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const checker = await managedRun(
    session,
    destination.leaseOf,
    computeRefTwo,
    {
      command: "node",
      args: ["scripts/check-artifact.mjs", artifactRelative],
      cwd: firstCopy.cwd,
    },
    authority,
  );

  // Step 6: inject a replacement failure, then recover.
  const secondCopy = destination.freshDir("copy-2");
  const failing = replaceRequest({
    source: computeRefTwo,
    destinationProviderId: destination.adapter.id,
    workspaceRevisionId: revisionTwo,
    requiredResources: [adopted.id],
    recipes: [
      {
        id: "recipe-broken",
        inputRevisionId: revisionTwo,
        requiredCapabilities: ["exec.process@1"],
        steps: [
          {
            capability: "exec.process@1",
            operation: "run",
            input: { command: "porta-no-such-binary", args: [], cwd: secondCopy.cwd },
          },
        ],
        outputs: [
          `process.group ${adopted.id}`,
          `service.port ${adoptedService.id}`,
          `service.port ${reconnected.service.service.ref.id}`,
        ],
        failureConditions: ["failed to start"],
      },
    ],
    requestKey: `replace-failing-${randomUUID()}`,
  });
  const dispatchesBeforeFailure = destination.dispatchCount();
  const failed = await session.replace(
    failing,
    destinationFlow(destination, blobs, principal, authority, secondCopy.dir),
  );
  const dispatchesForFailingStep =
    destination.dispatchCount() - dispatchesBeforeFailure;
  const failedTransition = store.getTransition(failed.transitionId)!;
  const failureCause = (failedTransition.data as {
    error?: { code?: string; message?: string };
  }).error;
  const computeAfterFailure = (await session.describe()).attachments.find(
    (entry) => entry.attachmentId === compute.attachmentId,
  )!;

  // A retry of the same request re-runs nothing: the durable record
  // stands, and only a new request moves state again.
  const dispatchesBeforeRetry = destination.dispatchCount();
  const retryRefusal = await refuse(() =>
    session.replace(
      failing,
      destinationFlow(destination, blobs, principal, authority, secondCopy.dir),
    ),
  );
  const retryDispatches = destination.dispatchCount() - dispatchesBeforeRetry;
  if (retryRefusal === null) {
    throw new Error("The retry of the failed replacement unexpectedly succeeded.");
  }

  // The retry stood still. Recovery starts from an explicit abort
  // that returns the source to authority at its unchanged
  // generation, never from a silent second attempt.
  const aborted = abortReplacement(store, failed.transitionId);
  const computeAfterAbort = (await session.describe()).attachments.find(
    (entry) => entry.attachmentId === compute.attachmentId,
  )!;
  if (
    computeAfterAbort.status !== "active" ||
    computeAfterAbort.generation !== computeRefTwo.generation
  ) {
    throw new Error(
      `The abort left compute ${computeAfterAbort.status} at generation ${computeAfterAbort.generation}.`,
    );
  }

  // Recovery: one new explicit request, the same destination kind.
  const thirdCopy = destination.freshDir("copy-3");
  const recovery = await session.replace(
    replaceRequest({
      source: computeRefTwo,
      destinationProviderId: destination.adapter.id,
      workspaceRevisionId: revisionTwo,
      requiredResources: [adopted.id],
      recipes: [
        recipeOfSteps(
          dependenciesRecipe,
          revisionTwo,
          thirdCopy.cwd,
          adopted.id,
          "recovery",
        ),
        serverRecipeOf(
          revisionTwo,
          thirdCopy.cwd,
          recoveryPort,
          [adoptedService.id, reconnected.service.service.ref.id],
          "recovery",
        ),
      ],
      requestKey: `replace-recovery-${randomUUID()}`,
    }),
    destinationFlow(destination, blobs, principal, authority, thirdCopy.dir),
  );
  if (recovery.outcome !== "completed") {
    throw new Error(
      `The recovery replacement did not complete: ${recovery.outcome} ` +
        `(${recovery.error?.code ?? "no code"}: ` +
        `${recovery.error?.message ?? "no message"}).`,
    );
  }
  const generationThree = recovery.newGeneration!;
  await awaitHealthy(`http://127.0.0.1:${recoveryPort}/healthz`);

  // Old compute handles fail: an operation through the replaced
  // generation refuses before anything is admitted.
  const staleHandle = await refuse(() =>
    session.invoke(
      {
        attachment: computeRefTwo,
        capability: "exec.process@1",
        operation: "run",
        input: { command: "true", args: [] },
        requestKey: `stale-${randomUUID()}`,
      },
      { authority },
    ),
  );
  if (staleHandle === null) {
    throw new Error("An operation through the replaced generation was admitted.");
  }
  const supersededBindingStatuses = [
    store.getResourceBinding(sessionId, adopted.id)!,
    store.getResourceBinding(sessionId, reconnected.service.service.ref.id)!,
    store.getResourceBinding(sessionId, reconnected.connection.connection.ref.id)!,
  ].map((binding) => ({ resourceId: binding.id, status: binding.status }));
  const browserAfterFailure = store.getResourceBinding(
    sessionId,
    browserBinding.ref.id,
  )!;
  const browserProviderState = await continuity.observeSession(browserBinding.ref.id);

  // Step 7: release compute, reopen the session, verify the retained
  // state and the browser's actual lease status.
  // The store closes below; everything the report quotes from it is
  // read first.
  const firstReconstruction = reconstructionOf(store, firstReplace.transitionId);
  const failureCondition =
    reconstructionFailureConditionOf(store, failed.transitionId) ?? null;
  const localCleanup = await session.runCleanup({
    adapter: local,
    principal,
    authority,
  });
  const destinationCleanup = await session.runCleanup({
    adapter: destination.adapter,
    principal,
    authority,
  });
  // One pass settles only the obligations its provider owns; the
  // other provider's stay pending for their own pass (SPEC.md 8).
  const cleanupOutcomes = [
    ...localCleanup.outcomes.map((outcome) => ({ pass: local.id, ...outcome })),
    ...destinationCleanup.outcomes.map((outcome) => ({
      pass: destination.adapter.id,
      ...outcome,
    })),
  ];
  const released = await session.release(
    { sessionId, attachmentId: compute.attachmentId, generation: generationThree },
    `release-compute-${randomUUID()}`,
    { adapter: destination.adapter, principal, authority },
  );
  store.close();

  const reopenedStore = ControlStore.open(join(options.workRoot, "control.db"));
  // The blob root survives the close; the store handle does not, so
  // the reopened checkpoints write through a store-bound handle.
  const reopenedBlobs = new BlobStore(join(options.workRoot, "blobs"), reopenedStore);
  const reopenedSession = await new PortableRuntime(reopenedStore).openSession(sessionId);
  cleanup.push(() => {
    reopenedStore.close();
  });
  const reopenReport = await reopenedSession.reopen();
  const description = await reopenedSession.describe();
  const computeAfterReopen = description.attachments.find(
    (entry) => entry.attachmentId === compute.attachmentId,
  )!;
  const browserAfterReopen = description.attachments.find(
    (entry) => entry.attachmentId === browserAttached.attachmentId,
  )!;

  // The workspace-conflict requirement: a local edit after the tested
  // revision publishes a new revision, and a write that still expects
  // the tested revision conflicts, naming it.
  const editRelative = "notes/local-edit.txt";
  const editPath = join(bridge, editRelative);
  mkdirSync(dirname(editPath), { recursive: true });
  writeFileSync(editPath, "an edit after the tested revision\n");
  const published = await reopenedSession.checkpoint(
    reopenedBlobs,
    {
      requestKey: "checkpoint-edit-1",
      source: { kind: "bridge", rootPath: bridge },
      expectedHead: revisionTwo,
    },
    { stability: locked() },
  );
  const staleWrite = await refuse(() =>
    reopenedSession.checkpoint(
      reopenedBlobs,
      {
        requestKey: "checkpoint-stale-1",
        source: { kind: "bridge", rootPath: bridge },
        expectedHead: revisionTwo,
      },
      { stability: locked() },
    ),
  );
  if (staleWrite === null) {
    throw new Error("The stale checkpoint unexpectedly succeeded.");
  }
  const staleDetails = staleWrite.details as {
    expectedHead: string;
    currentHead: string;
  };

  return {
    destination: { label: destination.label, note: destination.note },
    inspection: {
      revisionId: revisionOne,
      providerId: monty.id,
      attachmentId: inspectionAttached.attachmentId,
      attachmentStatus: "released",
      operationId: inspectionAnswer.operationId,
      value: inspectionValue,
    },
    localExecution: {
      attachmentId: compute.attachmentId,
      generation: 1,
      processResourceId: processBinding.ref.id,
      recipeSteps: recipeEvidence,
      produced: producesOf(dependenciesRecipe),
      test: {
        operationId: nativeTest.operationId,
        exitCode: (nativeTest.result as { exitCode?: number }).exitCode ?? -1,
        stdout: stdoutOf(nativeTest.result),
      },
    },
    browserAttachment: {
      revisionId: revisionTwo,
      attachmentId: browserAttached.attachmentId,
      generation: browserAttached.generation,
      adapterResourceId,
      bindingResourceId: browserBinding.ref.id,
      bindingStatus: browserBinding.validity,
      providerSessionId,
      serviceId: exposed.service.ref.id,
      connectionId: connected.connection.ref.id,
      navigation: {
        status: firstPage.status,
        finalUrl: firstPage.finalUrl,
        title: firstPage.observedTitle,
      },
      observedSummary: firstPage.dataEndpoints["/api/summary"],
      summaryMatchesInspection: sameJson(
        tupleOfSummary(firstPage.dataEndpoints["/api/summary"]),
        inspectionValue,
      ),
    },
    replacement: {
      outcome: firstReplace.outcome,
      oldGeneration: firstReplace.oldGeneration!,
      newGeneration: firstReplace.newGeneration!,
      newEnvironmentId: firstReplace.newEnvironmentId!,
      reconstruction: firstReconstruction,
      destinationCopyRoot: firstCopy.dir,
      serverPort: remotePort,
      invalidated: invalidated.map((binding) => ({
        resourceId: binding.id,
        type: binding.type,
        status: binding.status,
      })),
      browserBindingStatus: browserBindingAfterSwitch.status,
    },
    verification: {
      reconnectedServiceId: reconnected.service.service.ref.id,
      reconnectedConnectionId: reconnected.connection.connection.ref.id,
      supersededConnectionId: reconnected.supersededConnection?.ref.id ?? null,
      navigation: { status: secondPage.status, title: secondPage.observedTitle },
      observedSummary: secondPage.dataEndpoints["/api/summary"],
      summaryMatchesInspection: sameJson(
        tupleOfSummary(secondPage.dataEndpoints["/api/summary"]),
        inspectionValue,
      ),
      testedRevisionId: settled.testedRevisionId!,
      copyModified: prepared.provenance.copyModified ?? false,
      changedPaths: settled.changedPaths ?? [],
      test: {
        operationId: verifyAdmitted.id,
        exitCode: (verifyRun.result as { exitCode?: number }).exitCode ?? -1,
        stdout: stdoutOf(verifyRun.result),
      },
      artifact: {
        path: artifactRelative,
        workspaceRevisionId: artifact.workspaceRevisionId,
        checks: artifact.checks,
      },
      checker: {
        exitCode: (checker.result as { exitCode?: number }).exitCode ?? -1,
        stdout: stdoutOf(checker.result),
      },
    },
    failureInjection: {
      outcome: failed.outcome,
      // The report carries the refusal; the transition carries the
      // injected cause, and the evidence names both.
      errorCode: failureCause?.code ?? failed.error?.code ?? "",
      errorMessage: failureCause?.message ?? failed.error?.message ?? "",
      failureCondition,
      transitionPhase: failedTransition.phase,
      generationAfterFailure: computeAfterFailure.generation,
      computeStatusAfterFailure: computeAfterFailure.status,
      dispatchesForFailingStep,
      retry: {
        refused: true,
        code: retryRefusal.code,
        newDispatches: retryDispatches,
      },
      abort: {
        sourceGeneration: aborted.sourceGeneration,
        releasedEnvironmentId: aborted.releasedEnvironmentId ?? null,
        survivingEffects: aborted.survivingEffects.map((effect) => ({
          kind: effect.kind,
          ref: effect.ref,
        })),
        computeStatus: computeAfterAbort.status,
      },
      recovery: {
        outcome: recovery.outcome,
        newGeneration: generationThree,
        serverPort: recoveryPort,
      },
      staleHandle: {
        generation: computeRefTwo.generation,
        code: staleHandle.code,
        message: staleHandle.message,
      },
      supersededBindingStatuses,
      browserStillValid: {
        bindingStatus: browserAfterFailure.status,
        providerState: browserProviderState.state,
      },
    },
    releaseAndReopen: {
      cleanupOutcomes: cleanupOutcomes.map((outcome) => ({
        pass: outcome.pass,
        cleanupId: outcome.cleanupId,
        outcome: outcome.outcome,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      })),
      releasedAttachmentId: released.attachment.attachmentId,
      releaseStatus: released.status,
      reopen: {
        conversationRestored: reopenReport.conversationRestored,
        headRevisionId: description.workspace.headRevisionId!,
        computeStatus: computeAfterReopen.status,
        browserStatus: browserAfterReopen.status,
        pendingCleanup: description.pendingCleanup.length,
      },
      browserLease: {
        bindingStatus: reopenedStore.getResourceBinding(
          sessionId,
          browserBinding.ref.id,
        )!.status,
        providerState: await browser.sessionStateOf(adapterResourceId),
        providerSessionId,
      },
    },
    conflict: {
      editPath: editRelative,
      publishedRevisionId: published.revision.id,
      parentId: published.revision.parentId!,
      staleWrite: {
        code: staleWrite.code,
        expectedHead: staleDetails.expectedHead,
        currentHead: staleDetails.currentHead,
      },
      earlierTestedRevisionId: settled.testedRevisionId!,
    },
  };
}

// -- Demonstration-local helpers ------------------------------------------------------

/** Whether two JSON values serialize the same. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The inspection tuple of one served summary. The dashboard endpoint
 * answers an object; the lightweight engine answers the same four
 * values as a tuple. Both shapes describe one dataset.
 */
function tupleOfSummary(summary: unknown): unknown[] {
  const shaped = summary as {
    count?: unknown;
    lowest?: unknown;
    highest?: unknown;
    anomalies?: unknown;
  };
  return [shaped.count, shaped.lowest, shaped.highest, shaped.anomalies];
}

/** The paths a recipe's steps say they produce. */
function producesOf(recipe: FixtureRecipe): string[] {
  return recipe.steps
    .map((step) => step.produces)
    .filter((produced): produced is string => produced !== undefined);
}

/** One navigation observed through the driver's own page record. */
async function observe(
  session: ManagedSession,
  leaseOf: (environmentId: string) => Promise<EnvironmentLease>,
  attachment: AttachmentRef,
  resourceId: string,
  url: string,
  pages: () => StandinPageRecord[],
  authority: PolicyAuthority,
): Promise<StandinPageRecord & { observedTitle: string }> {
  const before = pages().length;
  const navigated = await dispatch(
    session,
    leaseOf,
    attachment,
    {
      capability: "browser.session@1",
      operation: "navigate",
      input: { resourceId, url, waitUntil: "load" },
    },
    authority,
  );
  const inspected = await dispatch(
    session,
    leaseOf,
    attachment,
    {
      capability: "browser.session@1",
      operation: "inspect",
      input: { resourceId },
    },
    authority,
  );
  const navigation = navigated.result as { status?: number };
  const observation = inspected.result as { title?: string };
  const page = pages()[before];
  if (page === undefined) {
    throw new Error(`The stand-in driver recorded no page for ${url}.`);
  }
  return {
    ...page,
    status: navigation.status ?? page.status,
    observedTitle: observation.title ?? "",
  };
}

/**
 * Map one fixture recipe onto reconstruction steps for a copy.
 *
 * The recipe's outputs name the dispositions it reconstructs, so the
 * process state the plan carries must appear here by subject.
 */
function recipeOfSteps(
  recipe: FixtureRecipe,
  inputRevisionId: string,
  cwd: string,
  processResourceId: string,
  tag: string,
): ReplaceRequest["reconstruct"][number] {
  return {
    // Step identities are deterministic per recipe id, so each
    // replacement's recipes carry the transition's tag: the same
    // logical recipe on a new copy is a new operation, never a
    // request-key collision with the one that already ran.
    id: `recipe-${recipe.recipe}-${tag}`,
    inputRevisionId,
    requiredCapabilities: ["exec.process@1"],
    steps: recipe.steps.map((step) => ({
      capability: "exec.process@1",
      operation: "run",
      input: { command: step.run[0]!, args: step.run.slice(1), cwd },
    })),
    outputs: [`process.group ${processResourceId}`],
    // The fixture's steps are plain processes; the honest declared
    // failure is one that never started, which redo cannot duplicate.
    failureConditions: ["failed to start"],
  };
}

/**
 * Map the fixture's server recipe onto one background launch.
 *
 * The application server is reconstructable state: it crosses a
 * replacement by starting again on the destination, never by revival.
 * The step launches in the background and answers at once; the
 * ready line the recipe declares is the driver's to await.
 */
function serverRecipeOf(
  inputRevisionId: string,
  cwd: string,
  port: number,
  serviceResourceIds: string[],
  tag: string,
): ReplaceRequest["reconstruct"][number] {
  return {
    id: `recipe-server-${tag}`,
    inputRevisionId,
    requiredCapabilities: ["exec.process@1"],
    steps: [
      {
        capability: "exec.process@1",
        operation: "start",
        input: {
          command: "node",
          args: ["app/server.mjs", "--port", String(port)],
          cwd,
        },
      },
    ],
    outputs: serviceResourceIds.map((resourceId) => `service.port ${resourceId}`),
    failureConditions: ["failed to start"],
  };
}

/** Build one replacement request over its declared recipes. */
function replaceRequest(parts: {
  source: AttachmentRef;
  /** The destination provider the durable request must name. */
  destinationProviderId: string;
  workspaceRevisionId: string;
  requiredResources: string[];
  recipes: ReplaceRequest["reconstruct"];
  requestKey: string;
}): ReplaceRequest {
  return {
    source: parts.source,
    // The name carries into the candidate's stored acquisition, so a
    // cleanup pass can tell whose provider confirms its release.
    destination: { providerId: parts.destinationProviderId, requires: {} },
    workspaceRevisionId: parts.workspaceRevisionId,
    requiredResources: parts.requiredResources,
    reconstruct: parts.recipes,
    activeOperations: "reject",
    requestKey: parts.requestKey,
  };
}

/** The destination flow options of one replacement. */
function destinationFlow(
  destination: DestinationProvider,
  blobs: BlobStore,
  principal: string,
  authority: PolicyAuthority,
  copyRoot: string,
): ReplaceFlowOptions {
  return {
    destination: {
      adapter: destination.adapter,
      leaseOf: destination.leaseOf,
      bind: destination.bind,
      blobs,
      copyRoot,
      principal,
      authority,
    },
  };
}
