import test from "node:test";
import assert from "node:assert/strict";
import { ControlStore } from "../store/control-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import { PolicyAuthority } from "../core/policy.js";
import { FakeEnvironmentAdapter } from "../adapters/test-adapter.js";
import { ManagedSession, PortableRuntime } from "./session.js";
import type { EnvironmentOffer } from "../schema/capability.js";
import type { AttachOptions } from "./acquisition.js";
import type {
  AcquisitionStatus,
  AdapterInvocation,
  AdapterOperation,
  AdapterOperationStatus,
  AuthorizedAcquireRequest,
  BindingResult,
  CancellationResult,
  EnvironmentAdapter,
  EnvironmentLease,
  LeaseStatus,
  ReleaseResult,
} from "../schema/adapter.js";
import type { ResourceRef } from "../schema/resource.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

const AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  providers: ["fake-local"],
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
});

/** One session and one fake adapter wired for a test. */
interface Fixture {
  session: ManagedSession;
  adapter: FakeEnvironmentAdapter;
  attach(options: Partial<AttachOptions>): Promise<unknown>;
}

async function fixture(options: { offers?: EnvironmentOffer[] } = {}): Promise<Fixture> {
  const runtime = new PortableRuntime(ControlStore.inMemory());
  const session = await runtime.createSession({ policyRef: "policy://test" });
  const adapter = new FakeEnvironmentAdapter(options);
  const attach = (overrides: Partial<AttachOptions>): Promise<unknown> =>
    session.attach({
      adapter,
      request: {
        name: "worker",
        providerId: "fake-local",
        requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
      },
      requestKey: "worker-1",
      principal: "user://test",
      authority: AUTHORITY,
      ...overrides,
    });
  return { session, adapter, attach };
}

test("a fresh acquisition activates after manifest validation", async () => {
  const { session, attach } = await fixture();
  const summary = (await attach({})) as Awaited<ReturnType<ManagedSession["attach"]>>;
  assert.equal(summary.status, "active");
  assert.equal(summary.name, "worker");
  assert.equal(summary.providerId, "fake-local");
  assert.deepEqual(summary.capabilityIds, ["exec.process@1"]);
  assert.equal(summary.environmentId, "env-fake-1");

  const described = await session.describe();
  assert.equal(described.attachments.length, 1);
  assert.equal(described.attachments[0]?.attachmentId, summary.attachmentId);
  assert.deepEqual(described.unresolvedAllocations, []);
  assert.deepEqual(described.pendingCleanup, []);

  const events = new SessionEventStream(session.controlStore, session.id).read(0);
  assert.equal(events.events[0]?.type, "attachment.attached");
  assert.equal(events.events[0]?.data.attachmentId, summary.attachmentId);
});

test("a repeated request key recovers the same acquisition", async () => {
  const { session, adapter, attach } = await fixture();
  const first = (await attach({})) as Awaited<ReturnType<ManagedSession["attach"]>>;
  const second = (await attach({})) as Awaited<ReturnType<ManagedSession["attach"]>>;
  assert.equal(second.attachmentId, first.attachmentId);
  assert.equal(second.environmentId, first.environmentId);
  // One logical request, one environment: nothing allocated twice.
  const acquisition = session.controlStore.getAcquisitionByRequestKey(
    session.id,
    "worker-1",
  );
  assert.equal(acquisition?.state, "allocated");
  assert.equal(acquisition?.environmentId, first.environmentId);
  assert.equal((await session.describe()).attachments.length, 1);
});

test("a conflicting request under the same key is rejected", async () => {
  const { session, attach } = await fixture();
  await attach({});
  await assert.rejects(
    attach({
      request: {
        name: "worker",
        providerId: "fake-local",
        requires: { "exec.process@1": { engine: { equals: "other-engine" } } },
      },
    }),
    (error: unknown) =>
      isPortableCode(error) &&
      error.code === "RequestConflict" &&
      JSON.stringify(error.details).includes("worker-1"),
  );
  // The original attachment is untouched.
  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "active");
});

test("an attachment name belongs to one attachment per session", async () => {
  const { attach } = await fixture();
  await attach({});
  await assert.rejects(
    attach({ requestKey: "worker-2" }),
    (error: unknown) => isPortableCode(error) && error.code === "RequestConflict",
  );
});

