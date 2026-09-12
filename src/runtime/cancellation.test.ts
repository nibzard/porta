import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { portableError } from "../core/errors.js";
import { PolicyAuthority } from "../core/policy.js";
import type { InvocationRequest, OperationRecord } from "../schema/operation.js";
import type { CancellationResult } from "../schema/adapter.js";
import type { AttachmentSummary } from "../schema/session.js";
import { ControlStore } from "../store/control-store.js";
import { admitInvocation } from "./admission.js";
import type { AdmissionOptions } from "./admission.js";
import { claimOperationDispatch, settleOperation } from "./outcomes.js";
import {
  cancelOperation,
  deadlineFromTimeoutMs,
  waitForOperation,
} from "./cancellation.js";
import type { CancelTransport, CancellationTrail } from "./cancellation.js";

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

/** A transport whose provider answers whatever cancellation is staged. */
function transport(result: CancellationResult): CancelTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    cancel: async (operationId: string) => {
      calls.push(operationId);
      return result;
    },
  };
}

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
    input: { command: "sleep", args: ["60"] },
    requestKey: "invoke-1",
  };
  const admitted = admitInvocation(store, sessionId, request, AUTHORITY);
  return { store, sessionId, attachmentId, operation: admitted.operation };
}

test("a deadline bounds the wait and never the operation", async () => {
  const parts = setup();
  claimOperationDispatch(parts.store, parts.sessionId, parts.operation.id);

  // The deadline is derived from a duration, never taken on trust.
  assert.equal(
    deadlineFromTimeoutMs(5000, new Date("2026-01-01T00:00:00Z")),
    "2026-01-01T00:00:05.000Z",
  );
  assert.ok(deadlineFromTimeoutMs(1).endsWith("Z"));
  const bad = await refuse(() => deadlineFromTimeoutMs(0));
  assert.ok(bad !== null && bad.code === "InvalidRequest");

  // The wait runs out; the operation is untouched and still running.
  const waited = await waitForOperation(parts.store, parts.sessionId, parts.operation.id, {
    waitMs: 20,
    pollIntervalMs: 5,
  });
  assert.equal(waited.outcome, "timed-out");
  assert.equal(waited.operation.status, "running");
  assert.equal(parts.store.getOperation(parts.operation.id)?.status, "running");

  // The remote work was never asked to stop.
  const silent = transport({ outcome: "unsupported", stopped: false });
  assert.equal(silent.calls.length, 0);

  // A settled operation answers the wait without a deadline trip.
  settleOperation(parts.store, parts.sessionId, parts.operation.id, {
    kind: "completed",
    resultRef: "result://exit-0",
  });
  const done = await waitForOperation(parts.store, parts.sessionId, parts.operation.id, {
    waitMs: 0,
  });
  assert.equal(done.outcome, "settled");
  assert.equal(done.operation.status, "completed");

  const badWait = await refuse(() =>
    waitForOperation(parts.store, parts.sessionId, parts.operation.id, { waitMs: -1 }),
  );
  assert.ok(badWait !== null && badWait.code === "InvalidRequest");
  const missing = await refuse(() =>
    waitForOperation(parts.store, parts.sessionId, "op-missing", { waitMs: 5 }),
  );
  assert.ok(missing !== null && missing.code === "InvalidRequest");
});

test("a confirmed stop settles cancelled and keeps prior effects visible", async () => {
  const parts = setup();
  const operationId = parts.operation.id;
  claimOperationDispatch(parts.store, parts.sessionId, operationId);

  // Partial output existed before the stop; it must remain visible.
  parts.store.casOperation(operationId, { status: "running" }, {
    ...parts.operation,
    status: "running",
    extensions: { "provider.partial-output": "bytes:128" },
  });

  const stopped = await cancelOperation(parts.store, parts.sessionId, operationId, transport({
    outcome: "confirmed",
    stopped: true,
    descendantsStopped: true,
    detail: "SIGTERM delivered to the process group.",
  }));
  assert.equal(stopped.result.outcome, "confirmed");
  assert.equal(stopped.operation.status, "cancelled");
  // Prior effects and the cancellation trail both stay on the record.
  assert.equal(stopped.operation.extensions?.["provider.partial-output"], "bytes:128");
  const trail = stopped.operation.extensions?.["portable.runtime.cancellation"] as CancellationTrail;
  assert.ok(trail !== undefined);
  assert.equal(trail.attempts.length, 1);
  assert.equal(trail.attempts[0]?.outcome, "confirmed");
  assert.equal(trail.attempts[0]?.descendantsStopped, true);

  // Cancelling again is idempotent: the provider is not asked twice.
  const again = transport({ outcome: "confirmed", stopped: true });
  const repeated = await cancelOperation(parts.store, parts.sessionId, operationId, again);
  assert.equal(repeated.operation.status, "cancelled");
  assert.equal(again.calls.length, 0);
  assert.equal(repeated.result.stopped, true);

  // A finished operation cannot be cancelled.
  const parts2 = setup();
  settleOperation(parts2.store, parts2.sessionId, parts2.operation.id, {
    kind: "completed",
    resultRef: "result://exit-0",
  });
  const finished = await refuse(() =>
    cancelOperation(parts2.store, parts2.sessionId, parts2.operation.id, transport({
      outcome: "confirmed",
      stopped: true,
    })),
  );
  assert.ok(finished !== null && finished.code === "InvalidRequest");
  assert.ok(JSON.stringify(finished.details).includes("operation-settled"));
});

