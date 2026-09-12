import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../store/control-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import { PolicyAuthority } from "../core/policy.js";
import { FakeEnvironmentAdapter } from "../adapters/test-adapter.js";
import { checkAttachmentAcceptsOperations } from "./lifecycle.js";
import { ManagedSession, PortableRuntime } from "./session.js";
import type { AttachmentSummary } from "../schema/session.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

const HOUR_MS = 60 * 60 * 1000;

const AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  providers: ["fake-local"],
  maxEnvironmentLifetimeMs: 24 * HOUR_MS,
  locations: ["local", "remote"],
  networkEgress: "unrestricted",
  hostFilesystemAccess: true,
  maxResources: {
    memoryBytes: 4 * 1024 ** 3,
    storageBytes: 4 * 1024 ** 3,
    gpuMemoryBytes: 4 * 1024 ** 3,
  },
});

/** One active attachment to work on, plus its handles. */
interface Attached {
  session: ManagedSession;
  adapter: FakeEnvironmentAdapter;
  attachment: AttachmentSummary;
}

async function attached(options: { name?: string; requestKey?: string } = {}): Promise<Attached> {
  const runtime = new PortableRuntime(ControlStore.inMemory());
  const session = await runtime.createSession({ policyRef: "policy://test" });
  const adapter = new FakeEnvironmentAdapter();
  const attachment = await session.attach({
    adapter,
    request: {
      name: options.name ?? "worker",
      providerId: "fake-local",
      requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
    },
    requestKey: options.requestKey ?? "worker-1",
    principal: "user://test",
    authority: AUTHORITY,
  });
  return { session, adapter, attachment };
}

function eventsOf(session: ManagedSession): Array<{ type: string; data: Record<string, unknown> }> {
  return new SessionEventStream(session.controlStore, session.id).read(0).events.map((event) => ({
    type: event.type,
    data: event.data,
  }));
}

test("renewal extends the lease and records the new expiry", async () => {
  const { session, adapter, attachment } = await attached();
  const before = Date.now();
  const outcome = await session.renewAttachment(attachment.attachmentId, {
    adapter,
    principal: "user://test",
    authority: AUTHORITY,
    durationMs: HOUR_MS,
  });
  assert.equal(outcome.status, "renewed");
  const expiresAt = Date.parse(outcome.attachment.leaseExpiresAt ?? "");
  assert.ok(expiresAt > before + 55 * 60 * 1000, "expiry moves an hour out");
  assert.ok(expiresAt < before + 65 * 60 * 1000, "expiry moves no further");

  const stored = (await session.describe()).attachments[0]!;
  assert.equal(stored.status, "active");
  assert.equal(stored.leaseExpiresAt, outcome.attachment.leaseExpiresAt);
  const acquisition = session.controlStore.getAcquisitionForAttachment(
    session.id,
    attachment.attachmentId,
  );
  assert.equal(acquisition?.expiresAt, outcome.attachment.leaseExpiresAt);
});

test("renewal beyond the policy ceiling is denied", async () => {
  const { session, adapter, attachment } = await attached();
  await assert.rejects(
    session.renewAttachment(attachment.attachmentId, {
      adapter,
      principal: "user://test",
      authority: AUTHORITY,
      durationMs: 25 * HOUR_MS,
    }),
    (error: unknown) => isPortableCode(error) && error.code === "PolicyDenied",
  );
  assert.equal((await session.describe()).attachments[0]?.status, "active");
});

test("a provider without renewal support changes nothing", async () => {
  const { session, adapter, attachment } = await attached();
  adapter.queueRenew({ kind: "unsupported" });
  const outcome = await session.renewAttachment(attachment.attachmentId, {
    adapter,
    principal: "user://test",
    authority: AUTHORITY,
    durationMs: HOUR_MS,
  });
  assert.equal(outcome.status, "unsupported");
  // Unsupported renewal changes no lease term: the attachment keeps
  // naming the end its acquisition grant carried.
  assert.match(outcome.attachment.leaseExpiresAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await session.describe()).attachments[0]?.status, "active");
});

test("a refused renewal marks the attachment unavailable, termination unconfirmed", async () => {
  const { session, adapter, attachment } = await attached();
  adapter.queueRenew({ kind: "refuse" });
  adapter.queueRelease({ kind: "fail-retryable" });

  const outcome = await session.renewAttachment(attachment.attachmentId, {
    adapter,
    principal: "user://test",
    authority: AUTHORITY,
    durationMs: HOUR_MS,
  });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.reason, "provider-refused");

  const described = await session.describe();
  const stored = described.attachments[0]!;
  assert.equal(stored.status, "unavailable");
  // The environment stays named: the release is still owed.
  assert.equal(stored.environmentId, attachment.environmentId);
  assert.equal(described.pendingCleanup.length, 1);
  assert.ok(!adapter.isReleased(attachment.environmentId!));

  const expired = eventsOf(session).find((event) => event.type === "lease.expired");
  assert.ok(expired !== undefined);
  assert.equal(expired.data.leaseKind, "environment");
  assert.equal(expired.data.attachmentId, attachment.attachmentId);
  // Runtime authority expired; provider termination is NOT claimed.
  assert.equal(expired.data.providerConfirmedTermination, undefined);
});