test("a lost response reconciles by identity before any new allocation", async () => {
  const { session, adapter, attach } = await fixture();
  adapter.queueAcquire({ kind: "lost", allocateAnyway: true });
  const summary = (await attach({
    responseTimeoutMs: 50,
  })) as Awaited<ReturnType<ManagedSession["attach"]>>;

  // The environment the provider allocated behind the lost response is
  // the one that activated; nothing was allocated again.
  assert.equal(summary.status, "active");
  assert.equal(summary.environmentId, "env-fake-1");
  const acquisition = session.controlStore.getAcquisitionByRequestKey(
    session.id,
    "worker-1",
  );
  assert.equal(acquisition?.state, "allocated");
  assert.equal(acquisition?.environmentId, "env-fake-1");
  const described = await session.describe();
  assert.deepEqual(described.unresolvedAllocations, []);
});

test("an unidentifiable allocation stays unresolved and is never retried", async () => {
  const { session, adapter, attach } = await fixture();
  adapter.queueAcquire({ kind: "lost", allocateAnyway: false });
  await assert.rejects(
    attach({ responseTimeoutMs: 50 }),
    (error: unknown) => isPortableCode(error) && error.code === "ProviderUnavailable",
  );

  const described = await session.describe();
  assert.equal(described.unresolvedAllocations.length, 1);
  const acquisitionId = described.unresolvedAllocations[0]!;
  assert.equal(described.attachments[0]?.status, "unavailable");
  assert.equal(described.pendingCleanup.length, 1);
  assert.equal(adapter.allocationOf(acquisitionId)?.state, "unknown");

  // A repeated attach behind the same key reconciles; it never sends a
  // second acquire that could allocate silently.
  await assert.rejects(
    attach({ responseTimeoutMs: 50 }),
    (error: unknown) => isPortableCode(error) && error.code === "ProviderUnavailable",
  );
  assert.equal(adapter.allocationOf(acquisitionId)?.state, "unknown");

  // The explicit reconciliation pass behaves the same way.
  await assert.rejects(
    session.reconcileAttachment("worker-1", {
      adapter,
      principal: "user://test",
      authority: AUTHORITY,
    }),
    (error: unknown) => isPortableCode(error) && error.code === "ProviderUnavailable",
  );
  assert.equal(adapter.allocationOf(acquisitionId)?.state, "unknown");
  assert.equal((await session.describe()).unresolvedAllocations.length, 1);
});

test("a provider failure marks the acquisition failed and keeps it visible", async () => {
  const { session, adapter, attach } = await fixture();
  adapter.queueAcquire({ kind: "fail" });
  await assert.rejects(
    attach({}),
    (error: unknown) => isPortableCode(error) && error.code === "ProviderUnavailable",
  );

  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "failed");
  assert.deepEqual(described.unresolvedAllocations, []);
  // The failure owes cleanup attention even with no environment.
  assert.equal(described.pendingCleanup.length, 1);
});

test("a failed validation records a release obligation until cleanup completes", async () => {
  // The offer advertises an engine the manifest will not deliver.
  const offers: EnvironmentOffer[] = [
    {
      providerId: "fake-local",
      platform: { os: "linux", arch: "x64" },
      capabilities: [
        { id: "exec.process@1", attributes: { engine: "promised", maxProcesses: 4 } },
      ],
      resources: { memoryBytes: 1 << 30, storageBytes: 1 << 30 },
      enforcement: { "network.egress": "none", "host.filesystem": true },
      enforcementFacts: {
        executionLocation: "local",
        networkEgress: "none",
        hostFilesystemAccess: false,
      },
    },
  ];
  const { session, adapter, attach } = await fixture({ offers });
  adapter.queueRelease({ kind: "fail-retryable" });

  await assert.rejects(
    attach({ request: {
      name: "worker",
      providerId: "fake-local",
      requires: { "exec.process@1": { engine: { equals: "promised" } } },
    } }),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );

  const described = await session.describe();
  const attachment = described.attachments[0]!;
  assert.equal(attachment.status, "failed");
  // The allocated environment stays named so cleanup can release it.
  assert.equal(attachment.environmentId, "env-fake-1");
  assert.ok(!adapter.isReleased("env-fake-1"));
  assert.equal(described.pendingCleanup.length, 1);
  assert.deepEqual(described.unresolvedAllocations, []);

  // When the release later succeeds, the obligation clears.
  const released = await adapter.lease("env-fake-1").release();
  assert.equal(released.status, "released");
});