test("a best-effort stop stays unknown until reconciliation resolves it", async () => {
  const parts = setup();
  const operationId = parts.operation.id;
  claimOperationDispatch(parts.store, parts.sessionId, operationId);

  // The provider took the signal but confirms nothing.
  const unconfirmed = await cancelOperation(parts.store, parts.sessionId, operationId, transport({
    outcome: "best-effort",
    stopped: false,
    detail: "The signal was sent; the exit was not observed.",
  }));
  assert.equal(unconfirmed.operation.status, "unknown");
  assert.equal(unconfirmed.operation.error?.code, "OperationUnknown");
  const trail = unconfirmed.operation.extensions?.["portable.runtime.cancellation"] as CancellationTrail;
  assert.ok(trail !== undefined);
  assert.equal(trail.attempts.length, 1);
  assert.equal(trail.attempts[0]?.outcome, "best-effort");

  // The unconfirmed stop stays unresolved until evidence arrives: the
  // process turned out to have exited 4 after the signal.
  const { reconcileOperation } = await import("./outcomes.js");
  const resolved = reconcileOperation(parts.store, parts.sessionId, operationId, {
    kind: "completed",
    resultRef: "result://exit-4",
    detail: "The provider logs show the process exited 4 after the signal.",
  });
  assert.equal(resolved.status, "completed");
  assert.equal(resolved.resultRef, "result://exit-4");
  // The cancellation attempt outlived the resolution.
  const kept = resolved.extensions?.["portable.runtime.cancellation"] as CancellationTrail;
  assert.equal(kept?.attempts.length, 1);

  // Cancelling an already unknown operation records the attempt and
  // keeps the outcome unknown.
  const parts3 = setup();
  const unknownId = parts3.operation.id;
  claimOperationDispatch(parts3.store, parts3.sessionId, unknownId);
  settleOperation(parts3.store, parts3.sessionId, unknownId, {
    kind: "unknown",
    error: portableError("ProviderUnavailable", "The response was lost."),
  });
  const retried = await cancelOperation(parts3.store, parts3.sessionId, unknownId, transport({
    outcome: "best-effort",
    stopped: true,
    detail: "Second signal sent.",
  }));
  assert.equal(retried.operation.status, "unknown");
  const retryTrail = retried.operation.extensions?.["portable.runtime.cancellation"] as CancellationTrail;
  assert.equal(retryTrail?.attempts.length, 1);
});

test("an unsupported cancellation refuses without touching the status", async () => {
  const parts = setup();
  const operationId = parts.operation.id;
  claimOperationDispatch(parts.store, parts.sessionId, operationId);

  const refused = await cancelOperation(parts.store, parts.sessionId, operationId, transport({
    outcome: "unsupported",
    stopped: false,
    detail: "The capability declares cancellation unsupported.",
  }));
  assert.equal(refused.result.outcome, "unsupported");
  // The operation keeps running; only the trail records the attempt.
  assert.equal(refused.operation.status, "running");
  const trail = refused.operation.extensions?.["portable.runtime.cancellation"] as CancellationTrail;
  assert.ok(trail !== undefined);
  assert.equal(trail.attempts[0]?.outcome, "unsupported");

  // A later confirmed stop still settles the same operation.
  const stopped = await cancelOperation(parts.store, parts.sessionId, operationId, transport({
    outcome: "confirmed",
    stopped: true,
  }));
  assert.equal(stopped.operation.status, "cancelled");
  const kept = stopped.operation.extensions?.["portable.runtime.cancellation"] as CancellationTrail;
  assert.equal(kept?.attempts.length, 2);

  // A foreign session cannot cancel.
  const crossed = await refuse(() =>
    cancelOperation(parts.store, "sess-other", operationId, transport({
      outcome: "confirmed",
      stopped: true,
    })),
  );
  assert.ok(crossed !== null && crossed.code === "InvalidRequest");
});
