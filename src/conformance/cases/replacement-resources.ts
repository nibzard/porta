import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyAuthority } from "../../core/policy.js";
import type { PolicyAuthority as Authority } from "../../core/policy.js";
import { operationUnknownError, providerUnavailableError } from "../../core/errors.js";
import type { PortableError } from "../../schema/error.js";
import type { EnforcementFacts } from "../../schema/capability.js";
import { ControlStore } from "../../store/control-store.js";
import { BlobStore } from "../../store/blob-store.js";
import { checkpointWorkspace } from "../../runtime/workspace.js";
import {
  bindResource,
  reattachResource,
  resolveResource,
} from "../../runtime/resources.js";
import type { BindTransport } from "../../runtime/resources.js";
import { attachEnvironment } from "../../runtime/acquisition.js";
import { admitInvocation } from "../../runtime/admission.js";
import {
  claimOperationDispatch,
  reconcileOperation,
  settleOperation,
} from "../../runtime/outcomes.js";
import { runCleanup } from "../../runtime/lifecycle.js";
import {
  abortReplacement,
  checkpointReplacement,
  prepareDestination,
  prepareReplacement,
  switchReplacement,
} from "../../runtime/replacement.js";
import type { DestinationReport, SwitchReport } from "../../runtime/replacement.js";
import type { ReplaceRequest } from "../../schema/handoff.js";
import {
  checkConnectionStanding,
  connectService,
  exposeService,
} from "../../runtime/service-connections.js";
import { reconnectBrowserService } from "../../runtime/browser-continuity.js";
import type {
  BrowserContinuityTransport,
  ReconnectBrowserInput,
} from "../../runtime/browser-continuity.js";
import {
  processCapabilityDescriptor,
} from "../../runtime/process-capability.js";
import { serviceCapabilityDescriptor } from "../../runtime/service-capability.js";
import type {
  AcquisitionStatus,
  AdapterInvocation,
  AuthorizedAcquireRequest,
  EnvironmentAdapter,
  EnvironmentLease,
} from "../../schema/adapter.js";
import type {
  EnvironmentManifest,
  EnvironmentOffer,
} from "../../schema/capability.js";
import type { AttachmentSummary } from "../../schema/session.js";
import type { ConformanceCase, ConformanceCaseAnswer } from "../runner.js";

/**
 * Replacement failure and resource conformance cases (SPEC.md section
 * 21).
 *
 * The replacement area injects failure into every phase of one
 * replacement and proves the source keeps authority throughout: a
 * blocked plan refuses before quiesce, a held mutation lease blocks
 * the checkpoint, a failing provider or recipe fails the destination
 * without touching the source, an unknown operation blocks preparation
 * under every policy, a released fence refuses both the switch and the
 * abort, a controller that restarts before or after the switch commits
 * exactly once, and a failed source cleanup stays visible until the
 * provider confirms the release.
 *
 * The resources area proves handle authority across a switch: stale
 * generations, an independently attached browser that survives compute
 * replacement, a provider-reported browser expiry, and service
 * connections that die with the compute generation they depended on.
 *
 * No case drives the loaded adapter. Failure injection needs a
 * provider whose failures the case scripts, so every case owns a
 * deterministic in-memory adapter and store. Nothing here allocates,
 * charges, or touches anything outside private temporary directories.
 */

/** Typed enforcement facts of the scripted provider: a plain local host. */
const SCRIPTED_FACTS: EnforcementFacts = {
  executionLocation: "local",
  networkEgress: "none",
  hostFilesystemAccess: false,
};

/** The authority every flow in this pack runs under. */
const AUTHORITY: Authority = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  providers: ["porta-conf-scripted"],
  operations: ["exec.process@1", "service.port@1", "browser.session@1"],
  locations: ["local", "remote"],
  transferDestinations: ["local"],
  networkEgress: "unrestricted",
  hostFilesystemAccess: true,
  maxEnvironmentLifetimeMs: 86_400_000,
  maxResources: {
    memoryBytes: 4 * 1024 ** 3,
    storageBytes: 4 * 1024 ** 3,
    gpuMemoryBytes: 4 * 1024 ** 3,
  },
  serviceAudiences: ["session"],
});

/** A transport that always reports the reference bound unchanged. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource };
  },
};

/** Failures a case may script into the in-pack adapter. */
interface ScriptedFailures {
  /** Thrown from acquire; the destination cannot provision. */
  acquire?: PortableError;
  /** Returned from invoke; a recipe step fails. */
  invoke?: PortableError;
  /** Release answers failed and retryable. */
  releaseFailed?: boolean;
}

/** One lease of the scripted provider. */
class ScriptedLease implements EnvironmentLease {
  /** When this lease ends: fifteen minutes after it was granted. */
  private readonly grantedTo = new Date(Date.now() + 15 * 60_000).toISOString();

  constructor(
    private readonly provider: ScriptedAdapter,
    readonly environmentId: string,
  ) {}

  /** The lease end this provider reports. */
  get expiresAt(): string {
    return this.grantedTo;
  }

  manifest(): Promise<EnvironmentManifest> {
    return Promise.resolve(this.provider.manifestOf(this.environmentId));
  }

  invoke(request: AdapterInvocation) {
    const failure = this.provider.failures.invoke;
    if (failure !== undefined) {
      return Promise.resolve({
        operationId: request.operationId,
        status: "failed" as const,
        error: failure,
      });
    }
    return Promise.resolve({
      operationId: request.operationId,
      status: "completed" as const,
      result: { ran: true },
    });
  }

  inspect(operationId: string) {
    return Promise.resolve({ operationId, status: "completed" as const });
  }

  cancel() {
    return Promise.resolve({ outcome: "confirmed" as const, stopped: true });
  }

  bind() {
    return Promise.resolve({ status: "unsupported" as const });
  }

  renew(expiresAt: string) {
    return Promise.resolve({
      status: "active" as const,
      expiresAt,
      renewalSupported: true,
    });
  }

