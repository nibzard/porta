import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PolicyAuthority } from "../core/policy.js";
import type { InvocationRequest } from "../schema/operation.js";
import type { AttachmentSummary } from "../schema/session.js";
import { ControlStore } from "../store/control-store.js";
import { admitInvocation } from "./admission.js";
import type { AdmissionOptions } from "./admission.js";
import { settleOperation } from "./outcomes.js";
import { commitPolicyRevocation } from "./revocation.js";
import type { CancelTransport } from "./cancellation.js";

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

const OPTIONS: AdmissionOptions = {
  authority: PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    operations: ["exec.process@1", "fs.workspace@1/write"],
  }),
};

/** One session with one active attachment offering two capabilities. */
function setup(attachment: Partial<AttachmentSummary> = {}): {
  store: ControlStore;
  sessionId: string;
  attachmentId: string;
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
  store.insertAttachment({
    sessionId,
    attachmentId,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1", "fs.workspace@1"],
    ...attachment,
  });
  return { store, sessionId, attachmentId };
}

/** One invocation request against the worker attachment. */
function request(
  sessionId: string,
  attachmentId: string,
  overrides: Partial<InvocationRequest> = {},
): InvocationRequest {
  return {
    attachment: { sessionId, attachmentId, generation: 1 },
    capability: "exec.process@1",
    operation: "run",
    input: { command: "echo", args: ["hi"] },
    requestKey: `req-${randomUUID()}`,
    ...overrides,
  };
}

/** Admit one operation and return its identifier. */
function admit(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
  overrides: Partial<InvocationRequest> = {},
): string {
  const outcome = admitInvocation(store, sessionId, request(sessionId, attachmentId, overrides), OPTIONS);
  return outcome.operation.id;
}

test("committed revocations block new admissions from the commit onward", async () => {
  const { store, sessionId, attachmentId } = setup();
  const before = admitInvocation(store, sessionId, request(sessionId, attachmentId), OPTIONS);
  assert.equal(before.operation.status, "accepted");

  const revocationId = `rev-${randomUUID()}`;
  const committed = await commitPolicyRevocation(store, sessionId, {
    revocationId,
    operations: ["exec.process@1"],
    reason: "Authority withdrawn by the embedder.",
  });
  assert.equal(committed.created, true);
  assert.deepEqual(committed.revocation.operations, ["exec.process@1"]);

  // The pre-revocation admission is still in flight, so the sweep
  // reports it — with no transport, as an open obligation.
  assert.deepEqual(committed.cancellations, [
    { operationId: before.operation.id, result: null, status: "accepted" },
  ]);

  // A new admission under the revoked capability refuses.
  const blocked = await refuse(() =>
    admitInvocation(store, sessionId, request(sessionId, attachmentId), OPTIONS),
  );
  assert.equal(blocked?.code, "PolicyDenied");
  assert.equal((blocked?.details as { revocationId?: string }).revocationId, revocationId);
  assert.equal((blocked?.details as { dimension?: string }).dimension, "revocation");

  // A capability the revocation does not name still admits.
  const other = admitInvocation(
    store,
    sessionId,
    request(sessionId, attachmentId, {
      capability: "fs.workspace@1",
      operation: "write",
    }),
    OPTIONS,
  );
  assert.equal(other.operation.status, "accepted");

  // A repeated revocation identity is idempotent.
  const again = await commitPolicyRevocation(store, sessionId, {
    revocationId,
    operations: ["exec.process@1"],
    reason: "Authority withdrawn by the embedder.",
  });
  assert.equal(again.created, false);
  assert.equal(again.revocation.id, revocationId);

  // The journal carries the durable revocation event once.
  const events = store
    .listEvents(sessionId, 0)
    .filter((event) => event.type === "policy.revoked");
  assert.equal(events.length, 1);

  // A revocation that names nothing refuses.
  const empty = await refuse(() =>
    commitPolicyRevocation(store, sessionId, { reason: "Nothing revoked." }),
  );
  assert.equal(empty?.code, "InvalidRequest");
});

test("the old request key still deduplicates after revocation", async () => {
  const { store, sessionId, attachmentId } = setup();
  const invocation = request(sessionId, attachmentId);
  const first = admitInvocation(store, sessionId, invocation, OPTIONS);
  await commitPolicyRevocation(store, sessionId, {
    operations: ["exec.process@1"],
    reason: "Withdrawn.",
  });
  const repeat = admitInvocation(store, sessionId, invocation, OPTIONS);
  assert.equal(repeat.deduplicated, true);
  assert.equal(repeat.operation.id, first.operation.id);
  assert.equal(repeat.operation.status, "accepted");
});

test("revoked providers block admissions of their attachments", async () => {
  const { store, sessionId, attachmentId } = setup({ providerId: "prov-x" });
  await commitPolicyRevocation(store, sessionId, {
    providers: ["prov-y", "prov-x"],
    reason: "Provider decommissioned.",
  });
  const blocked = await refuse(() =>
    admitInvocation(store, sessionId, request(sessionId, attachmentId), OPTIONS),
  );
  assert.equal(blocked?.code, "PolicyDenied");
  assert.equal((blocked?.details as { dimension?: string }).dimension, "revocation");
});