test("a refused renewal whose release succeeds ends released", async () => {
  const { session, adapter, attachment } = await attached();
  adapter.queueRenew({ kind: "refuse" });

  const outcome = await session.renewAttachment(attachment.attachmentId, {
    adapter,
    principal: "user://test",
    authority: AUTHORITY,
    durationMs: HOUR_MS,
  });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.reason, "provider-refused-released");

  const described = await session.describe();
  assert.equal(described.attachments[0]?.status, "released");
  assert.deepEqual(described.pendingCleanup, []);
  assert.ok(adapter.isReleased(attachment.environmentId!));
  assert.ok(eventsOf(session).some((event) => event.type === "attachment.released"));
});

test("expiry and unreachability refuse operations with separate codes", async () => {
  const { session, attachment } = await attached();

  // An expired runtime lease is a LeaseExpired refusal.
  const stored = (await session.describe()).attachments[0]!;
  session.controlStore.casAttachment(attachment.attachmentId, { status: stored.status }, {
    ...stored,
    leaseExpiresAt: "2000-01-01T00:00:00Z",
  });
  const expired = checkAttachmentAcceptsOperations(
    session.controlStore.getAttachment(attachment.attachmentId)!,
  );
  assert.ok(isPortableCode(expired) && expired.code === "LeaseExpired");
  assert.ok(JSON.stringify(expired?.details).includes("2000-01-01"));

  // An unreachable attachment is a separate ProviderUnavailable refusal.
  const unavailableRecord = session.controlStore.getAttachment(attachment.attachmentId)!;
  session.controlStore.casAttachment(
    attachment.attachmentId,
    { status: unavailableRecord.status },
    { ...unavailableRecord, status: "unavailable" },
  );
  const unreachable = checkAttachmentAcceptsOperations(
    session.controlStore.getAttachment(attachment.attachmentId)!,
  );
  assert.ok(isPortableCode(unreachable) && unreachable.code === "ProviderUnavailable");

  // Neither refusal claims provider termination.
  assert.equal(JSON.stringify(expired).includes("terminat"), false);
  assert.equal(JSON.stringify(unreachable).includes("terminat"), false);

  // A live attachment accepts operations.
  const fresh = await attached({ name: "fresh", requestKey: "fresh-1" });
  assert.equal(checkAttachmentAcceptsOperations(fresh.attachment), null);
});

