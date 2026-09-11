import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ControlStore } from "../store/control-store.js";
import { PolicyAuthority } from "../core/policy.js";
import { FakeEnvironmentAdapter } from "../adapters/test-adapter.js";
import { ManagedSession, PortableRuntime } from "./session.js";
import { admitInvocation } from "./admission.js";
import type { AdmissionOptions } from "./admission.js";
import { runCleanup } from "./lifecycle.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { InvocationRequest } from "../schema/operation.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
async function refuse(run: () => unknown): Promise<{ code: string; details?: unknown } | null> {
  try {
    await run();
  } catch (error) {
    if (isPortableCode(error)) {
      return error;
    }
    throw error;
  }
  return null;
}

const HOUR_MS = 60 * 60 * 1000;

const AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  providers: ["fake-local"],
  maxEnvironmentLifetimeMs: 24 * HOUR_MS,
});

const ADMISSION: AdmissionOptions = {
  authority: PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    operations: ["exec.process@1"],
  }),
};

/** One open session with the named attachments of one fake provider. */
interface Fixture {
  store: ControlStore;
  session: ManagedSession;
  adapter: FakeEnvironmentAdapter;
  attachments: AttachmentSummary[];
}

async function make(names: string[] = ["worker"]): Promise<Fixture> {
  const runtime = new PortableRuntime(ControlStore.inMemory());
  const session = await runtime.createSession({ policyRef: "policy://test" });
  const adapter = new FakeEnvironmentAdapter();
  const attachments: AttachmentSummary[] = [];
  for (const name of names) {
    attachments.push(
      await session.attach({
        adapter,
        request: {
          name,
          providerId: "fake-local",
          requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
        },
        requestKey: name,
        principal: "user://test",
        authority: AUTHORITY,
      }),
    );
  }
  return { store: session.controlStore, session, adapter, attachments };
}

/** Seed one bound resource handle owned by an attachment generation. */
function bind(
  store: ControlStore,
  attachment: AttachmentSummary,
  resourceId: string,
): void {
  store.insertResourceBinding({
    id: resourceId,
    sessionId: attachment.sessionId,
    type: "process.group",
    capability: "exec.process@1",
    owner: {
      sessionId: attachment.sessionId,
      attachmentId: attachment.attachmentId,
      generation: attachment.generation,
    },
    lifetime: "attachment",
    recovery: "none",
    status: "bound",
    boundAt: new Date().toISOString(),
  });
}

/** One admitted invocation against an attachment. */
function admit(
  store: ControlStore,
  sessionId: string,
  attachment: AttachmentSummary,
): string {
  const request: InvocationRequest = {
    attachment: {
      sessionId,
      attachmentId: attachment.attachmentId,
      generation: attachment.generation,
    },
    capability: "exec.process@1",
    operation: "run",
    input: { command: "echo", args: ["hi"] },
    requestKey: `req-${randomUUID()}`,
  };
  return admitInvocation(store, sessionId, request, ADMISSION).operation.id;
}

function eventsOf(fixture: Fixture): Array<{ type: string; data: Record<string, unknown> }> {
  return fixture.store.listEvents(fixture.session.id, 0).map((event) => ({
    type: event.type,
    data: event.data,
  }));
}