  release() {
    if (this.provider.failures.releaseFailed === true) {
      return Promise.resolve({
        status: "failed" as const,
        retryable: true,
        detail: "The scripted provider refused the release.",
      });
    }
    return Promise.resolve({ status: "released" as const, retryable: false });
  }
}

/** The deterministic provider every case scripts its failures into. */
class ScriptedAdapter implements EnvironmentAdapter {
  readonly id = "porta-conf-scripted";
  readonly failures: ScriptedFailures = {};
  private counter = 0;

  describe(): Promise<EnvironmentOffer[]> {
    return Promise.resolve([
      {
        providerId: this.id,
        platform: { os: "linux", arch: "x64" },
        capabilities: [
          { id: "exec.process@1", attributes: processCapabilityDescriptor().attributes },
          { id: "service.port@1", attributes: serviceCapabilityDescriptor().attributes },
        ],
        enforcementFacts: { ...SCRIPTED_FACTS },
      },
    ]);
  }

  acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease> {
    if (this.failures.acquire !== undefined) {
      return Promise.reject(this.failures.acquire);
    }
    this.counter += 1;
    return Promise.resolve(new ScriptedLease(this, `env-scripted-${this.counter}`));
  }

  reconcile(acquisitionId: string): Promise<AcquisitionStatus> {
    return Promise.resolve({ acquisitionId, state: "unknown" });
  }

  /** The lease a destination flow reaches an environment through. */
  lease(environmentId: string): EnvironmentLease {
    return new ScriptedLease(this, environmentId);
  }

  manifestOf(environmentId: string): EnvironmentManifest {
    return {
      environmentId,
      providerId: this.id,
      platform: { os: "linux", arch: "x64" },
      capabilities: [processCapabilityDescriptor(), serviceCapabilityDescriptor()],
      enforcement: {},
      enforcementFacts: { ...SCRIPTED_FACTS },
      adapterVersion: "1.0.0-conformance",
    };
  }
}

/** One scratch bench: an in-memory session, blobs, and one attachment. */
interface Bench {
  store: ControlStore;
  blobs: BlobStore;
  sessionId: string;
  attachmentId: string;
  revisionId: string;
  /** A fresh empty directory under the bench's own root. */
  directory(): string;
  done(): void;
}

