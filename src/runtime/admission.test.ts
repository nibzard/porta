import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PolicyAuthority } from "../core/policy.js";
import type { PortableError } from "../schema/error.js";
import type { InvocationRequest, OperationRecord } from "../schema/operation.js";
import type { AttachmentSummary } from "../schema/session.js";
import { ControlStore } from "../store/control-store.js";
import { admitInvocation } from "./admission.js";
import type { AdmissionOptions } from "./admission.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one admission instead of throwing it. */
async function refuse(
  run: () => unknown,
): Promise<{ code: string; details?: unknown } | null> {
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

const AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  operations: ["exec.process@1/run"],
  locations: ["local", "remote"],
  networkEgress: "unrestricted",
  hostFilesystemAccess: true,
  maxEnvironmentLifetimeMs: 86_400_000,
  maxResources: {
    memoryBytes: 4 * 1024 ** 3,
    storageBytes: 4 * 1024 ** 3,
    gpuMemoryBytes: 4 * 1024 ** 3,
  },
});

const OPTIONS: AdmissionOptions = { authority: AUTHORITY };

/** One session with one active attachment at generation 1. */
function setup(attachment: Partial<AttachmentSummary> = {}): {
  store: ControlStore;
  sessionId: string;
  attachmentId: string;
  attachment: AttachmentSummary;
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
  const record: AttachmentSummary = {
    sessionId,
    attachmentId,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
    ...attachment,
  };
  store.insertAttachment(record);
  return { store, sessionId, attachmentId, attachment: record };
}

/** One request for the run operation of exec.process@1. */
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

test("admission checks session, attachment, generation, policy, and lease together", async () => {
  const parts = setup();

  // The happy path records one accepted operation with its input hash.
  const admitted = admitInvocation(
    parts.store,
    parts.sessionId,
    request(parts.sessionId, parts.attachmentId, { requestKey: "admit-1" }),
    OPTIONS,
  );
  assert.equal(admitted.deduplicated, false);
  assert.equal(admitted.operation.status, "accepted");
  assert.equal(admitted.operation.attachment.attachmentId, parts.attachmentId);
  const stored = parts.store.getOperationByRequestKey(parts.sessionId, "admit-1");
  assert.ok(stored !== null);
  assert.equal(stored.id, admitted.operation.id);
  // The acceptance is journaled.
  const events = parts.store.listEvents(parts.sessionId, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === "operation.updated" &&
        (event.data as { status?: string }).status === "accepted",
    ),
  );

  // A closing session refuses new operations.
  parts.store.casSessionStatus(parts.sessionId, ["open"], "closing");
  const closing = await refuse(() =>
    admitInvocation(
      parts.store,
      parts.sessionId,
      request(parts.sessionId, parts.attachmentId, { requestKey: "admit-2" }),
      OPTIONS,
    ),
  );
  assert.ok(closing !== null && closing.code === "InvalidRequest");
  assert.equal(parts.store.getOperationByRequestKey(parts.sessionId, "admit-2"), null);
  parts.store.casSessionStatus(parts.sessionId, ["closing"], "open");

  // A moved generation is a stale handle, not a silent rebind.
  const stale = await refuse(() =>
    admitInvocation(
      parts.store,
      parts.sessionId,
      request(parts.sessionId, parts.attachmentId, {
        requestKey: "admit-3",
        attachment: { sessionId: parts.sessionId, attachmentId: parts.attachmentId, generation: 2 },
      }),
      OPTIONS,
    ),
  );
  assert.ok(stale !== null && stale.code === "StaleHandle");

  // Policy denies an operation outside the allow list.
  const denied = await refuse(() =>
    admitInvocation(
      parts.store,
      parts.sessionId,
      request(parts.sessionId, parts.attachmentId, {
        requestKey: "admit-4",
        operation: "inspect",
      }),
      OPTIONS,
    ),
  );
  assert.ok(denied !== null && denied.code === "PolicyDenied");

  // A capability the attachment does not offer refuses.
  const unoffered = await refuse(() =>
    admitInvocation(
      parts.store,
      parts.sessionId,
      request(parts.sessionId, parts.attachmentId, {
        requestKey: "admit-5",
        capability: "fs.workspace@1",
      }),
      OPTIONS,
    ),
  );
  assert.ok(unoffered !== null && unoffered.code === "InvalidRequest");
  assert.ok(JSON.stringify(unoffered.details).includes("capability-not-offered"));

  // A foreign attachment and a foreign session binding refuse.
  const foreign = await refuse(() =>
    admitInvocation(
      parts.store,
      parts.sessionId,
      request("sess-other", parts.attachmentId, { requestKey: "admit-6" }),
      OPTIONS,
    ),
  );
  assert.ok(foreign !== null && foreign.code === "InvalidRequest");
  const unknown = await refuse(() =>
    admitInvocation(
      parts.store,
      parts.sessionId,
      request(parts.sessionId, "att-missing", { requestKey: "admit-7" }),
      OPTIONS,
    ),
  );
  assert.ok(unknown !== null && unknown.code === "InvalidRequest");

  // An expired environment lease refuses with its own code.
  const expired = setup({
    leaseExpiresAt: "2020-01-01T00:00:00Z",
  });
  const leaseRefusal = await refuse(() =>
    admitInvocation(
      expired.store,
      expired.sessionId,
      request(expired.sessionId, expired.attachmentId),
      OPTIONS,
    ),
  );
  assert.ok(leaseRefusal !== null && leaseRefusal.code === "LeaseExpired");
});

