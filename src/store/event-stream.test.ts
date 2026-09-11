import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "./control-store.js";
import {
  EventDeduplicator,
  SessionEventStream,
  uniqueEventKey,
  validateStoredEvent,
} from "./event-stream.js";

const T0 = "2026-09-11T00:00:00Z";

function seededStore(): ControlStore {
  const store = ControlStore.inMemory();
  store.createSession({
    id: "sess-1",
    schemaVersion: 1,
    status: "open",
    workspaceId: "ws-1",
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: T0,
  });
  store.insertAttachment({
    sessionId: "sess-1",
    attachmentId: "att-1",
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  });
  return store;
}

function isPortableCode(value: unknown): value is { code: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

test("appends validate payloads before any write", () => {
  const store = seededStore();
  const stream = new SessionEventStream(store, "sess-1");
  const event = stream.append("attachment.attached", "att-1", {
    attachmentId: "att-1",
    name: "worker",
    generation: 1,
    environmentId: "env-1",
  });
  assert.equal(event.sequence, 1);
  assert.equal(event.type, "attachment.attached");
  assert.equal(store.getSession("sess-1")?.eventSequence, 1);

  // A payload without its required fields is refused and leaves no event.
  assert.throws(
    () => stream.append("attachment.attached", "att-1", { attachmentId: "att-1" }),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
  assert.equal(stream.currentSequence(), 1);
  // A bad subject identifier is refused by the envelope.
  assert.throws(
    () => stream.append("cleanup.pending", "subject with spaces", {
      cleanupId: "clean-1",
      kind: "release",
      targetId: "att-1",
    }),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
});

test("state and its event commit together or not at all", () => {
  const store = seededStore();
  const stream = new SessionEventStream(store, "sess-1");

  const { result, event } = stream.commitWith(
    "operation.updated",
    "op-1",
    { operationId: "op-1", status: "accepted" },
    () => {
      store.insertOperation(
        {
          id: "op-1",
          attachment: { sessionId: "sess-1", attachmentId: "att-1", generation: 1 },
          capability: "exec.process@1",
          operation: "run",
          inputHash: "b".repeat(64),
          status: "accepted",
        },
        "invoke-1",
      );
      return "recorded";
    },
  );
  assert.equal(result, "recorded");
  assert.equal(event.sequence, 1);
  assert.equal(store.getOperation("op-1")?.status, "accepted");

  // A failing mutation rolls the paired event back with it.
  assert.throws(
    () =>
      stream.commitWith(
        "operation.updated",
        "op-2",
        { operationId: "op-2", status: "failed" },
        () => {
          store.insertOperation(
            {
              id: "op-2",
              attachment: { sessionId: "sess-1", attachmentId: "att-1", generation: 1 },
              capability: "exec.process@1",
              operation: "run",
              inputHash: "c".repeat(64),
              status: "failed",
            },
            "invoke-2",
          );
          throw new Error("dispatch lost");
        },
      ),
    /dispatch lost/,
  );
  assert.equal(store.getOperation("op-2"), null);
  assert.equal(stream.currentSequence(), 1);
  assert.equal(stream.read(0).events.length, 1);
});

test("readers resume by sequence in bounded batches", () => {
  const store = seededStore();
  const stream = new SessionEventStream(store, "sess-1");
  for (let i = 0; i < 5; i += 1) {
    stream.append("operation.output", "op-1", {
      operationId: "op-1",
      stream: "stdout",
      chunkSequence: i,
      truncated: false,
      executionContinued: true,
    });
  }

  const first = stream.read(0, 2);
  assert.deepEqual(
    first.events.map((event) => event.sequence),
    [1, 2],
  );
  assert.equal(first.hasMore, true);
  const second = stream.read(first.lastSequence, 2);
  assert.deepEqual(
    second.events.map((event) => event.sequence),
    [3, 4],
  );
  assert.equal(second.hasMore, true);
  const tail = stream.read(second.lastSequence, 2);
  assert.deepEqual(
    tail.events.map((event) => event.sequence),
    [5],
  );
  assert.equal(tail.hasMore, false);
  assert.equal(tail.lastSequence, 5);
  // An empty batch reports the resume point unchanged.
  const empty = stream.read(5, 2);
  assert.equal(empty.lastSequence, 5);
  assert.equal(empty.hasMore, false);
  assert.throws(() => stream.read(0, 0), (error: unknown) => isPortableCode(error));
});

test("stored events re-validate with their payloads", () => {
  const store = seededStore();
  const stream = new SessionEventStream(store, "sess-1");
  stream.append("attachment.replaced", "att-1", {
    attachmentId: "att-1",
    oldGeneration: 1,
    newGeneration: 2,
    oldEnvironmentId: "env-1",
    newEnvironmentId: "env-2",
    workspaceRevisionId: "rev-1",
    capabilityChanges: { added: [], removed: [] },
    dispositions: [{ subject: "workspace", class: "portable", action: "transfer" }],
  });
  const stored = stream.read(0).events;
  assert.equal(stored.length, 1);
  assert.equal(validateStoredEvent(stored[0]!), null);
  // A tampered payload no longer satisfies its contract.
  const tampered = { ...stored[0]!, data: { attachmentId: "att-1" } };
  const failure = validateStoredEvent(tampered);
  assert.ok(failure);
  assert.equal(failure.code, "InvalidRequest");
});

test("duplicate delivery filters without missing events", () => {
  const store = seededStore();
  const stream = new SessionEventStream(store, "sess-1");
  for (let i = 0; i < 3; i += 1) {
    stream.append("operation.updated", `op-${i}`, { operationId: `op-${i}`, status: "running" });
  }
  const deduplicator = new EventDeduplicator();
  const first = deduplicator.accept(stream.read(0).events);
  assert.equal(first.length, 3);
  assert.equal(deduplicator.size, 3);

  // Redelivery of an overlapping range repeats committed events.
  const redelivered = stream.read(0).events;
  assert.equal(redelivered.length, 3);
  assert.deepEqual(deduplicator.accept(redelivered), []);

  // New events append; a consumer reading from zero sees duplicates and
  // fresh events mixed, and keeps only the new ones.
  stream.append("operation.updated", "op-3", { operationId: "op-3", status: "completed" });
  const mixed = deduplicator.accept(stream.read(0).events);
  assert.deepEqual(
    mixed.map((event) => event.sequence),
    [4],
  );
  assert.equal(deduplicator.size, 4);
  // Event keys are stable per event identity.
  assert.equal(uniqueEventKey(redelivered[0]!), "sess-1:1");
});

test("restart preserves sequence order and continues", () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-events-"));
  const path = join(dir, "control.db");
  const store = ControlStore.open(path);
  store.createSession({
    id: "sess-1",
    schemaVersion: 1,
    status: "open",
    workspaceId: "ws-1",
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: T0,
  });
  const stream = new SessionEventStream(store, "sess-1");
  for (let i = 1; i <= 4; i += 1) {
    stream.append("workspace.checkpointed", `rev-${i}`, {
      revisionId: `rev-${i}`,
      requestKey: `cp-${i}`,
    });
  }
  store.close();

  const reopened = ControlStore.open(path);
  const resumed = new SessionEventStream(reopened, "sess-1");
  assert.deepEqual(
    resumed.read(0).events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(resumed.currentSequence(), 4);
  // Appending after the restart continues the sequence without reuse.
  const next = resumed.append("workspace.checkpointed", "rev-5", {
    revisionId: "rev-5",
    requestKey: "cp-5",
  });
  assert.equal(next.sequence, 5);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("append-only order holds under interleaved writers", () => {
  const store = seededStore();
  const a = new SessionEventStream(store, "sess-1");
  const b = new SessionEventStream(store, "sess-1");
  const seen: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const stream = i % 2 === 0 ? a : b;
    seen.push(stream.append("operation.updated", `op-${i}`, {
      operationId: `op-${i}`,
      status: "running",
    }).sequence);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("a missing session refuses stream use", () => {
  const store = seededStore();
  const ghost = new SessionEventStream(store, "sess-404");
  assert.throws(() => ghost.currentSequence(), (error: unknown) => isPortableCode(error));
  // The store itself reports the missing row for appends.
  assert.throws(
    () => ghost.append("cleanup.pending", "clean-1", { cleanupId: "clean-1", kind: "other", targetId: "x" }),
    (error: unknown) => (error as { kind?: string }).kind === "not-found",
  );
});