test("cleanup survives restart and spares unrelated attachments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-cleanup-"));
  const path = join(dir, "control.db");
  try {
    const store = ControlStore.open(path);
    const runtime = new PortableRuntime(store);
    const session = await runtime.createSession({ policyRef: "policy://test" });
    const adapter = new FakeEnvironmentAdapter();

    const keeper = await session.attach({
      adapter,
      request: {
        name: "keeper",
        providerId: "fake-local",
        requires: { "exec.process@1": {} },
      },
      requestKey: "keeper-1",
      principal: "user://test",
      authority: AUTHORITY,
    });
    const victim = await session.attach({
      adapter,
      request: {
        name: "victim",
        providerId: "fake-local",
        requires: { "exec.process@1": {} },
      },
      requestKey: "victim-1",
      principal: "user://test",
      authority: AUTHORITY,
    });

    // The victim's lease runs out and its release fails once.
    adapter.queueRenew({ kind: "refuse" });
    adapter.queueRelease({ kind: "fail-retryable" });
    const outcome = await session.renewAttachment(victim.attachmentId, {
      adapter,
      principal: "user://test",
      authority: AUTHORITY,
      durationMs: HOUR_MS,
    });
    assert.equal(outcome.status, "unavailable");
    assert.equal((await session.describe()).pendingCleanup.length, 1);

    // Restart: a fresh process opens the same durable state.
    store.close();
    const reopened = ControlStore.open(path);
    const second = new PortableRuntime(reopened);
    const resumed = await second.openSession(session.id);

    const report = await resumed.runCleanup({
      adapter,
      principal: "user://cleanup",
      authority: AUTHORITY,
    });
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0]?.outcome, "satisfied");
    assert.equal(report.remaining, 0);

    const described = await resumed.describe();
    const byName = new Map(described.attachments.map((entry) => [entry.name, entry]));
    // The victim released; the keeper never moved.
    assert.equal(byName.get("victim")?.status, "released");
    assert.equal(byName.get("keeper")?.status, "active");
    assert.equal(byName.get("keeper")?.environmentId, keeper.environmentId);
    assert.ok(adapter.isReleased(victim.environmentId!));
    assert.ok(!adapter.isReleased(keeper.environmentId!));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cleanup pass settles only the providers its adapter offers", async () => {
  const { session, adapter, attachment } = await attached();
  // One unconfirmed release leaves the obligation pending.
  adapter.queueRenew({ kind: "refuse" });
  adapter.queueRelease({ kind: "fail-retryable" });
  const outcome = await session.renewAttachment(attachment.attachmentId, {
    adapter,
    principal: "user://test",
    authority: AUTHORITY,
    durationMs: HOUR_MS,
  });
  assert.equal(outcome.status, "unavailable");
  assert.equal((await session.describe()).pendingCleanup.length, 1);

  // A pass of an adapter that offers a different provider may not
  // confirm this release: the obligation stays pending and the
  // provider is never called.
  const stranger = new FakeEnvironmentAdapter({
    offers: [
      {
        providerId: "fake-remote",
        platform: { os: "linux", arch: "x64" },
        capabilities: [{ id: "exec.process@1", attributes: { engine: "fake-process" } }],
        enforcementFacts: {
          executionLocation: "local",
          networkEgress: "none",
          hostFilesystemAccess: false,
        },
      },
    ],
  });
  const foreign = await session.runCleanup({
    adapter: stranger,
    principal: "user://cleanup",
    authority: AUTHORITY,
  });
  assert.equal(foreign.outcomes.length, 1);
  assert.equal(foreign.outcomes[0]?.outcome, "pending");
  assert.match(foreign.outcomes[0]?.reason ?? "", /belongs to provider fake-local/);
  assert.equal(foreign.remaining, 1);
  assert.equal(stranger.queues.release.length, 0, "the foreign provider was never called");

  // The pass of the owning provider settles it.
  const owned = await session.runCleanup({
    adapter,
    principal: "user://cleanup",
    authority: AUTHORITY,
  });
  assert.equal(owned.outcomes.length, 1);
  assert.equal(owned.outcomes[0]?.outcome, "satisfied");
  assert.equal(owned.remaining, 0);
  assert.equal(
    (await session.describe()).attachments.find((entry) => entry.name === "worker")?.status,
    "released",
  );
});

test("an unresolved allocation never clears without provider truth", async () => {
  const { session, adapter } = await attached();
  // Replace the flow with a lost response that allocates nothing.
  const runtime = new PortableRuntime(session.controlStore);
  void runtime;
  const lost = await (async () => {
    adapter.queueAcquire({ kind: "lost", allocateAnyway: false });
    return session.attach({
      adapter,
      request: {
        name: "ghost",
        providerId: "fake-local",
        requires: { "exec.process@1": {} },
      },
      requestKey: "ghost-1",
      principal: "user://test",
      authority: AUTHORITY,
      responseTimeoutMs: 50,
    }).then(
      () => null,
      (error: unknown) => error,
    );
  })();
  assert.ok(isPortableCode(lost) && lost.code === "ProviderUnavailable");

  const report = await session.runCleanup({
    adapter,
    principal: "user://cleanup",
    authority: AUTHORITY,
  });
  assert.equal(report.outcomes.length, 1);
  // Still unknown at the provider: the obligation stays visible.
  assert.equal(report.outcomes[0]?.outcome, "pending");
  assert.equal(report.remaining, 1);
  assert.equal((await session.describe()).pendingCleanup.length, 1);
});

test("reconciliation settles an allocation a fenced-out flow left behind", async () => {
  const { session, adapter } = await attached();
  // The provider allocated, but the response was lost and the runtime's
  // lease expired before it could commit the activation.
  adapter.queueAcquire({ kind: "lost", allocateAnyway: true });
  const failed = await session
    .attach({
      adapter,
      request: {
        name: "late",
        providerId: "fake-local",
        requires: { "exec.process@1": {} },
      },
      requestKey: "late-1",
      principal: "user://test",
      authority: AUTHORITY,
      responseTimeoutMs: 80,
      leaseTtlMs: 20,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(isPortableCode(failed) && failed.code === "LeaseExpired");
  assert.equal((await session.describe()).unresolvedAllocations.length, 1);

  // A later pass reconciles by identity: the allocation is recovered,
  // never allocated again.
  const recovered = await session.reconcileAttachment("late-1", {
    adapter,
    principal: "user://test",
    authority: AUTHORITY,
  });
  assert.equal(recovered.status, "active");
  const described = await session.describe();
  const late = described.attachments.find((entry) => entry.name === "late");
  assert.equal(late?.status, "active");
  assert.equal(late?.environmentId, recovered.environmentId);
  assert.deepEqual(described.unresolvedAllocations, []);
});
