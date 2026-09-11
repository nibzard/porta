import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { nowUtcTimestamp } from "../core/time.js";
import { ValidationError } from "../schema/validate.js";
import type { AttachmentSummary, SessionRecord } from "../schema/session.js";
import type { OperationRecord } from "../schema/operation.js";
import type { WorkspaceRevision } from "../schema/workspace.js";
import { ControlStore, StoreError } from "./control-store.js";

const execFileAsync = promisify(execFile);

/** Directory of this compiled test file, where the worker script lives too. */
function repoRootOf(moduleUrl: string): string {
  return fileURLToPath(new URL(".", moduleUrl));
}

const T0 = "2026-09-11T00:00:00Z";

function digestOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-1",
    schemaVersion: 1,
    status: "open",
    workspaceId: "ws-1",
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: T0,
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<AttachmentSummary> = {}): AttachmentSummary {
  return {
    sessionId: "sess-1",
    attachmentId: "att-1",
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
    ...overrides,
  };
}

function makeOperation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "op-1",
    attachment: { sessionId: "sess-1", attachmentId: "att-1", generation: 1 },
    capability: "exec.process@1",
    operation: "run",
    inputHash: digestOf("input"),
    status: "accepted",
    ...overrides,
  };
}

function makeRevision(overrides: Partial<WorkspaceRevision> = {}): WorkspaceRevision {
  return {
    id: "rev-1",
    workspaceId: "ws-1",
    rootHash: digestOf("root"),
    createdAt: T0,
    ...overrides,
  };
}

function isStoreError(value: unknown): value is { kind: string } {
  return value instanceof StoreError;
}

test("sessions round-trip and start with no workspace head", () => {
  const store = ControlStore.inMemory();
  const session = makeSession();
  store.createSession(session);
  assert.deepEqual(store.getSession("sess-1"), session);
  assert.equal(store.getWorkspaceHead("ws-1"), null);
  assert.equal(store.getSession("missing"), null);
});

test("a duplicate session id fails with a unique error", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  assert.throws(
    () => store.createSession(makeSession({ workspaceId: "ws-2" })),
    (error: unknown) => isStoreError(error) && error.kind === "unique",
  );
  // The losing write left nothing behind.
  assert.equal(store.getWorkspaceHead("ws-2"), null);
});

test("an invalid record fails before any write", () => {
  const store = ControlStore.inMemory();
  assert.throws(
    () => store.createSession(makeSession({ createdAt: "not-a-timestamp" })),
    ValidationError,
  );
  assert.equal(store.getSession("sess-1"), null);
});

test("session status moves only along expected values", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  const closing = store.casSessionStatus("sess-1", ["open"], "closing");
  assert.equal(closing?.status, "closing");
  assert.equal(store.getSession("sess-1")?.status, "closing");
  // Open is no longer expected, so the same request now fails.
  assert.equal(store.casSessionStatus("sess-1", ["open"], "closing"), null);
  assert.equal(store.casSessionStatus("sess-1", ["closing"], "closed")?.status, "closed");
  assert.throws(() => store.casSessionStatus("missing", ["open"], "closed"), StoreError);
});

test("events append atomically with the session sequence", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  const first = store.appendEvent("sess-1", "attachment.attached", "att-1", { name: "worker" });
  const second = store.appendEvent("sess-1", "operation.updated", "op-1", { status: "accepted" });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  // The record kept pace with the sequence column.
  assert.equal(store.getSession("sess-1")?.eventSequence, 2);
  const all = store.listEvents("sess-1", 0);
  assert.deepEqual(all.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(store.listEvents("sess-1", 1).map((event) => event.sequence), [2]);
  assert.throws(() => store.appendEvent("missing", "cleanup.pending", "x", {}), StoreError);
});

