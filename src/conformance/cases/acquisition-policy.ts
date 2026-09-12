import { randomUUID } from "node:crypto";
import { ControlStore } from "../../store/control-store.js";
import { PolicyAuthority } from "../../core/policy.js";
import type { PolicyAuthority as Authority } from "../../core/policy.js";
import type { PortablePolicy } from "../../schema/policy.js";
import type {
  EnvironmentOffer,
  EnvironmentRequest,
} from "../../schema/capability.js";
import type { EnvironmentLease } from "../../schema/adapter.js";
import { matchEnvironment } from "../../core/matching.js";
import { processCapabilityDescriptor } from "../../runtime/process-capability.js";
import { attachEnvironment, reconcileAcquisition } from "../../runtime/acquisition.js";
import { releaseAttachment } from "../../runtime/release.js";
import type { ConformanceCase, ConformanceContext } from "../runner.js";
import type { ConformanceCaseAnswer } from "../runner.js";

/**
 * Acquisition and policy conformance cases (SPEC.md section 21).
 *
 * The pack drives the adapter under test through the durable
 * acquisition protocol and the matching surface. Every case observes
 * behavior the adapter itself reports; nothing is inferred from the
 * absence of bad news.
 *
 * Cases that allocate real environments declare external effects, so
 * the runner skips them unless the configured authority grants them
 * (SPEC.md section 21: paid resources and external effects run only
 * under configured test authority).
 */

/** One in-memory session the case owns for its own duration. */
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

/**
 * One policy that admits this adapter and its operations.
 *
 * The configured test authority grants every location, open egress,
 * host access, a day of environment lifetime, and generous resource
 * ceilings, so the pack runs against any honest adapter. Cases that
 * observe a denial patch one dimension narrower.
 */
function policyOf(context: ConformanceContext, patch: Partial<PortablePolicy> = {}): Authority {
  return PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: [context.adapter.id],
    operations: ["exec.process@1"],
    locations: ["local", "remote"],
    networkEgress: "unrestricted",
    hostFilesystemAccess: true,
    maxEnvironmentLifetimeMs: 86_400_000,
    maxResources: {
      memoryBytes: 4 * 1024 ** 3,
      storageBytes: 4 * 1024 ** 3,
      gpuMemoryBytes: 4 * 1024 ** 3,
    },
    ...patch,
  });
}

/** Attach one environment through the durable protocol. */
async function attach(
  context: ConformanceContext,
  bench: Bench,
  requestKey: string,
  patch: { authority?: Authority; request?: EnvironmentRequest } = {},
) {
  return attachEnvironment(bench.store, bench.sessionId, "policy://conformance", {
    adapter: context.adapter,
    request:
      patch.request ?? { name: "worker", providerId: context.adapter.id, requires: {} },
    requestKey,
    principal: "conformance",
    authority: patch.authority ?? policyOf(context),
  });
}