test("a confirmed release invalidates owned handles and journals both phases", async () => {
  const fixture = await make();
  const attachment = fixture.attachments[0]!;
  bind(fixture.store, attachment, "res-1");
  bind(fixture.store, attachment, "res-2");

  const outcome = await fixture.session.release(
    { sessionId: fixture.session.id, attachmentId: attachment.attachmentId, generation: 1 },
    "release-1",
    { adapter: fixture.adapter, principal: "user://test" },
  );
  assert.equal(outcome.status, "released");
  assert.ok(attachment.environmentId !== undefined);
  assert.equal(fixture.adapter.isReleased(attachment.environmentId), true);

  const stored = fixture.store.getAttachment(attachment.attachmentId);
  assert.equal(stored?.status, "released");
  const acquisition = fixture.store.getAcquisitionForAttachment(
    fixture.session.id,
    attachment.attachmentId,
  );
  assert.equal(acquisition?.state, "released");

  // Both owned handles are invalidated and stay invalid.
  assert.equal(fixture.store.getResourceBinding(fixture.session.id, "res-1")?.status, "invalidated");
  assert.equal(fixture.store.getResourceBinding(fixture.session.id, "res-2")?.status, "invalidated");
  assert.equal(outcome.status === "released" && outcome.invalidated.length, 2);

  const types = eventsOf(fixture).map((event) => event.type);
  assert.ok(types.includes("attachment.releasing"));
  assert.ok(types.includes("attachment.released"));
  assert.equal(types.filter((type) => type === "resource.invalidated").length, 2);

  // The released attachment refuses new work.
  const refused = await refuse(() =>
    admitInvocation(
      fixture.store,
      fixture.session.id,
      {
        attachment: {
          sessionId: fixture.session.id,
          attachmentId: attachment.attachmentId,
          generation: 1,
        },
        capability: "exec.process@1",
        operation: "run",
        input: {},
        requestKey: `req-${randomUUID()}`,
      },
      ADMISSION,
    ),
  );
  assert.equal(refused?.code, "InvalidRequest");
});

test("a repeated release makes no second provider call", async () => {
  const fixture = await make();
  const attachment = fixture.attachments[0]!;
  bind(fixture.store, attachment, "res-1");

  const first = await fixture.session.release(
    { sessionId: fixture.session.id, attachmentId: attachment.attachmentId, generation: 1 },
    "release-1",
    { adapter: fixture.adapter, principal: "user://test" },
  );
  assert.equal(first.status, "released");

  // The provider would fail the next call; a repeat must not reach it.
  fixture.adapter.queueRelease({ kind: "fail-permanent" });
  const second = await fixture.session.release(
    { sessionId: fixture.session.id, attachmentId: attachment.attachmentId, generation: 1 },
    "release-2",
    { adapter: fixture.adapter, principal: "user://test" },
  );
  assert.equal(second.status, "already-released");
  assert.equal(fixture.adapter.queues.release.length, 1, "the queued failure is untouched");
  assert.equal(second.status === "already-released" && second.invalidated.length, 1);

  const types = eventsOf(fixture).map((event) => event.type);
  assert.equal(types.filter((type) => type === "attachment.released").length, 1);
});

test("an unconfirmed release records an obligation and blocks new work", async () => {
  const fixture = await make();
  const attachment = fixture.attachments[0]!;
  fixture.adapter.queueRelease({ kind: "fail-retryable" });

  const outcome = await fixture.session.release(
    { sessionId: fixture.session.id, attachmentId: attachment.attachmentId, generation: 1 },
    "release-1",
    { adapter: fixture.adapter, principal: "user://test" },
  );
  assert.equal(outcome.status, "unresolved");
  assert.ok(outcome.status === "unresolved" && outcome.obligation.targetId === attachment.environmentId);

  // The attachment stays mid-release and refuses new operations.
  assert.equal(fixture.store.getAttachment(attachment.attachmentId)?.status, "releasing");
  const refused = await refuse(() =>
    admitInvocation(
      fixture.store,
      fixture.session.id,
      {
        attachment: {
          sessionId: fixture.session.id,
          attachmentId: attachment.attachmentId,
          generation: 1,
        },
        capability: "exec.process@1",
        operation: "run",
        input: {},
        requestKey: `req-${randomUUID()}`,
      },
      ADMISSION,
    ),
  );
  assert.equal(refused?.code, "InvalidRequest");

  // The obligation is visible and a cleanup pass settles it once the
  // provider confirms.
  const description = await fixture.session.describe();
  assert.equal(description.pendingCleanup.length, 1);
  const cleanup = await fixture.session.runCleanup({
    adapter: fixture.adapter,
    principal: "user://test",
  });
  assert.equal(cleanup.remaining, 0);
  assert.equal(fixture.store.getAttachment(attachment.attachmentId)?.status, "released");

  // After cleanup confirmed, release answers idempotently.
  const again = await fixture.session.release(
    { sessionId: fixture.session.id, attachmentId: attachment.attachmentId, generation: 1 },
    "release-2",
    { adapter: fixture.adapter, principal: "user://test" },
  );
  assert.equal(again.status, "already-released");
});

