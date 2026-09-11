import test from "node:test";
import assert from "node:assert/strict";
import { ControlStore } from "../store/control-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import { PolicyAuthority } from "../core/policy.js";
import { FakeEnvironmentAdapter } from "../adapters/test-adapter.js";
import { ManagedSession, PortableRuntime } from "./session.js";
import type { EnvironmentOffer } from "../schema/capability.js";
import type { AttachOptions } from "./acquisition.js";

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