test("an expired mutation lease commits nothing, even with an allocation in hand", async () => {
  const { session, adapter, attach } = await fixture();
  adapter.queueAcquire({ kind: "lost", allocateAnyway: true });
  // The mutation lease lapses while the flow waits out the lost response.
  await assert.rejects(
    attach({ responseTimeoutMs: 80, leaseTtlMs: 20 }),
    (error: unknown) => isPortableCode(error) && error.code === "LeaseExpired",
  );

  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "acquiring");
  assert.equal(described.unresolvedAllocations.length, 1);
  // The provider still holds the allocation; only the commit was fenced.
  const environmentId = described.attachments[0]?.environmentId;
  assert.equal(environmentId, undefined);
  const allocation = adapter.allocationOf(described.unresolvedAllocations[0]!);
  assert.equal(allocation?.state, "allocated");
});

test("policy denial precedes every durable effect", async () => {
  const { session, attach } = await fixture();
  const denied = PolicyAuthority.fromPolicy({ schemaVersion: 1, providers: [] });
  await assert.rejects(
    attach({ authority: denied }),
    (error: unknown) => isPortableCode(error) && error.code === "PolicyDenied",
  );
  const described = await session.describe();
  assert.deepEqual(described.attachments, []);
  assert.deepEqual(described.unresolvedAllocations, []);
});

test("reconciliation of an unknown key is an invalid request", async () => {
  const { session, adapter } = await fixture();
  await assert.rejects(
    session.reconcileAttachment("no-such-key", {
      adapter,
      principal: "user://test",
      authority: AUTHORITY,
    }),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
});

// -- R1: the acquisition policy actually gates acquisition ----------------------------

/** One policy denial that names its dimension, for precise assertions. */
function deniedOn(dimension: string): (error: unknown) => boolean {
  return (error: unknown) =>
    isPortableCode(error) &&
    error.code === "PolicyDenied" &&
    (error.details as { dimension?: unknown } | undefined)?.dimension === dimension;
}

/** One offer with the fake engine under a chosen provider identity. */
function offerFrom(providerId: string, facts?: EnvironmentOffer["enforcementFacts"]): EnvironmentOffer {
  return {
    providerId,
    platform: { os: "linux", arch: "x64" },
    capabilities: [
      { id: "exec.process@1", attributes: { engine: "fake-process", maxProcesses: 4 } },
    ],
    ...(facts !== undefined ? { enforcementFacts: facts } : {}),
  };
}

test("an empty provider allow list refuses named and unnamed requests alike", async () => {
  const empty = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: [],
  });
  const { session, adapter, attach } = await fixture();
  await assert.rejects(attach({ authority: empty }), deniedOn("providers"));
  const unnamed = await fixture();
  await assert.rejects(
    unnamed.attach({
      authority: empty,
      request: {
        name: "worker",
        requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
      },
    }),
    deniedOn("providers"),
  );
  // Refusal precedes allocation in both directions.
  assert.equal(adapter.allocationCount(), 0);
  assert.equal(unnamed.adapter.allocationCount(), 0);
  assert.deepEqual((await session.describe()).attachments, []);
});

test("a request without a provider id still crosses the allow list", async () => {
  // The unnamed request cannot name its way past the allow list: when
  // the only matching offer comes from a provider the policy never
  // admitted, discovery refuses it. Before R1 an omitted provider id
  // skipped the allow list entirely.
  const { session, adapter, attach } = await fixture({
    offers: [
      offerFrom("uninvited-host", {
        executionLocation: "local",
        networkEgress: "none",
        hostFilesystemAccess: false,
      }),
    ],
  });
  await assert.rejects(
    attach({
      request: {
        name: "worker",
        requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
      },
    }),
    deniedOn("providers"),
  );
  assert.equal(adapter.allocationCount(), 0);
  const refused = await session.describe();
  assert.equal(refused.attachments[0]?.status, "failed");

  // The same unnamed request crosses when the policy admits the
  // provider discovery selects.
  const allowed = await fixture();
  const summary = (await allowed.attach({
    request: {
      name: "worker",
      requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
    },
  })) as Awaited<ReturnType<ManagedSession["attach"]>>;
  assert.equal(summary.providerId, "fake-local");
  assert.equal(summary.environmentId, "env-fake-1");
  assert.deepEqual((await allowed.session.describe()).pendingCleanup, []);
});