test("release refuses stale generations, foreign sessions, and unusable states", async () => {
  const fixture = await make();
  const attachment = fixture.attachments[0]!;

  const stale = await refuse(() =>
    fixture.session.release(
      { sessionId: fixture.session.id, attachmentId: attachment.attachmentId, generation: 7 },
      "release-1",
      { adapter: fixture.adapter, principal: "user://test" },
    ),
  );
  assert.equal(stale?.code, "StaleHandle");

  const foreign = await refuse(() =>
    fixture.session.release(
      { sessionId: "sess-other", attachmentId: attachment.attachmentId, generation: 1 },
      "release-1",
      { adapter: fixture.adapter, principal: "user://test" },
    ),
  );
  assert.equal(foreign?.code, "InvalidRequest");

  const emptyKey = await refuse(() =>
    fixture.session.release(
      { sessionId: fixture.session.id, attachmentId: attachment.attachmentId, generation: 1 },
      "",
      { adapter: fixture.adapter, principal: "user://test" },
    ),
  );
  assert.equal(emptyKey?.code, "InvalidRequest");

  // An attachment still acquiring holds no environment to release.
  const acquiringId = `att-${randomUUID()}`;
  fixture.store.insertAttachment({
    sessionId: fixture.session.id,
    attachmentId: acquiringId,
    name: "late",
    generation: 1,
    status: "acquiring",
    capabilityIds: [],
  });
  const acquiring = await refuse(() =>
    fixture.session.release(
      { sessionId: fixture.session.id, attachmentId: acquiringId, generation: 1 },
      "release-1",
      { adapter: fixture.adapter, principal: "user://test" },
    ),
  );
  assert.equal(acquiring?.code, "InvalidRequest");
});

test("release serializes on the attachment mutation lease", async () => {
  const fixture = await make();
  const attachment = fixture.attachments[0]!;
  const held = fixture.store.acquireMutationLease(
    fixture.session.id,
    attachment.attachmentId,
    "other-controller",
    60_000,
  );
  const blocked = await refuse(() =>
    fixture.session.release(
      { sessionId: fixture.session.id, attachmentId: attachment.attachmentId, generation: 1 },
      "release-1",
      { adapter: fixture.adapter, principal: "user://test" },
    ),
  );
  assert.equal(blocked?.code, "HandoffBlocked");
  assert.equal(fixture.store.getAttachment(attachment.attachmentId)?.status, "active");

  fixture.store.releaseMutationLease(fixture.session.id, attachment.attachmentId, held.fencingToken);
  const after = await fixture.session.release(
    { sessionId: fixture.session.id, attachmentId: attachment.attachmentId, generation: 1 },
    "release-1",
    { adapter: fixture.adapter, principal: "user://test" },
  );
  assert.equal(after.status, "released");
});