/** One offer with the process capability, under a chosen provider. */
function offerOf(providerId: string): EnvironmentOffer {
  return {
    providerId,
    platform: { os: "linux", arch: "x64" },
    capabilities: [
      { id: "exec.process@1", attributes: processCapabilityDescriptor().attributes },
    ],
  };
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
  run: () => Promise<unknown> | unknown,
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

/** The acquisition and matching case pack. */
export function acquisitionPolicyCases(): ConformanceCase[] {
  return [
    {
      id: "acquisition.duplicate-request",
      area: "acquisition",
      capability: "exec.process@1",
      summary: "One request key names one acquisition; a repeat recovers it.",
      effects: { external: true },
      async run(context) {
        const state = bench();
        const key = `conf-${randomUUID()}`;
        const first = await attach(context, state, key);
        const second = await attach(context, state, key);
        if (first.attachmentId !== second.attachmentId) {
          return {
            outcome: "fail",
            reason: "the repeated key created a second attachment",
            detail: `${first.attachmentId} then ${second.attachmentId}`,
          };
        }
        if (first.generation !== second.generation || second.status !== "active") {
          return {
            outcome: "fail",
            reason: "the recovered attachment is not the same live generation",
            detail: `${first.generation}/${first.status} then ${second.generation}/${second.status}`,
          };
        }
        return undefined;
      },
    },
    {
      id: "acquisition.lost-response",
      area: "acquisition",
      capability: "exec.process@1",
      summary: "A lost attach response recovers to the same environment.",
      effects: { external: true },
      async run(context) {
        const state = bench();
        const key = `conf-${randomUUID()}`;
        const first = await attach(context, state, key);
        // The response to the first call was lost; the retry and the
        // reconciliation both land on the one environment allocated.
        const retried = await attach(context, state, key);
        const reconciled = await reconcileAcquisition(state.store, state.sessionId, key, {
          adapter: context.adapter,
          principal: "conformance",
          authority: policyOf(context),
        });
        if (
          retried.attachmentId !== first.attachmentId ||
          reconciled.attachmentId !== first.attachmentId
        ) {
          return {
            outcome: "fail",
            reason: "recovery after a lost response allocated or switched environments",
            detail: [retried.attachmentId, reconciled.attachmentId].join(" != ") +
              ` vs ${first.attachmentId}`,
          };
        }
        return undefined;
      },
    },
    {
      id: "acquisition.reconciliation",
      area: "acquisition",
      capability: "exec.process@1",
      summary: "Reconciliation is idempotent and reports the active attachment.",
      effects: { external: true },
      async run(context) {
        const state = bench();
        const key = `conf-${randomUUID()}`;
        await attach(context, state, key);
        const first = await reconcileAcquisition(state.store, state.sessionId, key, {
          adapter: context.adapter,
          principal: "conformance",
          authority: policyOf(context),
        });
        const second = await reconcileAcquisition(state.store, state.sessionId, key, {
          adapter: context.adapter,
          principal: "conformance",
          authority: policyOf(context),
        });
        if (
          first.attachmentId !== second.attachmentId ||
          first.status !== "active" ||
          second.status !== "active"
        ) {
          return {
            outcome: "fail",
            reason: "reconciliation is not idempotent over one acquisition",
            detail: `${first.attachmentId}/${first.status} then ${second.attachmentId}/${second.status}`,
          };
        }
        return undefined;
      },
    },
    {
      id: "acquisition.release-retry",
      area: "acquisition",
      capability: "exec.process@1",
      summary: "A repeated release confirms instead of reaching the provider again.",
      effects: { external: true },
      async run(context) {
        const state = bench();
        const key = `conf-${randomUUID()}`;
        const attached = await attach(context, state, key);
        const first = await releaseAttachment(
          state.store,
          state.sessionId,
          "policy://conformance",
          {
            sessionId: state.sessionId,
            attachmentId: attached.attachmentId,
            generation: attached.generation,
          },
          `release-${randomUUID()}`,
          {
            adapter: context.adapter,
            principal: "conformance",
            authority: policyOf(context),
          },
        );
        const second = await releaseAttachment(
          state.store,
          state.sessionId,
          "policy://conformance",
          {
            sessionId: state.sessionId,
            attachmentId: attached.attachmentId,
            generation: attached.generation,
          },
          `release-${randomUUID()}`,
          {
            adapter: context.adapter,
            principal: "conformance",
            authority: policyOf(context),
          },
        );
        if (first.status !== "released" || second.status !== "already-released") {
          return {
            outcome: "fail",
            reason: "the repeated release did not confirm idempotently",
            detail: `${first.status} then ${second.status}`,
          };
        }
        return undefined;
      },
    },
    {
      id: "acquisition.lease-expiration",
      area: "acquisition",
      capability: "exec.process@1",
      summary: "An expired lease refuses work instead of executing it.",
      effects: { external: true },
      async run(context) {
        const lease = await context.adapter.acquire({
          acquisitionId: `acq-${randomUUID()}`,
          request: { name: "worker", providerId: context.adapter.id, requires: {} },
          authority: { principal: "conformance", policyRef: "policy://conformance" },
          limits: policyOf(context).acquisitionLimits(),
        });
        const renewed = await lease.renew(new Date(Date.now() + 25).toISOString());
        if (renewed.status !== "active") {
          return {
            outcome: "fail",
            reason: "the adapter refused to renew a live lease",
            detail: `status ${renewed.status}`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
        return expectCode(
          () =>
            lease.invoke({
              operationId: `op-${randomUUID()}`,
              capability: "exec.process@1",
              operation: "run",
              input: { command: "true" },
              environmentId: lease.environmentId,
              limits: {},
            }),
          "LeaseExpired",
        );
      },
    },
    {
      id: "acquisition.stale-controller",
      area: "acquisition",
      capability: "exec.process@1",
      summary: "A stale controller cannot retarget or release a live generation.",
      effects: { external: true },
      async run(context) {
        const state = bench();
        const key = `conf-${randomUUID()}`;
        const attached = await attach(context, state, key);
        // A different request under the same key is a controller
        // mistake, not a recovery.
        const conflict = await expectCode(
          () =>
            attach(context, state, key, {
              request: {
                name: "worker",
                providerId: context.adapter.id,
                requires: {},
                platform: { os: "other-os" },
              },
            }),
          "RequestConflict",
        );
        if (conflict !== undefined) {
          return conflict;
        }
        // A release naming a generation that moved is stale, and the
        // attachment stays exactly as it was.
        const stale = await expectCode(
          () =>
            releaseAttachment(
              state.store,
              state.sessionId,
              "policy://conformance",
              {
                sessionId: state.sessionId,
                attachmentId: attached.attachmentId,
                generation: attached.generation + 5,
              },
              `release-${randomUUID()}`,
              {
                adapter: context.adapter,
                principal: "conformance",
                authority: policyOf(context),
              },
            ),
          "StaleHandle",
        );
        if (stale !== undefined) {
          return stale;
        }
        const after = state.store.getAttachment(attached.attachmentId);
        if (after === null || after.status !== "active") {
          return {
            outcome: "fail",
            reason: "the refused stale release still moved the attachment",
            detail: after === null ? "gone" : after.status,
          };
        }
        return undefined;
      },
    },
    {
      id: "matching.missing-capability",
      area: "matching",
      summary: "A required capability no offer carries refuses the match.",
      async run() {
        return expectCode(
          () =>
            matchEnvironment(
              { name: "worker", requires: { "monty.python@1": {} } },
              [offerOf("provider.a")],
            ),
          "RequirementUnsatisfied",
        );
      },
    },
    {
      id: "matching.insufficient-resources",
      area: "matching",
      summary: "Resource minima no offer meets refuse the match.",
      async run() {
        return expectCode(
          () =>
            matchEnvironment(
              {
                name: "worker",
                requires: {},
                resources: { memoryBytes: { min: 4_294_967_296 } },
              },
              [offerOf("provider.a")],
            ),
          "RequirementUnsatisfied",
        );
      },
    },
    {
      id: "matching.unknown-constraint",
      area: "matching",
      summary: "A constraint no configured adapter recognizes refuses the request.",
      async run() {
        return expectCode(
          () =>
            matchEnvironment(
              {
                name: "worker",
                requires: {},
                constraints: { "vendor.availability-zone": "east" },
              },
              [offerOf("provider.a")],
            ),
          "InvalidRequest",
        );
      },
    },
    {
      id: "matching.ambiguous-provider",
      area: "matching",
      summary: "Two satisfying providers refuse until one is named.",
      async run() {
        return expectCode(
          () =>
            matchEnvironment(
              { name: "worker", requires: {} },
              [offerOf("provider.a"), offerOf("provider.b")],
            ),
          "AmbiguousEnvironment",
        );
      },
    },
    {
      id: "matching.policy-denial",
      area: "matching",
      summary: "A policy that excludes the provider denies the acquisition.",
      async run(context) {
        const state = bench();
        return expectCode(
          () =>
            attach(context, state, `conf-${randomUUID()}`, {
              authority: PolicyAuthority.fromPolicy({ schemaVersion: 1, providers: [] }),
            }),
          "PolicyDenied",
        );
      },
    },
    {
      id: "matching.declared-restrictions",
      area: "matching",
      capability: "exec.process@1",
      summary: "Declared restrictions are observable in the manifest and the contract.",
      effects: { external: true },
      async run(context): Promise<ConformanceCaseAnswer> {
        const lease: EnvironmentLease = await context.adapter.acquire({
          acquisitionId: `acq-${randomUUID()}`,
          request: { name: "worker", providerId: context.adapter.id, requires: {} },
          authority: { principal: "conformance", policyRef: "policy://conformance" },
          limits: policyOf(context).acquisitionLimits(),
        });
        const manifest = await lease.manifest();
        const enforcement = Object.keys(manifest.enforcement ?? {});
        if (enforcement.length === 0) {
          // Nothing declared means nothing verified: the case reports
          // the gap instead of claiming coverage it does not have.
          return {
            outcome: "skip",
            reason: "no-declared-restrictions",
            detail: `The manifest of ${manifest.providerId} declares no enforcement keys.`,
          };
        }
        // Observable behavior under the declared restrictions: the
        // operation answers within the contract, addressed by the
        // identity the caller chose.
        const operationId = `op-${randomUUID()}`;
        const answered = await lease.invoke({
          operationId,
          capability: "exec.process@1",
          operation: "run",
          input: { command: "true" },
          environmentId: lease.environmentId,
          limits: {},
        });
        if (answered.operationId !== operationId || answered.status !== "completed") {
          return {
            outcome: "fail",
            reason: "the invocation did not answer within the operation contract",
            detail: `${answered.operationId}/${answered.status}`,
          };
        }
        return {
          outcome: "pass",
          detail: `Enforcement limits declared: ${enforcement.sort().join(", ")}.`,
        };
      },
    },
  ];
}
