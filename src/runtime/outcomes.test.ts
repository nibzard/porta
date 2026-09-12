import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { portableError } from "../core/errors.js";
import { PolicyAuthority } from "../core/policy.js";
import type { InvocationRequest, OperationRecord } from "../schema/operation.js";
import type { AttachmentSummary } from "../schema/session.js";
import { ControlStore } from "../store/control-store.js";
import { admitInvocation } from "./admission.js";
import type { AdmissionOptions } from "./admission.js";
import {
  markOperationDispatched,
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

test("dispatch records a known start and refuses to replay settled work", async () => {
  const parts = setup();

  const running = markOperationDispatched(parts.store, parts.sessionId, parts.operation.id);
  assert.equal(running.status, "running");
  assert.equal(parts.store.getOperation(parts.operation.id)?.status, "running");
  // The second call is an idempotent no-op, not a second event.
  const again = markOperationDispatched(parts.store, parts.sessionId, parts.operation.id);
  assert.equal(again.status, "running");
  const started = parts.store
    .listEvents(parts.sessionId, 0)
    .filter(
      (event) =>
        event.type === "operation.updated" &&
        (event.data as { status?: string }).status === "running",
    );
  assert.equal(started.length, 1);

  // Settle completed, then try to dispatch again: the unsafe effect
  // must not replay.
  const done = settleOperation(parts.store, parts.sessionId, parts.operation.id, {
    kind: "completed",
    resultRef: "result://exit-3",
  });
  assert.equal(done.status, "completed");
  const replay = await refuse(() =>
    markOperationDispatched(parts.store, parts.sessionId, parts.operation.id),
  );
  assert.ok(replay !== null && replay.code === "InvalidRequest");
  assert.ok(JSON.stringify(replay.details).includes("operation-settled"));
});

test("a nonzero exit is a completed operation, not a transport failure", async () => {
  const parts = setup();
  markOperationDispatched(parts.store, parts.sessionId, parts.operation.id);

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
  markOperationDispatched(parts.store, parts.sessionId, parts.operation.id);

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

  // Dispatch of an unknown operation refuses as well.
  const redispatch = await refuse(() =>
    markOperationDispatched(parts.store, parts.sessionId, parts.operation.id),
  );
  assert.ok(redispatch !== null && redispatch.code === "InvalidRequest");
});

test("reconciliation appends evidence and preserves the original unknown", async () => {
  const parts = setup();
  markOperationDispatched(parts.store, parts.sessionId, parts.operation.id);
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