test("attachments enforce unique names and CAS on observed state", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  store.insertAttachment(makeAttachment());
  assert.throws(
    () => store.insertAttachment(makeAttachment({ attachmentId: "att-2" })),
    (error: unknown) => isStoreError(error) && error.kind === "unique",
  );
  // A name reuse in a different session is fine; attachment ids stay global.
  store.createSession(makeSession({ id: "sess-2", workspaceId: "ws-2" }));
  store.insertAttachment(makeAttachment({ sessionId: "sess-2", attachmentId: "att-2" }));
  assert.equal(store.getAttachmentByName("sess-1", "worker")?.attachmentId, "att-1");
  assert.equal(store.listAttachments("sess-1").length, 1);
  // An attachment without a session row is rejected by the foreign key.
  assert.throws(
    () => store.insertAttachment(makeAttachment({ sessionId: "ghost" })),
    StoreError,
  );

  // Stale generation loses the compare-and-swap.
  const updated = makeAttachment({ generation: 2, environmentId: "env-9" });
  assert.equal(store.casAttachment("att-1", { generation: 1 }, updated)?.generation, 2);
  const stale = makeAttachment({ generation: 3 });
  assert.equal(store.casAttachment("att-1", { generation: 1 }, stale), null);
  assert.equal(store.getAttachment("att-1")?.environmentId, "env-9");
});

test("acquisitions and operations deduplicate by request key", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  store.insertAttachment(makeAttachment());
  store.insertAcquisition("sess-1", "acquire-1", { acquisitionId: "acq-1", state: "pending" });
  assert.throws(
    () => store.insertAcquisition("sess-1", "acquire-1", { acquisitionId: "acq-2", state: "pending" }),
    (error: unknown) => isStoreError(error) && error.kind === "unique",
  );
  assert.equal(store.getAcquisitionByRequestKey("sess-1", "acquire-1")?.acquisitionId, "acq-1");
  assert.equal(
    store.casAcquisition("acq-1", { state: "pending" }, { acquisitionId: "acq-1", state: "allocated" })?.state,
    "allocated",
  );
  assert.equal(store.casAcquisition("acq-1", { state: "pending" }, { acquisitionId: "acq-1", state: "failed" }), null);

  const operation = makeOperation();
  store.insertOperation(operation, "invoke-1");
  assert.throws(
    () => store.insertOperation(makeOperation({ inputHash: digestOf("other") }), "invoke-1"),
    (error: unknown) => isStoreError(error) && error.kind === "unique",
  );
  // The existing record is recovered by key, not re-created.
  assert.equal(store.getOperationByRequestKey("sess-1", "invoke-1")?.id, "op-1");
  assert.equal(
    store.casOperation("op-1", { status: "accepted" }, makeOperation({ status: "running" }))?.status,
    "running",
  );
  assert.equal(store.casOperation("op-1", { status: "accepted" }, makeOperation({ status: "failed" })), null);
});

test("transitions and cleanup obligations persist and advance", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  store.insertTransition({
    id: "tr-1",
    sessionId: "sess-1",
    attachmentId: "att-1",
    phase: "planning",
    data: { sourceGeneration: 1 },
    updatedAt: T0,
  });
  assert.equal(store.getTransition("tr-1")?.phase, "planning");
  assert.equal(
    store.casTransition("tr-1", { phase: "planning" }, {
      id: "tr-1",
      sessionId: "sess-1",
      attachmentId: "att-1",
      phase: "preparing",
      data: {},
      updatedAt: T0,
    })?.phase,
    "preparing",
  );
  assert.equal(
    store.casTransition("tr-1", { phase: "planning" }, {
      id: "tr-1",
      sessionId: "sess-1",
      attachmentId: "att-1",
      phase: "switching",
      data: {},
      updatedAt: T0,
    }),
    null,
  );

  store.insertCleanup("sess-1", {
    id: "clean-1",
    kind: "release",
    targetId: "att-1",
    createdAt: T0,
  });
  const pending = store.listCleanup("sess-1", "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.record.targetId, "att-1");
  assert.equal(store.casCleanupStatus("clean-1", "pending", "satisfied"), "satisfied");
  assert.equal(store.listCleanup("sess-1", "pending").length, 0);
  assert.equal(store.casCleanupStatus("clean-1", "pending", "satisfied"), null);
});