test("an offer without typed enforcement facts never matches", async () => {
  const { session, adapter, attach } = await fixture({ offers: [offerFrom("fake-local")] });
  await assert.rejects(attach({}), deniedOn("enforcementFacts"));
  // The refusal precedes allocation but not reservation: the failed
  // attachment stays visible with its cleanup duty.
  assert.equal(adapter.allocationCount(), 0);
  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "failed");
  assert.equal(described.attachments[0]?.environmentId, undefined);
  assert.equal(described.pendingCleanup.length, 1);
});

test("an execution location the policy does not allow is denied", async () => {
  const remoteOnly = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: ["fake-local"],
    locations: ["remote"],
    maxEnvironmentLifetimeMs: 86_400_000,
  });
  const { session, adapter, attach } = await fixture();
  await assert.rejects(attach({ authority: remoteOnly }), deniedOn("locations"));
  assert.equal(adapter.allocationCount(), 0);
  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "failed");
  assert.equal(described.pendingCleanup.length, 1);
});

test("an environment whose egress exceeds the policy is denied", async () => {
  const noEgress = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: ["fake-local"],
    locations: ["local", "remote"],
    networkEgress: "none",
    maxEnvironmentLifetimeMs: 86_400_000,
  });
  const offers = [
    offerFrom("fake-local", {
      executionLocation: "local",
      networkEgress: "unrestricted",
      hostFilesystemAccess: false,
    }),
  ];
  const { session, adapter, attach } = await fixture({ offers });
  await assert.rejects(attach({ authority: noEgress }), deniedOn("networkEgress"));
  assert.equal(adapter.allocationCount(), 0);
  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "failed");
  assert.equal(described.pendingCleanup.length, 1);
});

test("host filesystem access the policy does not grant is denied", async () => {
  const noHost = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: ["fake-local"],
    locations: ["local", "remote"],
    networkEgress: "unrestricted",
    maxEnvironmentLifetimeMs: 86_400_000,
    hostFilesystemAccess: false,
  });
  const offers = [
    offerFrom("fake-local", {
      executionLocation: "local",
      networkEgress: "unrestricted",
      hostFilesystemAccess: true,
    }),
  ];
  const { session, adapter, attach } = await fixture({ offers });
  await assert.rejects(attach({ authority: noHost }), deniedOn("hostFilesystemAccess"));
  assert.equal(adapter.allocationCount(), 0);
  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "failed");
  assert.equal(described.pendingCleanup.length, 1);
});

test("an offer above the resource ceilings never matches", async () => {
  const tight = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: ["fake-local"],
    locations: ["local", "remote"],
    networkEgress: "unrestricted",
    hostFilesystemAccess: true,
    maxEnvironmentLifetimeMs: 86_400_000,
    maxResources: { memoryBytes: 1 << 20 },
  });
  const { session, adapter, attach } = await fixture();
  // The denial names the first resource above its ceiling.
  await assert.rejects(attach({ authority: tight }), deniedOn("memoryBytes"));
  assert.equal(adapter.allocationCount(), 0);
  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "failed");
  assert.equal(described.pendingCleanup.length, 1);
});

