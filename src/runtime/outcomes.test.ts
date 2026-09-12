import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portableError } from "../core/errors.js";
import { PolicyAuthority } from "../core/policy.js";
import type { InvocationRequest, OperationRecord } from "../schema/operation.js";
import type { AttachmentSummary } from "../schema/session.js";
import { ControlStore } from "../store/control-store.js";
import { admitInvocation } from "./admission.js";
import type { AdmissionOptions } from "./admission.js";
import {
  claimOperationDispatch,
  reconcileOperation,
  settleOperation,
} from "./outcomes.js";
import type { ReconciliationTrail } from "./outcomes.js";

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
    run();
  } catch (error) {
    if (isPortableCode(error)) {
      return error;
    }
    throw error;
  }
  return null;
}

const AUTHORITY: AdmissionOptions = {
  authority: PolicyAuthority.fromPolicy({
    schemaVersion: 1,
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
  }),
};

/** One session with one active attachment and one admitted operation. */
function setup(): {
  store: ControlStore;
  sessionId: string;
  attachmentId: string;
  operation: OperationRecord;
} {
  const store = ControlStore.inMemory();
  const sessionId = `sess-${randomUUID()}`;
  const attachmentId = `att-${randomUUID()}`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId: `ws-${randomUUID()}`,
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: new Date().toISOString(),
  });
  const attachment: AttachmentSummary = {
    sessionId,
    attachmentId,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  };
  store.insertAttachment(attachment);
  const request: InvocationRequest = {
    attachment: { sessionId, attachmentId, generation: 1 },
    capability: "exec.process@1",
    operation: "run",
    input: { command: "sh", args: ["-c", "exit 3"] },
    requestKey: "invoke-1",
  };
  const admitted = admitInvocation(store, sessionId, request, AUTHORITY);
  return { store, sessionId, attachmentId, operation: admitted.operation };
}

test("the dispatch claim is won once; later callers adopt the record", async () => {
  const parts = setup();

  // The first claim owns the provider call: the record moves to
  // running inside the claiming transaction.
  const won = claimOperationDispatch(parts.store, parts.sessionId, parts.operation.id);
  assert.equal(won.claimed, true);
  assert.equal(won.operation.status, "running");
  assert.equal(parts.store.getOperation(parts.operation.id)?.status, "running");

  // A concurrent caller loses the claim and reads the record as it
  // stands; no second running event lands.
  const lost = claimOperationDispatch(parts.store, parts.sessionId, parts.operation.id);
  assert.equal(lost.claimed, false);
  assert.equal(lost.operation.status, "running");
  const started = parts.store
    .listEvents(parts.sessionId, 0)
    .filter(
      (event) =>
        event.type === "operation.updated" &&
        (event.data as { status?: string }).status === "running",
    );
  assert.equal(started.length, 1);

  // Settle completed, then claim again: the settled answer returns as
  // data, and the unsafe effect never replays.
  const done = settleOperation(parts.store, parts.sessionId, parts.operation.id, {
    kind: "completed",
    resultRef: "result://exit-3",
  });
  assert.equal(done.status, "completed");
  const replay = claimOperationDispatch(parts.store, parts.sessionId, parts.operation.id);
  assert.equal(replay.claimed, false);
  assert.equal(replay.operation.status, "completed");
  assert.equal(replay.operation.resultRef, "result://exit-3");
});