/** Seed one session with a revision and an active "worker" attachment. */
function bench(capabilityIds: string[]): Bench {
  const root = mkdtempSync(join(tmpdir(), "porta-conf-repl-"));
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(join(root, "blobs"), store);
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
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "app.txt"), "base");
  const checkpoint = checkpointWorkspace(
    store,
    sessionId,
    blobs,
    {
      requestKey: `import-${randomUUID()}`,
      source: { kind: "bridge", rootPath: src },
    },
    { stability: { kind: "locked" } },
  );
  const attachment: AttachmentSummary = {
    sessionId,
    attachmentId: `att-${randomUUID()}`,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds,
  };
  store.insertAttachment(attachment);
  let counter = 0;
  return {
    store,
    blobs,
    sessionId,
    attachmentId: attachment.attachmentId,
    revisionId: checkpoint.revision.id,
    directory() {
      counter += 1;
      const dir = join(root, `dir-${counter}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The replacement request over one bench, overridable field by field. */
function requestOf(state: Bench, overrides: Partial<ReplaceRequest> = {}): ReplaceRequest {
  return {
    source: {
      sessionId: state.sessionId,
      attachmentId: state.attachmentId,
      generation: 1,
    },
    destination: { requires: {} },
    workspaceRevisionId: state.revisionId,
    requiredResources: [],
    reconstruct: [],
    activeOperations: "reject",
    requestKey: `replace-${randomUUID()}`,
    ...overrides,
  };
}

/** Options of one destination preparation over a scripted adapter. */
function destinationOptions(state: Bench, adapter: ScriptedAdapter, copyRoot: string) {
  return {
    adapter,
    leaseOf: (environmentId: string) => Promise.resolve(adapter.lease(environmentId)),
    bind: okTransport,
    blobs: state.blobs,
    copyRoot,
    principal: "conformance",
    authority: AUTHORITY,
  };
}

/** A replacement request whose recipe covers the declared outputs. */
function coveringRequest(
  state: Bench,
  outputs: string[],
  overrides: Partial<ReplaceRequest> = {},
): ReplaceRequest {
  return requestOf(state, {
    reconstruct: [
      {
        id: "recipe-worker",
        inputRevisionId: state.revisionId,
        requiredCapabilities: ["exec.process@1"],
        steps: [
          { capability: "exec.process@1", operation: "run", input: { command: "npm", args: ["ci"] } },
        ],
        outputs,
        failureConditions: ["ProviderUnavailable"],
      },
    ],
    ...overrides,
  });
}

/** Run one full replacement to its switch and return the report. */
async function switchCompute(
  state: Bench,
  request: ReplaceRequest,
  adapter: ScriptedAdapter,
): Promise<SwitchReport> {
  const prepared = await prepareReplacement(state.store, request);
  checkpointReplacement(state.store, prepared.transitionId);
  const destination = await prepareDestination(
    state.store,
    prepared.transitionId,
    destinationOptions(state, adapter, state.directory()),
  );
  if (destination.state !== "validated") {
    throw new Error(
      `The scripted replacement never validated: ${JSON.stringify(destination.error)}`,
    );
  }
  return switchReplacement(state.store, prepared.transitionId);
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

// -- The service-side bench of the resources area ------------------------------

/** One compute with a process, plus an independently attached browser. */
interface ServiceBench {
  store: ControlStore;
  blobs: BlobStore;
  sessionId: string;
  computeId: string;
  browserId: string;
  processId: string;
  browserResourceId: string;
  revisionId: string;
  /** A fresh empty directory under the bench's own root. */
  directory(): string;
  /** A transport that reports whatever the case last scripted. */
  observe: { state: "active" | "expired" | "closed" | "unknown" };
  done(): void;
}

/** The provider-session identity the browser binding carries. */
const PROVIDER_SESSION = "portable.browser.provider-session-id";

/** Seed compute with a process and a browser with a live session. */
async function serviceBench(): Promise<ServiceBench> {
  const state = bench(["exec.process@1", "service.port@1"]);
  const store = state.store;
  const browser: AttachmentSummary = {
    sessionId: state.sessionId,
    attachmentId: `att-${randomUUID()}`,
    name: "browser",
    generation: 3,
    status: "active",
    capabilityIds: ["browser.session@1"],
  };
  store.insertAttachment(browser);
  const processId = (
    await bindResource(
      store,
      state.sessionId,
      {
        type: "process.group",
        owner: { sessionId: state.sessionId, attachmentId: state.attachmentId, generation: 1 },
        capability: "exec.process@1",
        lifetime: "attachment",
        recovery: "reconstruct",
      },
      okTransport,
      { authority: AUTHORITY },
    )
  ).ref.id;
  const browserResourceId = (
    await bindResource(
      store,
      state.sessionId,
      {
        type: "browser.session",
        owner: { sessionId: state.sessionId, attachmentId: browser.attachmentId, generation: 3 },
        capability: "browser.session@1",
        lifetime: "external",
        recovery: "reattach",
        extensions: { [PROVIDER_SESSION]: `provider-session-${randomUUID().slice(0, 8)}` },
      },
      okTransport,
      { authority: AUTHORITY },
    )
  ).ref.id;
  return {
    store,
    blobs: state.blobs,
    sessionId: state.sessionId,
    computeId: state.attachmentId,
    browserId: browser.attachmentId,
    processId,
    browserResourceId,
    revisionId: state.revisionId,
    directory: state.directory,
    observe: { state: "active" },
    done: state.done,
  };
}

/** The continuity transport of one service bench, by scripted state. */
function transportOf(state: ServiceBench): BrowserContinuityTransport {
  return {
    observeSession: async () => ({ state: state.observe.state }),
  };
}

/** Replace the compute of one service bench; return the switch. */
async function replaceCompute(
  state: ServiceBench,
  serviceId: string,
  adapter: ScriptedAdapter,
): Promise<SwitchReport> {
  const request = coveringRequest(
    {
      store: state.store,
      blobs: state.blobs,
      sessionId: state.sessionId,
      attachmentId: state.computeId,
      revisionId: state.revisionId,
      directory: state.directory,
      done: state.done,
    },
    [`process.group ${state.processId}`, `service.port ${serviceId}`],
  );
  return switchCompute(
    {
      store: state.store,
      blobs: state.blobs,
      sessionId: state.sessionId,
      attachmentId: state.computeId,
      revisionId: state.revisionId,
      directory: state.directory,
      done: state.done,
    },
    request,
    adapter,
  );
}

// -- The case pack ---------------------------------------------------------------

/** The replacement failure and resource case pack. */
export function replacementResourceCases(): ConformanceCase[] {
  return [
    {
      id: "replacement.phase-failures",
      area: "replacement",
      summary: "Failure in every phase leaves the source holding authority.",
      async run() {
        // Phase 1, before quiesce: a blocked plan refuses and the
        // attachment never leaves active.
        const blocked = bench(["exec.process@1"]);
        try {
          const native = (await bindResource(
            blocked.store,
            blocked.sessionId,
            {
              type: "interpreter.heap",
              owner: {
                sessionId: blocked.sessionId,
                attachmentId: blocked.attachmentId,
                generation: 1,
              },
              capability: "exec.process@1",
              lifetime: "attachment",
              recovery: "native",
            },
            okTransport,
            { authority: AUTHORITY },
          )).ref.id;
          const refused = await expectCode(
            () =>
              prepareReplacement(
                blocked.store,
                requestOf(blocked, { requiredResources: [native] }),
              ),
            "HandoffBlocked",
          );
          if (refused !== undefined) {
            return refused;
          }
          if (blocked.store.getAttachment(blocked.attachmentId)!.status !== "active") {
            return {
              outcome: "fail",
              reason: "the blocked plan still quiesced the source",
            };
          }
        } finally {
          blocked.done();
        }

        // Phase 2: a managed writer holding the mutation lease blocks
        // the checkpoint outright.
        const fenced = bench(["exec.process@1"]);
        try {
          const prepared = await prepareReplacement(fenced.store, requestOf(fenced));
          const writer = fenced.store.acquireMutationLease(
            fenced.sessionId,
            fenced.attachmentId,
            "managed-writer",
            60_000,
          );
          const held = await expectCode(
            () => checkpointReplacement(fenced.store, prepared.transitionId),
            "HandoffBlocked",
          );
          if (held !== undefined) {
            return held;
          }
          fenced.store.releaseMutationLease(
            fenced.sessionId,
            fenced.attachmentId,
            writer.fencingToken,
          );
        } finally {
          fenced.done();
        }

        // Phases 3 and 4: a provider that cannot allocate fails the
        // destination, and so does a recipe step that fails; the source
        // stays quiesced with every binding bound, and an abort
        // restores it.
        const unavailable = new ScriptedAdapter();
        unavailable.failures.acquire = providerUnavailableError(
          "The scripted provider cannot allocate.",
        );
        for (const adapter of [unavailable, failingRecipeAdapter()]) {
          const state = bench(["exec.process@1"]);
          try {
            const outcome = await destinationFailure(state, adapter);
            if (outcome !== undefined) {
              return outcome;
            }
          } finally {
            state.done();
          }
        }

        // Phase 5: a destination asked for a capability the provider
        // never declared fails the transition before any switch.
        const mismatched = bench(["exec.process@1"]);
        try {
          const prepared = await prepareReplacement(
            mismatched.store,
            requestOf(mismatched, {
              destination: { requires: { "exec.python@1": {} } },
            }),
          );
          checkpointReplacement(mismatched.store, prepared.transitionId);
          const report: DestinationReport = await prepareDestination(
            mismatched.store,
            prepared.transitionId,
            destinationOptions(mismatched, new ScriptedAdapter(), mismatched.directory()),
          );
          if (report.state !== "failed" || report.error?.code !== "RequirementUnsatisfied") {
            return {
              outcome: "fail",
              reason: "the unsatisfiable destination did not fail the transition",
              detail: `${report.state} ${report.error?.code ?? "no error"}`,
            };
          }
          if (mismatched.store.getAttachment(mismatched.attachmentId)!.status !== "replacing") {
            return {
              outcome: "fail",
              reason: "the unsatisfiable destination moved the source attachment",
            };
          }
          const aborted = abortReplacement(mismatched.store, prepared.transitionId);
          if (
            aborted.sourceGeneration !== 1 ||
            mismatched.store.getAttachment(mismatched.attachmentId)!.status !== "active"
          ) {
            return {
              outcome: "fail",
              reason: "the abort did not restore the source after the failed destination",
            };
          }
        } finally {
          mismatched.done();
        }
        return {
          outcome: "pass",
          detail:
            "Blocked plan, held fence, provider failure, failing recipe, and an unsatisfiable destination each refused with the source in authority.",
        };
      },
    },
    {
      id: "replacement.unknown-operations",
      area: "replacement",
      summary: "An unknown operation outcome blocks preparation under every policy.",
      async run() {
        const state = bench(["exec.process@1"]);
        try {
          const unknownIds: string[] = [];
          for (const policy of ["reject", "cancel", "wait"] as const) {
            unknownIds.push(admitUnknown(state));
            const blocked = await prepareReplacement(
              state.store,
              requestOf(state, { activeOperations: policy }),
              policy === "cancel"
                ? { cancel: { cancel: async () => ({ outcome: "confirmed", stopped: true }) } }
                : policy === "wait"
                  ? { waitMs: 10, pollIntervalMs: 5 }
                  : {},
            );
            if (blocked.state !== "blocked") {
              return {
                outcome: "fail",
                reason: `policy ${policy} prepared over an unknown outcome`,
                detail: blocked.state,
              };
            }
            const reasons = blocked.blockers.map(
              (blocker) => (blocker.details as { reason?: string }).reason,
            );
            if (!reasons.includes("unknown-outcome")) {
              return {
                outcome: "fail",
                reason: `policy ${policy} blocked without naming the unknown outcome`,
                detail: JSON.stringify(reasons),
              };
            }
            // The abort restores the source; the next policy retries.
            abortReplacement(state.store, blocked.transitionId);
            if (state.store.getAttachment(state.attachmentId)!.status !== "active") {
              return {
                outcome: "fail",
                reason: `the abort after policy ${policy} did not reactivate the source`,
              };
            }
          }
          // Evidence resolves every uncertainty; preparation then runs.
          for (const operationId of unknownIds) {
            reconcileOperation(state.store, state.sessionId, operationId, {
              kind: "completed",
              resultRef: `op:${operationId}`,
              detail: "A provider journal answered for the lost responses.",
            });
          }
          const prepared = await prepareReplacement(state.store, requestOf(state));
          if (prepared.state !== "prepared") {
            return {
              outcome: "fail",
              reason: "preparation still blocked after the outcomes resolved",
              detail: JSON.stringify(prepared.blockers.map((blocker) => blocker.code)),
            };
          }
          return {
            outcome: "pass",
            detail: "Uncertainty blocked reject, cancel, and wait alike; evidence unblocked preparation.",
          };
        } finally {
          state.done();
        }
      },
    },
    {
      id: "replacement.expired-mutation-lease",
      area: "replacement",
      summary: "A fence nobody holds anymore refuses both the switch and the abort.",
      async run() {
        const state = bench(["exec.process@1"]);
        try {
          const bound = (await bindResource(
            state.store,
            state.sessionId,
            {
              type: "process.group",
              owner: {
                sessionId: state.sessionId,
                attachmentId: state.attachmentId,
                generation: 1,
              },
              capability: "exec.process@1",
              lifetime: "attachment",
              recovery: "reconstruct",
            },
            okTransport,
            { authority: AUTHORITY },
          )).ref.id;
          const prepared = await prepareReplacement(
            state.store,
            coveringRequest(state, [`process.group ${bound}`]),
          );
          const checkpointed = checkpointReplacement(state.store, prepared.transitionId);
          if (checkpointed.consistency.kind !== "writers-stopped") {
            return {
              outcome: "fail",
              reason: "the checkpoint did not stop the writers itself",
              detail: checkpointed.consistency.kind,
            };
          }
          const adapter = new ScriptedAdapter();
          const destination = await prepareDestination(
            state.store,
            prepared.transitionId,
            destinationOptions(state, adapter, state.directory()),
          );
          if (destination.state !== "validated") {
            return {
              outcome: "fail",
              reason: "the scripted destination never validated",
              detail: `${destination.state} ${destination.error?.code ?? ""}`,
            };
          }
          // The fence ages out and a janitor releases it: a controller
          // holding the recorded token is now stale.
          state.store.releaseMutationLease(
            state.sessionId,
            state.attachmentId,
            checkpointed.consistency.fencingToken,
          );
          const switched = await expectCode(
            () => switchReplacement(state.store, prepared.transitionId),
            "StaleHandle",
          );
          if (switched !== undefined) {
            return switched;
          }
          const aborted = await expectCode(
            () => abortReplacement(state.store, prepared.transitionId),
            "StaleHandle",
          );
          if (aborted !== undefined) {
            return aborted;
          }
          // Nothing moved: the source stays quiesced at its generation,
          // its binding stays bound, and no cleanup was promised.
          const attachment = state.store.getAttachment(state.attachmentId)!;
          if (attachment.status !== "replacing" || attachment.generation !== 1) {
            return {
              outcome: "fail",
              reason: "the stale controller still moved the source attachment",
              detail: `${attachment.status} generation ${attachment.generation}`,
            };
          }
          if (state.store.getResourceBinding(state.sessionId, bound)!.status !== "bound") {
            return {
              outcome: "fail",
              reason: "the refused switch still invalidated a source binding",
            };
          }
          if (state.store.listCleanup(state.sessionId, "pending").length !== 0) {
            return {
              outcome: "fail",
              reason: "the refused switch still promised cleanup",
            };
          }
          return {
            outcome: "pass",
            detail: "A released fence refused the commit and the abort; a stale controller cannot act.",
          };
        } finally {
          state.done();
        }
      },
    },
    {
      id: "replacement.controller-restart",
      area: "replacement",
      summary: "A controller that restarts before or after the switch commits exactly once.",
      async run() {
        const state = bench(["exec.process@1"]);
        try {
          const bound = (await bindResource(
            state.store,
            state.sessionId,
            {
              type: "process.group",
              owner: {
                sessionId: state.sessionId,
                attachmentId: state.attachmentId,
                generation: 1,
              },
              capability: "exec.process@1",
              lifetime: "attachment",
              recovery: "reconstruct",
            },
            okTransport,
            { authority: AUTHORITY },
          )).ref.id;
          const adapter = new ScriptedAdapter();
          const prepared = await prepareReplacement(
            state.store,
            coveringRequest(state, [`process.group ${bound}`]),
          );
          checkpointReplacement(state.store, prepared.transitionId);

          // Crash after the acquire landed but before the transition
          // recorded it: the acquisition exists under the transition's
          // own request identity.
          const acquired = await attachEnvironment(
            state.store,
            state.sessionId,
            "policy://conformance",
            {
              adapter,
              request: { name: `worker_${prepared.transitionId}`.slice(0, 63), requires: {} },
              requestKey: `replace:${prepared.transitionId}`,
              principal: "conformance",
              authority: AUTHORITY,
            },
          );
          const record = state.store.getTransition(prepared.transitionId)!;
          state.store.casTransition(
            prepared.transitionId,
            { phase: "checkpointed" },
            { ...record, phase: "provisioning", updatedAt: new Date().toISOString() },
          );
          const resumed = await prepareDestination(
            state.store,
            prepared.transitionId,
            destinationOptions(state, adapter, state.directory()),
          );
          if (
            resumed.state !== "validated" ||
            resumed.candidateAttachmentId !== acquired.attachmentId
          ) {
            return {
              outcome: "fail",
              reason: "the restarted controller did not adopt the one acquisition",
              detail: `${resumed.state} ${resumed.candidateAttachmentId}`,
            };
          }
          if (state.store.listAttachments(state.sessionId).length !== 2) {
            return {
              outcome: "fail",
              reason: "the resumed flow allocated a second environment",
            };
          }

          // Crash right after the switch transaction: the response was
          // lost, not the commit. The repeated call returns the record.
          const committed = switchReplacement(state.store, prepared.transitionId);
          const repeated = switchReplacement(state.store, prepared.transitionId);
          if (
            repeated.newGeneration !== committed.newGeneration ||
            repeated.environmentId !== committed.environmentId ||
            repeated.adoptedResourceIds.length !== committed.adoptedResourceIds.length ||
            repeated.cleanup.length !== committed.cleanup.length
          ) {
            return {
              outcome: "fail",
              reason: "the repeated switch reported a different commit",
            };
          }
          if (state.store.getAttachment(state.attachmentId)!.generation !== committed.newGeneration) {
            return {
              outcome: "fail",
              reason: "the repeated switch moved the generation again",
            };
          }
          if (state.store.listCleanup(state.sessionId, "pending").length !== committed.cleanup.length) {
            return {
              outcome: "fail",
              reason: "the repeated switch doubled the cleanup obligations",
            };
          }
          // Destination preparation over a switched transition refuses.
          const reprepared = await expectCode(
            () =>
              prepareDestination(
                state.store,
                prepared.transitionId,
                destinationOptions(state, adapter, state.directory()),
              ),
            "InvalidRequest",
          );
          if (reprepared !== undefined) {
            return reprepared;
          }
          return {
            outcome: "pass",
            detail: `Restart mid-provision adopted one acquisition; restart after the switch returned commit ${committed.newGeneration}.`,
          };
        } finally {
          state.done();
        }
      },
    },
    {
      id: "replacement.duplicate-switch",
      area: "replacement",
      summary: "A duplicate switch request changes nothing, and a committed switch never turns back.",
      async run() {
        const state = bench(["exec.process@1"]);
        try {
          const committed = await switchCompute(
            state,
            coveringRequest(state, []),
            new ScriptedAdapter(),
          );
          // The duplicate returns the committed record, verbatim.
          const duplicate = switchReplacement(state.store, committed.transitionId);
          if (
            duplicate.newGeneration !== committed.newGeneration ||
            duplicate.environmentId !== committed.environmentId ||
            duplicate.oldGeneration !== committed.oldGeneration
          ) {
            return {
              outcome: "fail",
              reason: "the duplicate switch reported a different commit",
              detail: `${duplicate.newGeneration} vs ${committed.newGeneration}`,
            };
          }
          if (duplicate.invalidatedResourceIds.length !== committed.invalidatedResourceIds.length) {
            return {
              outcome: "fail",
              reason: "the duplicate switch invalidated resources again",
            };
          }
          // Recovery never crosses a committed switch.
          const reversed = await expectCode(
            () => abortReplacement(state.store, committed.transitionId),
            "HandoffBlocked",
          );
          if (reversed !== undefined) {
            return reversed;
          }
          const details = await refusalDetails(() =>
            abortReplacement(state.store, committed.transitionId),
          );
          if ((details as { reason?: string }).reason !== "switch-committed") {
            return {
              outcome: "fail",
              reason: "the abort after the switch refused without naming the commit",
              detail: JSON.stringify(details),
            };
          }
          // A stale request against the new generation refuses before
          // it could quiesce anything.
          const stale = await expectCode(
            () =>
              prepareReplacement(
                state.store,
                requestOf(state, {
                  source: {
                    sessionId: state.sessionId,
                    attachmentId: state.attachmentId,
                    generation: 1,
                  },
                }),
              ),
            "StaleHandle",
          );
          if (stale !== undefined) {
            return stale;
          }
          return {
            outcome: "pass",
            detail: `Generation ${committed.newGeneration} committed once; the duplicate answered with the record.`,
          };
        } finally {
          state.done();
        }
      },
    },
    {
      id: "replacement.failed-source-cleanup",
      area: "replacement",
      summary: "A failed source release stays visible until the provider confirms it.",
      async run() {
        const state = bench(["exec.process@1"]);
        const adapter = new ScriptedAdapter();
        try {
          // The source needs a real acquisition for the switch to owe a
          // release the cleanup pass can retry.
          const source = await attachEnvironment(
            state.store,
            state.sessionId,
            "policy://conformance",
            {
              adapter,
              request: { name: "worker-two", requires: {} },
              requestKey: `attach-${randomUUID()}`,
              principal: "conformance",
              authority: AUTHORITY,
            },
          );
          const committed = await switchCompute(
            state,
            coveringRequest(state, [], {
              source: {
                sessionId: state.sessionId,
                attachmentId: source.attachmentId,
                generation: 1,
              },
            }),
            adapter,
          );
          if (committed.cleanup.length !== 1) {
            return {
              outcome: "fail",
              reason: "the switch promised no source cleanup",
              detail: JSON.stringify(committed.cleanup.map((entry) => entry.kind)),
            };
          }
          const obligation = committed.cleanup[0]!;

          // The provider refuses the release: the obligation stays
          // pending and visible.
          adapter.failures.releaseFailed = true;
          const failed = await runCleanup(state.store, state.sessionId, "policy://conformance", {
            adapter,
            principal: "conformance",
            authority: AUTHORITY,
          });
          if (
            failed.outcomes[0]?.outcome !== "pending" ||
            failed.remaining !== 1 ||
            failed.outcomes[0]?.cleanupId !== obligation.id
          ) {
            return {
              outcome: "fail",
              reason: "the failed release did not stay pending",
              detail: JSON.stringify(failed),
            };
          }
          // The live destination was not touched by the retry.
          const switched = state.store.getAttachment(source.attachmentId)!;
          if (switched.status !== "active" || switched.generation !== committed.newGeneration) {
            return {
              outcome: "fail",
              reason: "the cleanup retry touched the switched attachment",
              detail: `${switched.status} generation ${switched.generation}`,
            };
          }

          // The provider confirms on the retry: the obligation clears.
          adapter.failures.releaseFailed = false;
          const satisfied = await runCleanup(state.store, state.sessionId, "policy://conformance", {
            adapter,
            principal: "conformance",
            authority: AUTHORITY,
          });
          if (satisfied.remaining !== 0 || satisfied.outcomes[0]?.outcome !== "satisfied") {
            return {
              outcome: "fail",
              reason: "the confirmed release did not clear the obligation",
              detail: JSON.stringify(satisfied),
            };
          }
          return {
            outcome: "pass",
            detail: "The failed release stayed pending; the confirmed release cleared it.",
          };
        } finally {
          state.done();
        }
      },
    },
    {
      id: "resources.stale-generation",
      area: "resources",
      summary: "A handle of a replaced generation is stale, and reattachment never revives it.",
      async run() {
        const state = bench(["exec.process@1"]);
        try {
          const original = (await bindResource(
            state.store,
            state.sessionId,
            {
              type: "process.group",
              owner: {
                sessionId: state.sessionId,
                attachmentId: state.attachmentId,
                generation: 1,
              },
              capability: "exec.process@1",
              lifetime: "attachment",
              recovery: "reattach",
            },
            okTransport,
            { authority: AUTHORITY },
          )).ref.id;
          // A replacement moved the attachment to generation 2.
          const stored = state.store.getAttachment(state.attachmentId)!;
          state.store.casAttachment(
            state.attachmentId,
            { status: "active" },
            { ...stored, generation: 2 },
          );
          const stale = resolveOf(state, original, "exec.process@1");
          if (stale.validity !== "stale-generation") {
            return {
              outcome: "fail",
              reason: "the old handle did not report a stale generation",
              detail: stale.validity,
            };
          }
          // A caller without the capability learns unauthorized, not stale.
          const wrongScope = resolveOf(state, original, "service.port@1");
          if (wrongScope.validity !== "unauthorized") {
            return {
              outcome: "fail",
              reason: "the authorization check did not come first",
              detail: wrongScope.validity,
            };
          }
          // Reattachment under the new generation mints a new handle;
          // the old one stays dead forever.
          const rebound = reattachResource(
            state.store,
            state.sessionId,
            original,
            { sessionId: state.sessionId, attachmentId: state.attachmentId, generation: 2 },
            { authority: AUTHORITY },
          );
          if (rebound.validity !== "valid" || rebound.ref.id === original) {
            return {
              outcome: "fail",
              reason: "the reattachment did not mint a fresh valid handle",
              detail: `${rebound.validity} ${rebound.ref.id}`,
            };
          }
          if (resolveOf(state, original, "exec.process@1").validity !== "stale-generation") {
            return {
              outcome: "fail",
              reason: "the original handle did not die with the reattachment",
            };
          }
          if (resolveOf(state, rebound.ref.id, "exec.process@1").validity !== "valid") {
            return {
              outcome: "fail",
              reason: "the new handle did not resolve valid",
            };
          }
          return {
            outcome: "pass",
            detail: "Stale handles report themselves; reattachment mints new identity.",
          };
        } finally {
          state.done();
        }
      },
    },
    {
      id: "resources.browser-survival",
      area: "resources",
      summary: "An independently attached browser survives compute replacement and reconnects.",
      async run() {
        const state = await serviceBench();
        try {
          const exposed = exposeService(
            state.store,
            state.sessionId,
            {
              processResourceId: state.processId,
              port: 8080,
              protocol: "http",
              audience: { kind: "session" },
              expiration: { mode: "duration", durationMs: 600_000 },
            },
            { authority: AUTHORITY },
          );
          const connected = connectService(
            state.store,
            state.sessionId,
            {
              serviceId: exposed.service.ref.id,
              consumer: { attachmentId: state.browserId, generation: 3 },
            },
            { authority: AUTHORITY },
          );
          const report = await replaceCompute(state, exposed.service.ref.id, new ScriptedAdapter());
          if (report.newGeneration !== 2) {
            return {
              outcome: "fail",
              reason: "the compute replacement did not commit generation 2",
              detail: String(report.newGeneration),
            };
          }
          // The browser attachment and its handle never moved.
          const browserAttachment = state.store.getAttachment(state.browserId)!;
          if (browserAttachment.status !== "active" || browserAttachment.generation !== 3) {
            return {
              outcome: "fail",
              reason: "the replacement moved the independent browser attachment",
              detail: `${browserAttachment.status} generation ${browserAttachment.generation}`,
            };
          }
          const browserBinding = state.store.getResourceBinding(
            state.sessionId,
            state.browserResourceId,
          )!;
          if (browserBinding.status !== "bound" || browserBinding.owner.generation !== 3) {
            return {
              outcome: "fail",
              reason: "the browser handle did not stay bound at its generation",
            };
          }
          // The same valid handle reconnects to the reconstructed server.
          const adoptedProcess = report.adoptedResourceIds
            .map((id) => state.store.getResourceBinding(state.sessionId, id))
            .find((binding) => binding?.type === "process.group");
          if (adoptedProcess === null || adoptedProcess === undefined) {
            return {
              outcome: "fail",
              reason: "the switch adopted no process binding",
            };
          }
          const reconnected = await reconnectBrowserService(
            state.store,
            state.sessionId,
            {
              browserResourceId: state.browserResourceId,
              processResourceId: adoptedProcess.id,
              port: 8080,
              protocol: "http",
              audience: { kind: "session" },
              expiration: { mode: "duration", durationMs: 600_000 },
              supersededServiceId: exposed.service.ref.id,
            },
            { authority: AUTHORITY, transport: transportOf(state) },
          );
          if (
            reconnected.browser.ref.id !== state.browserResourceId ||
            reconnected.browser.validity !== "valid"
          ) {
            return {
              outcome: "fail",
              reason: "the reconnection did not stand on the same handle",
            };
          }
          if (reconnected.service.compute.generation !== 2) {
            return {
              outcome: "fail",
              reason: "the new service does not serve the replacement generation",
            };
          }
          if (
            reconnected.connection.connection.validity !== "valid" ||
            reconnected.connection.connection.ref.id === connected.connection.ref.id
          ) {
            return {
              outcome: "fail",
              reason: "the new connection is not a fresh valid connection",
            };
          }
          return {
            outcome: "pass",
            detail: "The browser kept generation 3 and connected anew to generation 2.",
          };
        } finally {
          state.done();
        }
      },
    },
    {
      id: "resources.expired-browser",
      area: "resources",
      summary: "A provider-reported browser expiry is never claimed as preserved.",
      async run() {
        const state = await serviceBench();
        try {
          state.observe.state = "expired";
          const reconnectInput: ReconnectBrowserInput = {
            browserResourceId: state.browserResourceId,
            processResourceId: state.processId,
            port: 8080,
            protocol: "http",
            audience: { kind: "session" },
            expiration: { mode: "duration", durationMs: 600_000 },
          };
          const refused = await refusalDetails(() =>
            reconnectBrowserService(state.store, state.sessionId, reconnectInput, {
              authority: AUTHORITY,
              transport: transportOf(state),
            }),
          );
          const details = refused as { reason?: string; preserved?: boolean } | null;
          if (details?.reason !== "browser-session-expired" || details.preserved !== false) {
            return {
              outcome: "fail",
              reason: "the expiry refusal did not report itself honestly",
              detail: JSON.stringify(details),
            };
          }
          // The binding stopped claiming a valid handle.
          const binding = state.store.getResourceBinding(state.sessionId, state.browserResourceId)!;
          if (
            binding.status !== "invalidated" ||
            !binding.invalidationReason?.startsWith("browser-session-expired")
          ) {
            return {
              outcome: "fail",
              reason: "the expired browser binding still claims a handle",
              detail: `${binding.status} ${binding.invalidationReason ?? ""}`,
            };
          }
          // A repeated attempt says the handle is dead.
          const repeat = await refusalDetails(() =>
            reconnectBrowserService(state.store, state.sessionId, reconnectInput, {
              authority: AUTHORITY,
              transport: transportOf(state),
            }),
          );
          if ((repeat as { reason?: string })?.reason !== "browser-not-bound") {
            return {
              outcome: "fail",
              reason: "the repeated reconnection did not report the dead handle",
              detail: JSON.stringify(repeat),
            };
          }
          // Nothing was exposed on the refused path.
          const services = state.store
            .listResourceBindings(state.sessionId)
            .filter((binding) => binding.type === "service.port");
          if (services.length !== 0) {
            return {
              outcome: "fail",
              reason: "the refused reconnection still exposed a service",
            };
          }
          return {
            outcome: "pass",
            detail: "The provider's word retired the binding; nothing was preserved.",
          };
        } finally {
          state.done();
        }
      },
    },
    {
      id: "resources.invalidated-service-connection",
      area: "resources",
      summary: "Connections die with the compute generation they depended on.",
      async run() {
        const state = await serviceBench();
        try {
          const exposed = exposeService(
            state.store,
            state.sessionId,
            {
              processResourceId: state.processId,
              port: 8080,
              protocol: "http",
              audience: { kind: "session" },
              expiration: { mode: "duration", durationMs: 600_000 },
            },
            { authority: AUTHORITY },
          );
          const connected = connectService(
            state.store,
            state.sessionId,
            {
              serviceId: exposed.service.ref.id,
              consumer: { attachmentId: state.browserId, generation: 3 },
            },
            { authority: AUTHORITY },
          );
          const report = await replaceCompute(state, exposed.service.ref.id, new ScriptedAdapter());
          const connection = state.store.getResourceBinding(
            state.sessionId,
            connected.connection.ref.id,
          )!;
          if (connection.status !== "invalidated") {
            return {
              outcome: "fail",
              reason: "the connection survived the compute replacement",
            };
          }
          if (connection.owner.attachmentId !== state.browserId) {
            return {
              outcome: "fail",
              reason: "the swept connection lost its owner",
            };
          }
          // The sweep reported it among the invalidated handles.
          if (!report.invalidatedResourceIds.includes(connection.id)) {
            return {
              outcome: "fail",
              reason: "the switch report omitted the swept connection",
            };
          }
          // Standing checks report both ends; the serving end moved on.
          const standing = checkConnectionStanding(state.store, state.sessionId, connection);
          if (standing.valid !== false) {
            return {
              outcome: "fail",
              reason: "the dead connection still checks as valid",
              detail: standing.detail,
            };
          }
          // A new connect to the dead service refuses.
          const refused = await expectCode(
            () =>
              connectService(
                state.store,
                state.sessionId,
                {
                  serviceId: exposed.service.ref.id,
                  consumer: { attachmentId: state.browserId, generation: 3 },
                },
                { authority: AUTHORITY },
              ),
            "InvalidRequest",
          );
          if (refused !== undefined) {
            return refused;
          }
          // The browser binding itself stayed bound: the sweep touches
          // connections only.
          const browser = state.store.getResourceBinding(state.sessionId, state.browserResourceId)!;
          if (browser.status !== "bound") {
            return {
              outcome: "fail",
              reason: "the sweep invalidated the browser alongside its connection",
            };
          }
          return {
            outcome: "pass",
            detail: "The connection died with generation 1; its browser stayed valid.",
          };
        } finally {
          state.done();
        }
      },
    },
  ];
}

// -- Pack-local helpers -----------------------------------------------------------

/** One scripted adapter whose recipe step fails. */
function failingRecipeAdapter(): ScriptedAdapter {
  const adapter = new ScriptedAdapter();
  adapter.failures.invoke = providerUnavailableError("The scripted recipe step failed.");
  return adapter;
}

/** Drive one destination to failure and prove the source keeps authority. */
async function destinationFailure(
  state: Bench,
  adapter: ScriptedAdapter,
): Promise<ConformanceCaseAnswer | void> {
  const bound = (await bindResource(
    state.store,
    state.sessionId,
    {
      type: "process.group",
      owner: {
        sessionId: state.sessionId,
        attachmentId: state.attachmentId,
        generation: 1,
      },
      capability: "exec.process@1",
      lifetime: "attachment",
      recovery: "reconstruct",
    },
    okTransport,
    { authority: AUTHORITY },
  )).ref.id;
  const prepared = await prepareReplacement(
    state.store,
    coveringRequest(state, [`process.group ${bound}`]),
  );
  checkpointReplacement(state.store, prepared.transitionId);
  const report: DestinationReport = await prepareDestination(
    state.store,
    prepared.transitionId,
    destinationOptions(state, adapter, state.directory()),
  );
  if (report.state !== "failed") {
    return {
      outcome: "fail",
      reason: "the scripted destination failure did not fail the transition",
      detail: report.state,
    };
  }
  // The source stays quiesced with every binding bound.
  if (state.store.getAttachment(state.attachmentId)!.status !== "replacing") {
    return {
      outcome: "fail",
      reason: "the failed destination moved the source attachment",
    };
  }
  if (state.store.getResourceBinding(state.sessionId, bound)!.status !== "bound") {
    return {
      outcome: "fail",
      reason: "the failed destination invalidated a source binding",
    };
  }
  // The abort restores the source at its unchanged generation.
  const aborted = abortReplacement(state.store, prepared.transitionId);
  if (
    aborted.sourceGeneration !== 1 ||
    state.store.getAttachment(state.attachmentId)!.status !== "active"
  ) {
    return {
      outcome: "fail",
      reason: "the abort did not restore the source",
    };
  }
  return undefined;
}

/** Admit, dispatch, and settle one operation as unknown. */
function admitUnknown(state: Bench): string {
  const admitted = admitInvocation(
    state.store,
    state.sessionId,
    {
      attachment: {
        sessionId: state.sessionId,
        attachmentId: state.attachmentId,
        generation: 1,
      },
      capability: "exec.process@1",
      operation: "run",
      input: { command: "sleep", args: ["600"] },
      requestKey: `op-${randomUUID()}`,
    },
    { authority: AUTHORITY },
  );
  claimOperationDispatch(state.store, state.sessionId, admitted.operation.id);
  settleOperation(state.store, state.sessionId, admitted.operation.id, {
    kind: "unknown",
    error: operationUnknownError(
      admitted.operation.id,
      "The response was lost after the effects may have run.",
    ),
  });
  return admitted.operation.id;
}

/** Resolve one resource through the pack's authority. */
function resolveOf(state: Bench, resourceId: string, capability: string) {
  return resolveResource(state.store, state.sessionId, resourceId, {
    authority: AUTHORITY,
    capability,
    operation: "run",
  });
}

/** The details of one refusal, or null when the call succeeded. */
async function refusalDetails(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return (error as { details?: unknown }).details ?? null;
  }
  return null;
}
