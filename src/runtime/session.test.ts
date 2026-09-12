import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertValid } from "../schema/validate.js";
import { sessionDescriptionSchema } from "../schema/session.js";
import { sessionRecordSchema } from "../schema/session.js";
import { PolicyAuthority } from "../core/policy.js";
import { BlobStore } from "../store/blob-store.js";
import { FakeEnvironmentAdapter } from "../adapters/test-adapter.js";
import { handoffResultSchema } from "../schema/handoff.js";
import type { HandoffResult } from "../schema/handoff.js";
import type { InvocationRequest } from "../schema/operation.js";
import { ControlStore } from "../store/control-store.js";
import { ManagedSession, PortableRuntime } from "./session.js";

const T0 = "2026-09-11T00:00:00Z";

function digestOf(part: string): string {
  return createHash("sha256").update(part).digest("hex");
}

function runtime(): PortableRuntime {
  return new PortableRuntime(ControlStore.inMemory());
}

function isPortableCode(value: unknown): value is { code: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

test("createSession persists an open record with a workspace identity", async () => {
  const rt = runtime();
  const session = await rt.createSession({ policyRef: "policy://alpha" });
  const record = session.record();
  assertValid(sessionRecordSchema, record);
  assert.equal(record.status, "open");
  assert.equal(record.eventSequence, 0);
  assert.equal(record.policyRef, "policy://alpha");
  assert.match(record.id, /^sess-\S+$/);
  assert.match(record.workspaceId, /^ws-\S+$/);
  // The record is durable, not just in memory.
  assert.deepEqual(rt.controlStore.getSession(record.id), record);
  // The workspace starts without a head revision.
  assert.equal(rt.controlStore.getWorkspaceHead(record.workspaceId), null);
});

test("createSession validates options before any write", async () => {
  const rt = runtime();
  await assert.rejects(
    rt.createSession({ policyRef: "" }),
    (error: unknown) => isPortableCode(error),
  );
  await assert.rejects(
    rt.createSession({} as { policyRef: string }),
    (error: unknown) => isPortableCode(error),
  );
  await assert.rejects(
    rt.createSession({ policyRef: "ok", extensions: { "no-dots": 1 } }),
    (error: unknown) => isPortableCode(error),
  );
  // Nothing was written by the refused attempts.
  assert.deepEqual(rt.controlStore.listSessionIds(), []);
});

test("describe reports actual persisted state", async () => {
  const rt = runtime();
  const session = await rt.createSession({ policyRef: "policy://alpha" });
  const store = rt.controlStore;
  const record = session.record();

  // Persisted attachments appear; other sessions' do not.
  store.insertAttachment({
    sessionId: record.id,
    attachmentId: "att-1",
    name: "alpha-worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  });
  store.insertAttachment({
    sessionId: record.id,
    attachmentId: "att-2",
    name: "beta-worker",
    generation: 3,
    status: "replacing",
    capabilityIds: ["exec.process@1"],
  });
  const other = await rt.createSession({ policyRef: "policy://beta" });
  store.insertAttachment({
    sessionId: other.id,
    attachmentId: "att-9",
    name: "alpha-worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  });

  // Unresolved allocations: pending and unknown only.
  store.insertAcquisition(record.id, "acquire-1", {
    acquisitionId: "acq-pending",
    state: "pending",
  });
  store.insertAcquisition(record.id, "acquire-2", {
    acquisitionId: "acq-unknown",
    state: "unknown",
  });
  store.insertAcquisition(record.id, "acquire-3", {
    acquisitionId: "acq-allocated",
    state: "allocated",
  });

  // Pending cleanup only.
  store.insertCleanup(record.id, {
    id: "clean-pending",
    kind: "release",
    targetId: "att-1",
    createdAt: T0,
  });
  store.insertCleanup(
    record.id,
    { id: "clean-done", kind: "other", targetId: "att-2", createdAt: T0 },
    "satisfied",
  );

  const description = await session.describe();
  assertValid(sessionDescriptionSchema, description);
  assert.equal(description.session.id, record.id);
  assert.deepEqual(
    description.attachments.map((attachment) => attachment.name),
    ["alpha-worker", "beta-worker"],
  );
  assert.deepEqual(description.unresolvedAllocations, ["acq-pending", "acq-unknown"]);
  assert.deepEqual(description.pendingCleanup, ["clean-pending"]);
  assert.equal(description.workspace.workspaceId, record.workspaceId);
  assert.equal("headRevisionId" in description.workspace, false);
  // The description claims nothing about harness conversations; its shape
  // is fixed by the schema, which admits no such field.
  assert.deepEqual(Object.keys(description).sort(), [
    "attachments",
    "pendingCleanup",
    "session",
    "unresolvedAllocations",
    "workspace",
  ]);
});

test("describe reflects the workspace head once set", async () => {
  const rt = runtime();
  const session = await rt.createSession({ policyRef: "policy://alpha" });
  const store = rt.controlStore;
  const record = session.record();
  const blob = digestOf("blob");
  store.registerBlob(blob, 1);
  store.markBlobVerified(blob);
  store.insertRevision(
    { id: "rev-1", workspaceId: record.workspaceId, rootHash: digestOf("root"), createdAt: T0 },
    [blob],
  );
  assert.equal(store.casWorkspaceHead(record.workspaceId, null, "rev-1"), true);

  const description = await session.describe();
  assert.equal(description.workspace.headRevisionId, "rev-1");
});

test("attachment names are unique within one session", async () => {
  const rt = runtime();
  const session = await rt.createSession({ policyRef: "policy://alpha" });
  const store = rt.controlStore;
  const seed = (attachmentId: string): void => {
    store.insertAttachment({
      sessionId: session.id,
      attachmentId,
      name: "worker",
      generation: 1,
      status: "active",
      capabilityIds: [],
    });
  };
  seed("att-1");
  assert.throws(() => seed("att-2"), /name/i);
  // The same name in another session is a different scope and succeeds.
  const other = await rt.createSession({ policyRef: "policy://beta" });
  store.insertAttachment({
    sessionId: other.id,
    attachmentId: "att-2",
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: [],
  });
  assert.equal((await other.describe()).attachments.length, 1);
  assert.equal((await session.describe()).attachments.length, 1);
});

test("openSession resolves persisted sessions and rejects unknown ids", async () => {
  const rt = runtime();
  const created = await rt.createSession({ policyRef: "policy://alpha" });
  const reopened = await rt.openSession(created.id);
  assert.ok(reopened instanceof ManagedSession);
  assert.deepEqual((await reopened.describe()).session, created.record());

  await assert.rejects(
    rt.openSession("sess-does-not-exist"),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
});

test("sessions survive restart with their inspection state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-session-"));
  const path = join(dir, "control.db");
  const store = ControlStore.open(path);
  const rt = new PortableRuntime(store);
  const session = await rt.createSession({ policyRef: "policy://alpha" });
  store.insertAttachment({
    sessionId: session.id,
    attachmentId: "att-1",
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  });
  store.insertCleanup(session.id, {
    id: "clean-1",
    kind: "unresolved-allocation",
    targetId: "acq-1",
    createdAt: T0,
  });
  store.close();

  const reopenedStore = ControlStore.open(path);
  const reopenedRuntime = new PortableRuntime(reopenedStore);
  const reopened = await reopenedRuntime.openSession(session.id);
  const description = await reopened.describe();
  assert.equal(description.session.id, session.id);
  assert.equal(description.attachments[0]?.name, "worker");
  assert.deepEqual(description.pendingCleanup, ["clean-1"]);
  reopenedStore.close();
  rmSync(dir, { recursive: true, force: true });
});

// -- SPEC section 15 surface -----------------------------------------------------

const AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  operations: ["exec.process@1/run"],
  transferDestinations: ["local"],
});

/** One facade session with an active worker attachment at generation 1. */
async function facadeSession(): Promise<{
  session: ManagedSession;
  attachmentId: string;
}> {
  const rt = runtime();
  const session = await rt.createSession({ policyRef: "policy://alpha" });
  const attachmentId = "att-facade";
  rt.controlStore.insertAttachment({
    sessionId: session.id,
    attachmentId,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  });
  return { session, attachmentId };
}

/** One run request through the facade. */
function invocation(sessionId: string, attachmentId: string): InvocationRequest {
  return {
    attachment: { sessionId, attachmentId, generation: 1 },
    capability: "exec.process@1",
    operation: "run",
    input: { command: "echo", args: ["hi"] },
    requestKey: `req-${randomUUID()}`,
  };
}

test("invoke exposes the durable operation before completion, and inspection reads it as stored", async () => {
  const { session, attachmentId } = await facadeSession();
  const operation = await session.invoke(invocation(session.id, attachmentId), {
    authority: AUTHORITY,
  });

  // The identifier is durable the moment the call returns; completion
  // has not happened and is not implied.
  assert.equal(operation.status, "accepted");
  assert.equal(session.controlStore.getOperation(operation.id)?.id, operation.id);
  const inspected = await session.inspectOperation(operation.id);
  assert.equal(inspected.status, "accepted");
  assert.deepEqual(inspected.attachment, {
    sessionId: session.id,
    attachmentId,
    generation: 1,
  });

  // Settling changes what inspection reports; nothing else moved.
  const settled = await session.settle(operation.id, {
    kind: "completed",
    resultRef: `op:${operation.id}`,
  });
  assert.equal(settled.status, "completed");
  assert.equal((await session.inspectOperation(operation.id)).status, "completed");
});

test("inspectOperation refuses operations of other sessions", async () => {
  const mine = await facadeSession();
  const theirs = await facadeSession();
  const operation = await theirs.session.invoke(
    invocation(theirs.session.id, theirs.attachmentId),
    { authority: AUTHORITY },
  );
  await assert.rejects(
    mine.session.inspectOperation(operation.id),
    (error: unknown) => isPortableCode(error),
  );
});

test("events iterates the journal in order from a sequence, and stopping changes nothing", async () => {
  const { session, attachmentId } = await facadeSession();
  const first = await session.invoke(invocation(session.id, attachmentId), {
    authority: AUTHORITY,
  });
  const second = await session.invoke(invocation(session.id, attachmentId), {
    authority: AUTHORITY,
  });
  await session.settle(first.id, {
    kind: "completed",
    resultRef: `op:${first.id}`,
  });

  const seen: string[] = [];
  const all = session.controlStore.listEvents(session.id, 0, 1000);
  const total = all.length;
  const lastSequence = all[all.length - 1]!.sequence;
  for await (const event of session.events(0)) {
    seen.push(`${event.sequence}:${event.type}`);
    if (event.sequence === lastSequence) {
      break;
    }
  }
  assert.equal(seen.length, total);
  // Sequences are strictly increasing across the whole journal.
  const sequences = seen.map((entry) => Number.parseInt(entry.split(":")[0]!, 10));
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);

  // Iterating from a midpoint yields exactly the tail, and breaking
  // out settled nothing: the second operation is still accepted.
  const tail: number[] = [];
  for await (const event of session.events(lastSequence - 1)) {
    tail.push(event.sequence);
  }
  assert.deepEqual(tail, [lastSequence]);
  assert.equal((await session.inspectOperation(second.id)).status, "accepted");
});