test("covered in-flight operations receive cancellation, reported honestly", async () => {
  const { store, sessionId, attachmentId } = setup();
  const confirmedId = admit(store, sessionId, attachmentId);
  const unconfirmedId = admit(store, sessionId, attachmentId);
  const untouchedId = admit(store, sessionId, attachmentId, {
    capability: "fs.workspace@1",
    operation: "write",
  });
  const settledId = admit(store, sessionId, attachmentId, {
    capability: "fs.workspace@1",
    operation: "write",
  });
  settleOperation(store, sessionId, settledId, { kind: "completed", resultRef: "blob:x" });

  const transport: CancelTransport = {
    async cancel(operationId) {
      if (operationId === confirmedId) {
        return { outcome: "confirmed", stopped: true, descendantsStopped: true };
      }
      return { outcome: "best-effort", stopped: false, detail: "The provider did not confirm." };
    },
  };
  const outcome = await commitPolicyRevocation(
    store,
    sessionId,
    { operations: ["exec.process@1"], reason: "Withdrawn." },
    { transport },
  );
  assert.equal(outcome.cancellations.length, 2);

  // The confirmed stop settles as cancelled.
  const confirmedEntry = outcome.cancellations.find((entry) => entry.operationId === confirmedId);
  assert.ok(confirmedEntry !== undefined);
  assert.equal(confirmedEntry.status, "cancelled");
  assert.equal(confirmedEntry.result?.stopped, true);

  // The unconfirmed stop stays visible: unknown status, trail on the
  // record, never reported as stopped.
  const unconfirmedEntry = outcome.cancellations.find(
    (entry) => entry.operationId === unconfirmedId,
  );
  assert.ok(unconfirmedEntry !== undefined);
  assert.equal(unconfirmedEntry.status, "unknown");
  assert.equal(unconfirmedEntry.result?.stopped, false);
  const trail = store.getOperation(unconfirmedId)?.extensions?.[
    "portable.runtime.cancellation"
  ] as { attempts: Array<{ outcome: string; stopped: boolean; detail?: string }> } | undefined;
  assert.equal(trail?.attempts.length, 1);
  assert.equal(trail?.attempts[0]?.outcome, "best-effort");
  assert.equal(trail?.attempts[0]?.stopped, false);

  // Uncovered and settled operations receive nothing.
  for (const id of [untouchedId, settledId]) {
    assert.ok(outcome.cancellations.every((entry) => entry.operationId !== id));
  }
  assert.equal(store.getOperation(untouchedId)?.status, "accepted");
  assert.equal(store.getOperation(settledId)?.status, "completed");
});

test("unsupported and failed cancellation requests stay visible", async () => {
  const { store, sessionId, attachmentId } = setup();
  const unsupportedId = admit(store, sessionId, attachmentId);
  const thrownId = admit(store, sessionId, attachmentId);

  const transport: CancelTransport = {
    async cancel(operationId) {
      if (operationId === unsupportedId) {
        return { outcome: "unsupported", stopped: false, detail: "Not cancellable." };
      }
      throw new Error("connection lost");
    },
  };
  const outcome = await commitPolicyRevocation(
    store,
    sessionId,
    { operations: ["exec.process@1"], reason: "Withdrawn." },
    { transport },
  );
  const unsupportedEntry = outcome.cancellations.find(
    (entry) => entry.operationId === unsupportedId,
  );
  assert.ok(unsupportedEntry !== undefined);
  assert.equal(unsupportedEntry.result?.outcome, "unsupported");
  assert.equal(unsupportedEntry.status, "accepted");

  // The failed request reports the failure; the operation is untouched
  // and nothing claims a stop.
  const thrownEntry = outcome.cancellations.find((entry) => entry.operationId === thrownId);
  assert.ok(thrownEntry !== undefined);
  assert.equal(thrownEntry.result, null);
  assert.equal(thrownEntry.status, "accepted");
  assert.ok(thrownEntry.error !== undefined);
  assert.equal(store.getOperation(thrownId)?.status, "accepted");
});

test("without a transport the obligation stays visible", async () => {
  const { store, sessionId, attachmentId } = setup();
  const operationId = admit(store, sessionId, attachmentId);
  const outcome = await commitPolicyRevocation(store, sessionId, {
    operations: ["exec.process@1"],
    reason: "Withdrawn.",
  });
  assert.equal(outcome.cancellations.length, 1);
  assert.equal(outcome.cancellations[0]?.operationId, operationId);
  assert.equal(outcome.cancellations[0]?.result, null);
  assert.equal(outcome.cancellations[0]?.status, "accepted");
  assert.equal(store.getOperation(operationId)?.status, "accepted");
});

test("grant-specific revocation blocks only its operation", async () => {
  const { store, sessionId, attachmentId } = setup();
  const startId = admit(store, sessionId, attachmentId, { operation: "start" });
  await commitPolicyRevocation(store, sessionId, {
    operations: ["exec.process@1/run"],
    reason: "Runs withdrawn; starts remain.",
  });

  // New run admissions refuse; new start admissions pass.
  const run = await refuse(() =>
    admitInvocation(store, sessionId, request(sessionId, attachmentId), OPTIONS),
  );
  assert.equal(run?.code, "PolicyDenied");
  const start = admitInvocation(
    store,
    sessionId,
    request(sessionId, attachmentId, { operation: "start" }),
    OPTIONS,
  );
  assert.equal(start.operation.status, "accepted");

  // The in-flight start is not covered, so the sweep leaves it alone.
  const swept = await commitPolicyRevocation(store, sessionId, {
    operations: ["exec.process@1/run"],
    reason: "Runs withdrawn; starts remain.",
  });
  assert.ok(swept.cancellations.every((entry) => entry.operationId !== startId));
  assert.equal(store.getOperation(startId)?.status, "accepted");
});