test("a repeated key returns the existing operation; changed input conflicts", async () => {
  const parts = setup();
  const call = request(parts.sessionId, parts.attachmentId, { requestKey: "reuse-1" });

  const first = admitInvocation(parts.store, parts.sessionId, call, OPTIONS);
  const second = admitInvocation(parts.store, parts.sessionId, call, OPTIONS);
  assert.equal(second.deduplicated, true);
  assert.equal(second.operation.id, first.operation.id);
  // One record, one acceptance event.
  assert.equal(parts.store.getOperationByRequestKey(parts.sessionId, "reuse-1")?.id, first.operation.id);
  const acceptedEvents = parts.store
    .listEvents(parts.sessionId, 0)
    .filter(
      (event) =>
        event.type === "operation.updated" &&
        (event.data as { status?: string }).status === "accepted",
    );
  assert.equal(acceptedEvents.length, 1);

  // The same key with different input is a conflict, not a re-record.
  const conflict = await refuse(() =>
    admitInvocation(
      parts.store,
      parts.sessionId,
      { ...call, input: { command: "echo", args: ["changed"] } },
      OPTIONS,
    ),
  );
  assert.ok(conflict !== null && conflict.code === "RequestConflict");
  assert.ok(JSON.stringify(conflict.details).includes("reuse-1"));

  // A completed operation answers its key without redispatching.
  const completed: OperationRecord = { ...first.operation, status: "completed" };
  parts.store.casOperation(first.operation.id, { status: "accepted" }, completed);
  const again = admitInvocation(parts.store, parts.sessionId, call, OPTIONS);
  assert.equal(again.deduplicated, true);
  assert.equal(again.operation.status, "completed");
  assert.equal(
    parts.store.getOperationByRequestKey(parts.sessionId, "reuse-1")?.status,
    "completed",
  );

  // Input hashing is canonical: key order alone does not conflict.
  const reordered = admitInvocation(
    parts.store,
    parts.sessionId,
    {
      ...call,
      requestKey: "reuse-2",
      input: { args: ["hi"], command: "echo" },
    },
    OPTIONS,
  );
  assert.equal(reordered.deduplicated, false);
});

test("admission races with replacement and release cannot dispatch stale work", async () => {
  // Replacement preparation moved the attachment to `replacing` first:
  // admission must refuse, because new commands cannot enter during
  // quiescence (SPEC.md section 5.3).
  const replacing = setup({ status: "replacing", generation: 2 });
  const refused = await refuse(() =>
    admitInvocation(
      replacing.store,
      replacing.sessionId,
      request(replacing.sessionId, replacing.attachmentId, {
        attachment: {
          sessionId: replacing.sessionId,
          attachmentId: replacing.attachmentId,
          generation: 2,
        },
      }),
      OPTIONS,
    ),
  );
  assert.ok(refused !== null && refused.code === "InvalidRequest");
  assert.ok(JSON.stringify(refused.details).includes("attachment-replacing"));

  // A released attachment admits nothing.
  const released = setup({ status: "released" });
  const gone = await refuse(() =>
    admitInvocation(
      released.store,
      released.sessionId,
      request(released.sessionId, released.attachmentId),
      OPTIONS,
    ),
  );
  assert.ok(gone !== null && gone.code === "InvalidRequest");

  // An admitted operation keeps the generation it was admitted under;
  // a later replacement does not rebind it, and the old handle cannot
  // admit anything new.
  const parts = setup();
  const admitted = admitInvocation(
    parts.store,
    parts.sessionId,
    request(parts.sessionId, parts.attachmentId, { requestKey: "race-1" }),
    OPTIONS,
  );
  parts.store.casAttachment(
    parts.attachmentId,
    { status: "active", generation: 1 },
    { ...parts.attachment, status: "replacing", generation: 2 },
  );
  const recorded = parts.store.getOperationByRequestKey(parts.sessionId, "race-1");
  assert.ok(recorded !== null);
  assert.equal(recorded.attachment.generation, 1);
  assert.equal(recorded.id, admitted.operation.id);
  const oldHandle = await refuse(() =>
    admitInvocation(
      parts.store,
      parts.sessionId,
      request(parts.sessionId, parts.attachmentId, { requestKey: "race-2" }),
      OPTIONS,
    ),
  );
  assert.ok(oldHandle !== null && oldHandle.code === "InvalidRequest");
  // The replacement did not silently re-record the refused request.
  assert.equal(parts.store.getOperationByRequestKey(parts.sessionId, "race-2"), null);
});