test("close releases every attachment, reports in-flight work, and closes", async () => {
  const fixture = await make(["worker", "browser"]);
  const worker = fixture.attachments[0]!;
  const browser = fixture.attachments[1]!;
  const operationId = admit(fixture.store, fixture.session.id, worker);

  const report = await fixture.session.close({
    requestKey: "close-1",
    adapter: fixture.adapter,
    principal: "user://test",
  });
  assert.equal(report.status, "closed");
  assert.equal(report.session.status, "closed");
  assert.deepEqual(
    report.entries.map((entry) => entry.outcome).sort(),
    ["released", "released"],
  );
  assert.equal(fixture.store.getAttachment(worker.attachmentId)?.status, "released");
  assert.equal(fixture.store.getAttachment(browser.attachmentId)?.status, "released");

  // In-flight work is reported, untouched, and never claimed stopped.
  assert.deepEqual(report.inFlightOperations, [
    { operationId, status: "accepted", attachmentId: worker.attachmentId },
  ]);
  assert.equal(fixture.store.getOperation(operationId)?.status, "accepted");

  const types = eventsOf(fixture).map((event) => event.type);
  assert.ok(types.includes("session.closing"));
  assert.ok(types.includes("session.closed"));

  // New work refuses on a closed session.
  const refused = await refuse(() =>
    admitInvocation(
      fixture.store,
      fixture.session.id,
      {
        attachment: {
          sessionId: fixture.session.id,
          attachmentId: browser.attachmentId,
          generation: 1,
        },
        capability: "exec.process@1",
        operation: "run",
        input: {},
        requestKey: `req-${randomUUID()}`,
      },
      ADMISSION,
    ),
  );
  assert.equal(refused?.code, "InvalidRequest");

  // A repeated close reports the settled state without provider calls.
  fixture.adapter.queueRelease({ kind: "fail-permanent" });
  const again = await fixture.session.close({
    requestKey: "close-2",
    adapter: fixture.adapter,
    principal: "user://test",
  });
  assert.equal(again.status, "closed");
  assert.deepEqual(
    again.entries.map((entry) => entry.outcome),
    ["already-released", "already-released"],
  );
  assert.equal(fixture.adapter.queues.release.length, 1, "the queued failure is untouched");
});

test("close records unresolved releases and settles them on retry", async () => {
  const fixture = await make(["worker", "browser"]);
  const worker = fixture.attachments[0]!;
  const browser = fixture.attachments[1]!;

  // One release fails permanently; the failure is recorded as an
  // unresolved obligation, which is what lets the session close.
  fixture.adapter.queueRelease({ kind: "fail-permanent" });
  const first = await fixture.session.close({
    requestKey: "close-1",
    adapter: fixture.adapter,
    principal: "user://test",
  });
  assert.equal(first.status, "closed");
  assert.deepEqual(
    first.entries.map((entry) => entry.outcome).sort(),
    ["released", "unresolved"],
  );
  assert.equal(first.pendingObligations.length, 1);
  // The unconfirmed attachment stays mid-release, never claimed released.
  const midRelease = [worker, browser].find(
    (candidate) => fixture.store.getAttachment(candidate.attachmentId)?.status === "releasing",
  );
  assert.ok(midRelease !== undefined);
  assert.equal(fixture.adapter.isReleased(midRelease.environmentId!), false);

  // New work refuses on the closed session.
  const refused = await refuse(() =>
    admitInvocation(
      fixture.store,
      fixture.session.id,
      {
        attachment: {
          sessionId: fixture.session.id,
          attachmentId: browser.attachmentId,
          generation: 1,
        },
        capability: "exec.process@1",
        operation: "run",
        input: {},
        requestKey: `req-${randomUUID()}`,
      },
      ADMISSION,
    ),
  );
  assert.equal(refused?.code, "InvalidRequest");

  // A cleanup pass confirms the release once the provider allows it.
  const cleanup = await fixture.session.runCleanup({
    adapter: fixture.adapter,
    principal: "user://test",
  });
  assert.equal(cleanup.remaining, 0);
  assert.equal(fixture.store.getAttachment(midRelease.attachmentId)?.status, "released");
  assert.equal(fixture.adapter.isReleased(midRelease.environmentId!), true);
});

test("a throwing release never fails the close sweep", async () => {
  const fixture = await make(["worker", "browser"]);
  const worker = fixture.attachments[0]!;
  const browser = fixture.attachments[1]!;

  // Another controller holds the worker's mutation lease, so its
  // release throws instead of returning.
  const held = fixture.store.acquireMutationLease(
    fixture.session.id,
    worker.attachmentId,
    "other-controller",
    60_000,
  );
  const report = await fixture.session.close({
    requestKey: "close-1",
    adapter: fixture.adapter,
    principal: "user://test",
  });
  assert.equal(report.status, "closed");
  const thrown = report.entries.find((entry) => entry.attachmentId === worker.attachmentId);
  assert.equal(thrown?.outcome, "unresolved");
  assert.ok(thrown?.detail !== undefined);
  const other = report.entries.find((entry) => entry.attachmentId === browser.attachmentId);
  assert.equal(other?.outcome, "released");
  assert.equal(fixture.store.getAttachment(browser.attachmentId)?.status, "released");
  assert.equal(report.pendingObligations.length, 1, "the failure is recorded, not dropped");

  fixture.store.releaseMutationLease(fixture.session.id, worker.attachmentId, held.fencingToken);
  const cleanup = await fixture.session.runCleanup({
    adapter: fixture.adapter,
    principal: "user://test",
  });
  assert.equal(cleanup.remaining, 0);
  assert.equal(fixture.store.getAttachment(worker.attachmentId)?.status, "released");
});