test("planReplace reports dispositions without moving anything", async () => {
  const rt = runtime();
  const session = await rt.createSession({ policyRef: "policy://alpha" });
  const root = mkdtempSync(join(tmpdir(), "porta-facade-"));
  try {
    const blobs = new BlobStore(join(root, "blobs"), rt.controlStore);
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "app.txt"), "base");
    const checkpoint = await session.checkpoint(
      blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src } },
      { stability: { kind: "locked" } },
    );
    rt.controlStore.insertAttachment({
      sessionId: session.id,
      attachmentId: "att-worker",
      name: "worker",
      generation: 1,
      status: "active",
      capabilityIds: ["exec.process@1"],
    });
    const plan = await session.planReplace({
      source: { sessionId: session.id, attachmentId: "att-worker", generation: 1 },
      destination: { requires: {} },
      workspaceRevisionId: checkpoint.revision.id,
      requiredResources: [],
      reconstruct: [],
      activeOperations: "reject",
      requestKey: "plan-1",
    });
    assert.equal(plan.attachmentId, "att-worker");
    assert.equal(plan.workspaceRevisionId, checkpoint.revision.id);
    assert.deepEqual(plan.blockers, []);
    // Planning moved no attachment and no head.
    assert.equal(rt.controlStore.getAttachment("att-worker")!.status, "active");
    assert.equal(
      rt.controlStore.getWorkspaceHead(session.record().workspaceId),
      checkpoint.revision.id,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replace runs to a completed switch and reports it honestly", async () => {
  const rt = runtime();
  const session = await rt.createSession({ policyRef: "policy://alpha" });
  const root = mkdtempSync(join(tmpdir(), "porta-facade-"));
  try {
    const blobs = new BlobStore(join(root, "blobs"), rt.controlStore);
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "app.txt"), "base");
    const checkpoint = await session.checkpoint(
      blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src } },
      { stability: { kind: "locked" } },
    );
    const adapter = new FakeEnvironmentAdapter();
    const attached = await session.attach({
      adapter,
      request: { name: "worker", requires: {} },
      requestKey: "attach-1",
      principal: "facade-test",
      authority: AUTHORITY,
    });
    assert.equal(attached.status, "active");

    const result = await session.replace(
      {
        source: {
          sessionId: session.id,
          attachmentId: attached.attachmentId,
          generation: 1,
        },
        destination: { requires: {} },
        workspaceRevisionId: checkpoint.revision.id,
        requiredResources: [],
        reconstruct: [],
        activeOperations: "reject",
        requestKey: "replace-1",
      },
      {
        destination: {
          adapter,
          leaseOf: (environmentId) => Promise.resolve(adapter.lease(environmentId)),
          bind: {
            async bind(resource) {
              return { status: "bound", binding: resource };
            },
          },
          blobs,
          copyRoot: join(root, "copy"),
          principal: "facade-test",
          authority: AUTHORITY,
        },
      },
    );
    assert.equal(result.outcome, "completed");
    assert.equal(result.oldGeneration, 1);
    assert.equal(result.newGeneration, 2);
    assert.ok(result.transitionId.length > 0);
    assertValid(handoffResultSchema, result);
    const switched = rt.controlStore.getAttachment(attached.attachmentId)!;
    assert.equal(switched.generation, result.newGeneration);
    assert.equal(switched.status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the facade carries every method SPEC section 15 names", async () => {
  const { session } = await facadeSession();
  const surface = session as unknown as Record<string, unknown>;
  for (const name of [
    "describe",
    "checkpoint",
    "attach",
    "invoke",
    "inspectOperation",
    "cancelOperation",
    "propose",
    "accept",
    "planReplace",
    "replace",
    "resolve",
    "release",
    "events",
    "close",
  ]) {
    assert.equal(typeof surface[name], "function", name);
  }
  const rt = runtime();
  const runtimeSurface = rt as unknown as Record<string, unknown>;
  for (const name of ["createSession", "openSession"]) {
    assert.equal(typeof runtimeSurface[name], "function", name);
  }
});
