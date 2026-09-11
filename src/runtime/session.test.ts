import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assertValid } from "../schema/validate.js";
import { sessionDescriptionSchema } from "../schema/session.js";
import { sessionRecordSchema } from "../schema/session.js";
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