test("close records unresolved allocations explicitly", async () => {
  const fixture = await make();
  fixture.store.insertAcquisition(
    fixture.session.id,
    "lost-attach",
    { acquisitionId: "acq-lost", state: "unknown" },
  );

  const report = await fixture.session.close({
    requestKey: "close-1",
    adapter: fixture.adapter,
    principal: "user://test",
  });
  assert.equal(report.status, "closed");
  const obligation = fixture.store
    .listCleanup(fixture.session.id, "pending")
    .find((entry) => entry.record.targetId === "acq-lost");
  assert.ok(obligation !== undefined, "the unresolved allocation is recorded");
  assert.equal(obligation.record.kind, "unresolved-allocation");
});

test("reopen reconciles expired leases and reports durable truth only", async () => {
  const fixture = await make();
  const attachment = fixture.attachments[0]!;
  const operationId = admit(fixture.store, fixture.session.id, attachment);

  // Force the durable expiry past; the provider side is untouched.
  const stored = fixture.store.getAttachment(attachment.attachmentId)!;
  fixture.store.casAttachment(
    attachment.attachmentId,
    { status: stored.status },
    { ...stored, leaseExpiresAt: "2000-01-01T00:00:00Z" },
  );

  const report = await fixture.session.reopen();
  assert.equal(report.conversationRestored, false);
  assert.equal(report.session.status, "open");

  const state = report.attachments[0]!;
  assert.equal(state.lease, "expired");
  assert.equal(state.attachment.status, "unavailable");
  assert.equal(state.needsReconciliation, true);

  const types = eventsOf(fixture).map((event) => event.type);
  assert.ok(types.includes("lease.expired"));
  const description = await fixture.session.describe();
  assert.equal(description.pendingCleanup.length, 1, "a release obligation is owed");

  // The in-flight operation is reported exactly as stored.
  assert.deepEqual(report.inFlightOperations, [
    { operationId, status: "accepted", attachmentId: attachment.attachmentId },
  ]);
  assert.equal(fixture.store.getOperation(operationId)?.status, "accepted");
});

test("reopen never changes the session status and never restores a conversation", async () => {
  const fixture = await make();
  const attachment = fixture.attachments[0]!;

  // A closing session reopens to durable state only.
  fixture.store.casSessionStatus(fixture.session.id, ["open"], "closing");
  const closing = await fixture.session.reopen();
  assert.equal(closing.session.status, "closing");
  assert.equal(closing.conversationRestored, false);
  assert.equal(closing.attachments[0]?.attachment.status, "active");
  assert.equal(closing.attachments[0]?.lease, "none");
  assert.equal(closing.attachments[0]?.needsReconciliation, false);

  // After a full close, reopening still reports honestly.
  fixture.store.casSessionStatus(fixture.session.id, ["closing"], "open");
  await fixture.session.close({
    requestKey: "close-1",
    adapter: fixture.adapter,
    principal: "user://test",
  });
  const closed = await fixture.session.reopen();
  assert.equal(closed.session.status, "closed");
  assert.equal(closed.conversationRestored, false);
  assert.equal(closed.attachments[0]?.attachment.status, "released");
  assert.equal(closed.attachments[0]?.lease, "none");

  // A missing session refuses.
  const missing = await refuse(() =>
    new ManagedSession(fixture.store, "sess-missing").reopen(),
  );
  assert.equal(missing?.code, "InvalidRequest");
});