test("revisions reference only verified blobs", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  const revision = makeRevision();
  const blob = digestOf("blob-a");

  // Missing blob: the revision cannot commit.
  assert.throws(
    () => store.insertRevision(revision, [blob]),
    (error: unknown) => isStoreError(error) && error.kind === "integrity",
  );
  assert.equal(store.getRevision("rev-1"), null);

  // Registered but unverified: still refused.
  store.registerBlob(blob, 12);
  assert.equal(store.isBlobVerified(blob), false);
  assert.throws(
    () => store.insertRevision(revision, [blob]),
    (error: unknown) => isStoreError(error) && error.kind === "integrity",
  );
  assert.equal(store.getRevision("rev-1"), null);

  // Verified: the revision commits.
  store.markBlobVerified(blob);
  store.insertRevision(revision, [blob, blob]);
  assert.equal(store.getRevision("rev-1")?.rootHash, revision.rootHash);

  // Verification of an unknown blob is an error, not a no-op.
  assert.throws(() => store.markBlobVerified(digestOf("unknown")), StoreError);
});

test("the workspace head moves only under the expected value", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  store.registerBlob(digestOf("a"), 1);
  store.markBlobVerified(digestOf("a"));
  store.insertRevision(makeRevision(), [digestOf("a")]);
  store.registerBlob(digestOf("b"), 1);
  store.markBlobVerified(digestOf("b"));
  store.insertRevision(makeRevision({ id: "rev-2", parentId: "rev-1" }), [digestOf("b")]);

  assert.equal(store.casWorkspaceHead("ws-1", null, "rev-1"), true);
  // A stale writer still expects null and must lose.
  assert.equal(store.casWorkspaceHead("ws-1", null, "rev-2"), false);
  assert.equal(store.getWorkspaceHead("ws-1"), "rev-1");
  assert.equal(store.casWorkspaceHead("ws-1", "rev-1", "rev-2"), true);
  assert.equal(store.getWorkspaceHead("ws-1"), "rev-2");
  // A second session on the same workspace keeps the existing head.
  store.createSession(makeSession({ id: "sess-2" }));
  assert.equal(store.getWorkspaceHead("ws-1"), "rev-2");
});

test("proposals persist with their source attachment", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  store.insertProposal("ws-1", {
    id: "prop-1",
    baseRevisionId: "rev-1",
    candidateRevisionId: "rev-2",
    source: { sessionId: "sess-1", attachmentId: "att-1", generation: 1 },
    operationIds: ["op-1"],
  });
  assert.equal(store.getProposal("prop-1")?.source.generation, 1);
  assert.equal(store.getProposal("missing"), null);
});

test("a thrown body rolls the whole transaction back", () => {
  const store = ControlStore.inMemory();
  store.createSession(makeSession());
  assert.throws(
    () =>
      store.transaction(() => {
        store.insertAttachment(makeAttachment());
        throw new Error("interrupted");
      }),
    /interrupted/,
  );
  assert.equal(store.getAttachment("att-1"), null);
  // The store still works after a rollback.
  store.insertAttachment(makeAttachment());
  assert.equal(store.getAttachment("att-1")?.status, "active");
});