test("one claim wins across separate store connections", async () => {
  const root = mkdtempSync(join(tmpdir(), "porta-outcomes-"));
  try {
    // Two connections over one database file: the same shape as two
    // executor processes sharing a store.
    const db = join(root, "control.db");
    const writer = ControlStore.open(db);
    const sessionId = `sess-${randomUUID()}`;
    const attachmentId = `att-${randomUUID()}`;
    writer.createSession({
      id: sessionId,
      schemaVersion: 1,
      status: "open",
      workspaceId: `ws-${randomUUID()}`,
      eventSequence: 0,
      policyRef: "policy://test",
      createdAt: new Date().toISOString(),
    });
    writer.insertAttachment({
      sessionId,
      attachmentId,
      name: "worker",
      generation: 1,
      status: "active",
      capabilityIds: ["exec.process@1"],
    });
    const admitted = admitInvocation(
      writer,
      sessionId,
      {
        attachment: { sessionId, attachmentId, generation: 1 },
        capability: "exec.process@1",
        operation: "run",
        input: { command: "sh", args: ["-c", "exit 0"] },
        requestKey: "invoke-1",
      },
      AUTHORITY,
    );

    const reader = ControlStore.open(db);
    const first = claimOperationDispatch(writer, sessionId, admitted.operation.id);
    const second = claimOperationDispatch(reader, sessionId, admitted.operation.id);
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(second.operation.status, "running");

    // The loser that arrives after settlement reads the answer as
    // data; the provider is never reached again.
    settleOperation(writer, sessionId, admitted.operation.id, {
      kind: "completed",
      resultRef: "result://once",
    });
    const third = claimOperationDispatch(reader, sessionId, admitted.operation.id);
    assert.equal(third.claimed, false);
    assert.equal(third.operation.status, "completed");
    assert.equal(third.operation.resultRef, "result://once");

    reader.close();
    writer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nonzero exit is a completed operation, not a transport failure", async () => {
  const parts = setup();
  claimOperationDispatch(parts.store, parts.sessionId, parts.operation.id);

  // The process exited 3: the operation completed with that exit code.
  const exited = settleOperation(parts.store, parts.sessionId, parts.operation.id, {
    kind: "completed",
    resultRef: "result://exit-3",
    extensions: { "provider.process-exit": 3 },
  });
  assert.equal(exited.status, "completed");
  assert.equal(exited.resultRef, "result://exit-3");
  assert.equal(exited.error, undefined);

  // Re-settling the same outcome changes nothing; a transport-style
  // failure for the same run refuses: the record keeps its outcome.
  const same = settleOperation(parts.store, parts.sessionId, parts.operation.id, {
    kind: "completed",
    resultRef: "result://exit-3",
  });
  assert.equal(same.status, "completed");
  assert.equal(same.id, exited.id);
  const reinterpreted = await refuse(() =>
    settleOperation(parts.store, parts.sessionId, parts.operation.id, {
      kind: "failed",
      error: portableError("ProviderUnavailable", "The response was lost."),
    }),
  );
  assert.ok(reinterpreted !== null && reinterpreted.code === "InvalidRequest");
  assert.ok(JSON.stringify(reinterpreted.details).includes("operation-settled"));
  // One completed event, one completion only.
  const completions = parts.store
    .listEvents(parts.sessionId, 0)
    .filter(
      (event) =>
        event.type === "operation.updated" &&
        (event.data as { status?: string }).status === "completed",
    );
  assert.equal(completions.length, 1);
});

test("a lost response after possible effects becomes unknown, not cancelled", async () => {
  const parts = setup();
  claimOperationDispatch(parts.store, parts.sessionId, parts.operation.id);

  // The response never came back. Effects may have happened, so the
  // outcome is unknown; the timeout proves no cancellation.
  const lost = settleOperation(parts.store, parts.sessionId, parts.operation.id, {
    kind: "unknown",
    error: portableError("ProviderUnavailable", "The response was lost after dispatch.", {
      details: { cause: "timeout" },
    }),
  });
  assert.equal(lost.status, "unknown");
  assert.equal(lost.error?.code, "ProviderUnavailable");

  // An unknown record does not settle directly: only reconciliation
  // with evidence resolves it.
  const direct = await refuse(() =>
    settleOperation(parts.store, parts.sessionId, parts.operation.id, {
      kind: "completed",
      resultRef: "result://late",
    }),
  );
  assert.ok(direct !== null && direct.code === "InvalidRequest");
  assert.ok(JSON.stringify(direct.details).includes("operation-needs-reconciliation"));

  // A claim on an unknown record never dispatches: only
  // reconciliation with evidence resolves it.
  const redispatch = claimOperationDispatch(parts.store, parts.sessionId, parts.operation.id);
  assert.equal(redispatch.claimed, false);
  assert.equal(redispatch.operation.status, "unknown");
});

test("reconciliation appends evidence and preserves the original unknown", async () => {
  const parts = setup();
  claimOperationDispatch(parts.store, parts.sessionId, parts.operation.id);
  const uncertainty = portableError("ProviderUnavailable", "The response was lost.", {
    details: { cause: "timeout" },
  });
  settleOperation(parts.store, parts.sessionId, parts.operation.id, {
    kind: "unknown",
    error: uncertainty,
  });

  // A first pass that learns nothing leaves the uncertainty standing
  // and records what it saw.
  const still = reconcileOperation(parts.store, parts.sessionId, parts.operation.id, {
    kind: "still-unknown",
    detail: "The provider reports the process list without the operation.",
  });
  assert.equal(still.status, "unknown");

  // A second pass resolves it with evidence.
  const resolved = reconcileOperation(parts.store, parts.sessionId, parts.operation.id, {
    kind: "completed",
    resultRef: "result://exit-0",
    detail: "The provider logs show the process exited 0.",
  });
  assert.equal(resolved.status, "completed");
  assert.equal(resolved.resultRef, "result://exit-0");

  // The record keeps the original uncertainty and both observations.
  const trail = resolved.extensions?.["portable.runtime.reconciliation"] as ReconciliationTrail;
  assert.ok(trail !== undefined);
  assert.equal(trail.originalError.code, "ProviderUnavailable");
  assert.equal(trail.observations.length, 2);
  const [first, second] = trail.observations;
  assert.equal(first?.outcome, "still-unknown");
  assert.equal(second?.outcome, "completed");

  // The journal keeps the unknown event and both passes.
  const events = parts.store.listEvents(parts.sessionId, 0);
  const statuses = events
    .filter((event) => event.type === "operation.updated")
    .map((event) => (event.data as { status?: string }).status);
  assert.deepEqual(statuses, ["accepted", "running", "unknown", "unknown", "completed"]);
  const reconciled = events
    .map((event) => event.data as { reconciliation?: { outcome?: string } })
    .filter((data) => data.reconciliation !== undefined);
  assert.deepEqual(reconciled.map((data) => data.reconciliation?.outcome), [
    "still-unknown",
    "completed",
  ]);

  // The resolved operation is settled: nothing moves it again.
  const moved = await refuse(() =>
    reconcileOperation(parts.store, parts.sessionId, parts.operation.id, {
      kind: "failed",
      error: portableError("ProviderUnavailable", "A late report says otherwise."),
      detail: "A stale report arrived.",
    }),
  );
  assert.ok(moved !== null && moved.code === "InvalidRequest");
  assert.ok(JSON.stringify(moved.details).includes("operation-not-unknown"));

  // An operation that never went unknown refuses reconciliation.
  const parts2 = setup();
  const fresh = await refuse(() =>
    reconcileOperation(parts2.store, parts2.sessionId, parts2.operation.id, {
      kind: "completed",
      resultRef: "result://exit-0",
      detail: "Nothing was uncertain.",
    }),
  );
  assert.ok(fresh !== null && fresh.code === "InvalidRequest");

  // A foreign session cannot touch the record.
  const crossed = await refuse(() =>
    settleOperation(parts.store, "sess-other", parts.operation.id, {
      kind: "failed",
      error: portableError("ProviderUnavailable", "Outside write."),
    }),
  );
  assert.ok(crossed !== null && crossed.code === "InvalidRequest");
});