test("a lease beyond the lifetime ceiling is refused at activation", async () => {
  const shortLived = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: ["fake-local"],
    locations: ["local", "remote"],
    networkEgress: "unrestricted",
    hostFilesystemAccess: true,
    maxEnvironmentLifetimeMs: 60_000,
    maxResources: {
      memoryBytes: 4 * 1024 ** 3,
      storageBytes: 4 * 1024 ** 3,
      gpuMemoryBytes: 4 * 1024 ** 3,
    },
  });
  const { session, adapter, attach } = await fixture();
  // The release must fail so the obligation stays visible: a
  // successful best-effort release would satisfy it at once.
  adapter.queueRelease({ kind: "fail-retryable" });
  // The fake's default lease of fifteen minutes outruns the ceiling.
  await assert.rejects(attach({ authority: shortLived }), deniedOn("maxEnvironmentLifetimeMs"));
  // The allocation existed, so it stays visible as a cleanup duty
  // the provider could not take back.
  assert.equal(adapter.allocationCount(), 1);
  assert.ok(!adapter.isReleased("env-fake-1"));
  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "failed");
  assert.equal(described.attachments[0]?.environmentId, "env-fake-1");
  assert.equal(described.pendingCleanup.length, 1);
});

test("an expired lease refuses readmission under the same request key", async () => {
  const { session, adapter, attach } = await fixture();
  adapter.queueAcquire({
    kind: "allocate",
    expiresAt: new Date(Date.now() + 80).toISOString(),
  });
  const first = (await attach({})) as Awaited<ReturnType<ManagedSession["attach"]>>;
  assert.equal(first.status, "active");
  await new Promise((resolve) => setTimeout(resolve, 140));
  await assert.rejects(
    attach({}),
    (error: unknown) => isPortableCode(error) && error.code === "LeaseExpired",
  );
  assert.deepEqual((await session.describe()).pendingCleanup, []);
});

/** One adapter whose leases answer with another provider's manifests. */
class SwappedProviderAdapter implements EnvironmentAdapter {
  readonly id: string;

  constructor(
    private readonly inner: FakeEnvironmentAdapter,
    private readonly claimedProviderId: string,
  ) {
    this.id = inner.id;
  }

  describe(): Promise<EnvironmentOffer[]> {
    return this.inner.describe();
  }

  async acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease> {
    const lease = await this.inner.acquire(request);
    return new SwappedProviderLease(lease, this.claimedProviderId);
  }

  reconcile(acquisitionId: string): Promise<AcquisitionStatus> {
    return this.inner.reconcile(acquisitionId);
  }
}

/** One lease whose manifest claims a provider its offer never named. */
class SwappedProviderLease implements EnvironmentLease {
  constructor(
    private readonly lease: EnvironmentLease,
    private readonly claimedProviderId: string,
  ) {}

  get environmentId(): string {
    return this.lease.environmentId;
  }

  async manifest() {
    const manifest = await this.lease.manifest();
    return { ...manifest, providerId: this.claimedProviderId };
  }

  invoke(request: AdapterInvocation): Promise<AdapterOperation> {
    return this.lease.invoke(request);
  }

  inspect(operationId: string): Promise<AdapterOperationStatus> {
    return this.lease.inspect(operationId);
  }

  cancel(operationId: string): Promise<CancellationResult> {
    return this.lease.cancel(operationId);
  }

  bind(resource: ResourceRef, context: Parameters<EnvironmentLease["bind"]>[1]): Promise<BindingResult> {
    return this.lease.bind(resource, context);
  }

  renew(expiresAt: string): Promise<LeaseStatus> {
    return this.lease.renew(expiresAt);
  }

  release(): Promise<ReleaseResult> {
    return this.lease.release();
  }
}

test("activation pins the provider discovery selected", async () => {
  const runtime = new PortableRuntime(ControlStore.inMemory());
  const session = await runtime.createSession({ policyRef: "policy://test" });
  const inner = new FakeEnvironmentAdapter();
  const impostor = new SwappedProviderAdapter(inner, "impostor-host");
  // Discovery selects fake-local; the manifest then claims another
  // provider. The activation refuses the swap and keeps the
  // allocation visible for cleanup.
  await assert.rejects(
    session.attach({
      adapter: impostor,
      request: {
        name: "worker",
        providerId: "fake-local",
        requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
      },
      requestKey: "pin-1",
      principal: "user://test",
      authority: AUTHORITY,
    }),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
  assert.equal(inner.allocationCount(), 1);
  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "failed");
  assert.equal(described.attachments[0]?.environmentId, "env-fake-1");
  // The best-effort release returned the refused allocation, so the
  // recorded obligation is already satisfied and nothing leaks.
  assert.ok(inner.isReleased("env-fake-1"));
  assert.deepEqual(described.pendingCleanup, []);
});