test("restart preserves every durable record", () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-restart-"));
  const path = join(dir, "control.db");
  const store = ControlStore.open(path);
  store.createSession(makeSession());
  store.insertAttachment(makeAttachment());
  store.insertOperation(makeOperation(), "invoke-1");
  store.insertTransition({
    id: "tr-1",
    sessionId: "sess-1",
    attachmentId: "att-1",
    phase: "planning",
    data: {},
    updatedAt: T0,
  });
  store.insertCleanup("sess-1", {
    id: "clean-1",
    kind: "unresolved-allocation",
    targetId: "acq-1",
    createdAt: T0,
  });
  store.appendEvent("sess-1", "attachment.attached", "att-1", { name: "worker" });
  store.appendEvent("sess-1", "cleanup.pending", "clean-1", {});
  store.registerBlob(digestOf("a"), 1);
  store.markBlobVerified(digestOf("a"));
  store.insertRevision(makeRevision(), [digestOf("a")]);
  store.casWorkspaceHead("ws-1", null, "rev-1");
  store.close();

  const again = ControlStore.open(path);
  assert.equal(again.getSession("sess-1")?.id, "sess-1");
  assert.equal(again.getAttachment("att-1")?.name, "worker");
  assert.equal(again.getOperationByRequestKey("sess-1", "invoke-1")?.id, "op-1");
  assert.equal(again.getTransition("tr-1")?.phase, "planning");
  assert.equal(again.listCleanup("sess-1", "pending").length, 1);
  assert.deepEqual(
    again.listEvents("sess-1", 0).map((event) => event.sequence),
    [1, 2],
  );
  assert.equal(again.getRevision("rev-1")?.rootHash, digestOf("root"));
  assert.equal(again.getWorkspaceHead("ws-1"), "rev-1");
  assert.equal(again.isBlobVerified(digestOf("a")), true);
  // Sequencing continues where it stopped.
  assert.equal(again.appendEvent("sess-1", "lease.expired", "att-1", {}).sequence, 3);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test("two processes on one file share uniqueness and fencing", () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-race-"));
  const path = join(dir, "control.db");
  const alpha = ControlStore.open(path);
  const beta = ControlStore.open(path);

  alpha.createSession(makeSession());
  // Both processes race to create the same session: exactly one wins.
  assert.throws(
    () => beta.createSession(makeSession()),
    (error: unknown) => isStoreError(error) && error.kind === "unique",
  );

  alpha.insertAttachment(makeAttachment());
  // Beta advances the generation first.
  const advanced = makeAttachment({ generation: 2 });
  assert.equal(beta.casAttachment("att-1", { generation: 1 }, advanced)?.generation, 2);
  // Alpha, still holding generation 1, must lose its update.
  assert.equal(alpha.casAttachment("att-1", { generation: 1 }, makeAttachment({ generation: 3 })), null);
  assert.equal(alpha.getAttachment("att-1")?.generation, 2);

  // Event sequences stay unique and gapless under interleaving.
  const a1 = alpha.appendEvent("sess-1", "operation.updated", "op-1", { from: "alpha" });
  const b1 = beta.appendEvent("sess-1", "operation.updated", "op-2", { from: "beta" });
  const sequences = new Set([a1.sequence, b1.sequence]);
  assert.equal(sequences.size, 2);
  assert.deepEqual(
    alpha.listEvents("sess-1", 0).map((event) => event.sequence),
    [1, 2],
  );

  alpha.close();
  beta.close();
  rmSync(dir, { recursive: true, force: true });
});

test("real operating-system processes race safely on one file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-procs-"));
  const path = join(dir, "control.db");
  const workerCount = 4;
  const results = await Promise.all(
    Array.from({ length: workerCount }, (_, index) =>
      execFileAsync(process.execPath, [
        join(repoRootOf(import.meta.url), "concurrency-worker.js"),
        path,
        `w${index}`,
      ]).then(({ stdout }) => JSON.parse(stdout.trim()) as { worker: string; won: boolean; sequences: number[] }),
    ),
  );

  // Exactly one worker created the session.
  assert.equal(results.filter((result) => result.won).length, 1);
  // Every event landed; sequences are unique and gapless from 1.
  const all = results.flatMap((result) => result.sequences).sort((a, b) => a - b);
  assert.equal(all.length, workerCount * 3);
  assert.deepEqual(all, Array.from({ length: all.length }, (_, i) => i + 1));

  // An independent reader sees the same committed history.
  const reader = ControlStore.open(path);
  assert.deepEqual(
    reader.listEvents("sess-race", 0).map((event) => event.sequence),
    all,
  );
  reader.close();
  rmSync(dir, { recursive: true, force: true });
});
