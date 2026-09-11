import test from "node:test";
import assert from "node:assert/strict";
import { FakeEnvironmentAdapter, FakeEnvironmentLease } from "./test-adapter.js";
import { assertValid } from "../schema/validate.js";
import {
  acquisitionStatusSchema,
  adapterOperationSchema,
  bindingResultSchema,
  cancellationResultSchema,
  leaseStatusSchema,
  releaseResultSchema,
} from "../schema/adapter.js";
import { environmentManifestSchema } from "../schema/capability.js";
import type {
  AdapterInvocation,
  AuthorizedAcquireRequest,
} from "../schema/adapter.js";
import type { ResourceRef } from "../schema/resource.js";

function isPortableCode(value: unknown): value is { code: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

function acquireRequest(acquisitionId: string): AuthorizedAcquireRequest {
  return {
    acquisitionId,
    request: { name: "worker", requires: { "exec.process@1": {} } },
    authority: { principal: "user://test", policyRef: "policy://test" },
  };
}

function invocation(operationId: string): AdapterInvocation {
  return {
    operationId,
    capability: "exec.process@1",
    operation: "run",
    input: { command: "echo hello" },
    environmentId: "env-any",
    limits: {},
  };
}

const RESOURCE: ResourceRef = {
  id: "res-1",
  sessionId: "sess-1",
  type: "process",
  owner: { sessionId: "sess-1", attachmentId: "att-1", generation: 1 },
  lifetime: "attachment",
  recovery: "none",
};

/** Start an allocation and return its lease. */
async function allocate(
  adapter: FakeEnvironmentAdapter,
  acquisitionId = "acq-1",
): Promise<FakeEnvironmentLease> {
  const lease = await adapter.acquire(acquireRequest(acquisitionId));
  assert.ok(lease instanceof FakeEnvironmentLease);
  return lease;
}

test("every supporting result type round-trips through its schema", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const lease = await allocate(adapter);

  const status = await adapter.reconcile("acq-1");
  assertValid(acquisitionStatusSchema, status);
  assert.equal(status.state, "allocated");

  const operation = await lease.invoke(invocation("op-1"));
  assertValid(adapterOperationSchema, operation);

  const inspected = await lease.inspect("op-1");
  assertValid(adapterOperationSchema, inspected);

  const cancelled = await lease.cancel("op-1");
  assertValid(cancellationResultSchema, cancelled);

  const bound = await lease.bind(RESOURCE, {
    authority: { principal: "user://test", policyRef: "policy://test" },
    resolveSecret: async () => "",
  });
  assertValid(bindingResultSchema, bound);
  assert.equal(bound.status, "unsupported");

  const renewed = await lease.renew("2999-06-01T00:00:00Z");
  assertValid(leaseStatusSchema, renewed);

  const released = await lease.release();
  assertValid(releaseResultSchema, released);

  const manifest = await lease.manifest();
  assertValid(environmentManifestSchema, manifest);

  const offers = await adapter.describe();
  assert.equal(offers.length, 1);
});

test("a lost acquire response still allocates and reconcile reports it", async () => {
  const adapter = new FakeEnvironmentAdapter();
  adapter.queueAcquire({ kind: "lost", allocateAnyway: true });
  const pending = adapter.acquire(acquireRequest("acq-lost"));
  // The response never arrives; let the microtask queue drain first.
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 10))]);
  const settled = await Promise.race([
    pending.then(() => true, () => true),
    Promise.resolve(false),
  ]);
  assert.equal(settled, false);

  // Reconciliation by durable identity reveals the allocation.
  const status = await adapter.reconcile("acq-lost");
  assert.equal(status.state, "allocated");
  assert.ok(typeof status.environmentId === "string");
  const lease = adapter.lease(status.environmentId!);
  assert.equal((await lease.manifest()).environmentId, status.environmentId);
});

test("a lost acquire without allocation stays unknown and never double-allocates", async () => {
  const adapter = new FakeEnvironmentAdapter();
  adapter.queueAcquire({ kind: "lost", allocateAnyway: false });
  void adapter.acquire(acquireRequest("acq-unknown"));
  assert.equal((await adapter.reconcile("acq-unknown")).state, "unknown");
  assert.equal(adapter.allocationOf("acq-unknown")?.state, "unknown");
});

test("duplicate acquisition identities return the same environment", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const first = await adapter.acquire(acquireRequest("acq-dup"));
  const second = await adapter.acquire(acquireRequest("acq-dup"));
  assert.equal(second.environmentId, first.environmentId);
});

test("scripted acquisition failures surface provider errors", async () => {
  const adapter = new FakeEnvironmentAdapter();
  adapter.queueAcquire({ kind: "fail" });
  await assert.rejects(
    adapter.acquire(acquireRequest("acq-fail")),
    (error: unknown) => isPortableCode(error) && error.code === "ProviderUnavailable",
  );
  assert.equal((await adapter.reconcile("acq-fail")).state, "failed");
});

test("delayed completion reports running, then settles server-side", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const lease = await allocate(adapter);
  adapter.queueInvoke({ kind: "running" });
  const started = await lease.invoke(invocation("op-slow"));
  assert.equal(started.status, "running");

  // The provider finishes later; inspection reflects the truth.
  adapter.settleOperation("op-slow", { status: "completed", result: { exitCode: 0 } });
  const inspected = await lease.inspect("op-slow");
  assert.equal(inspected.status, "completed");
  assert.deepEqual(inspected.result, { exitCode: 0 });
});

test("a lost invocation after effects never answers but leaves evidence", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const lease = await allocate(adapter);
  adapter.queueInvoke({ kind: "lost", effects: "happened" });
  const pending = lease.invoke(invocation("op-lost"));
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 10))]);
  assert.equal(adapter.pendingInvocations().length, 1);
  assert.equal(adapter.pendingInvocations()[0]?.operationId, "op-lost");

  // The effect happened even though the response is gone.
  const inspected = await lease.inspect("op-lost");
  assert.equal(inspected.status, "completed");
  assert.deepEqual(adapter.recordedOperations(), [
    { operationId: "op-lost", status: "completed", effects: true },
  ]);
});

test("cancellation distinguishes confirmed, best-effort, unsupported, and timeout", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const lease = await allocate(adapter);

  adapter.queueCancel({ kind: "best-effort" });
  const effort = await lease.cancel("op-a");
  assert.deepEqual(
    { outcome: effort.outcome, stopped: effort.stopped },
    { outcome: "best-effort", stopped: false },
  );

  adapter.queueCancel({ kind: "unsupported" });
  const unsupported = await lease.cancel("op-b");
  assert.deepEqual(
    { outcome: unsupported.outcome, stopped: unsupported.stopped },
    { outcome: "unsupported", stopped: false },
  );

  // A caller timeout alone never claims termination.
  adapter.queueCancel({ kind: "timeout-only" });
  const timedOut = await lease.cancel("op-c");
  assert.equal(timedOut.stopped, false);
  assert.equal(timedOut.outcome, "best-effort");

  // Confirmed cancellation also flips a running operation.
  adapter.queueInvoke({ kind: "running" });
  await lease.invoke(invocation("op-d"));
  adapter.queueCancel({ kind: "confirmed" });
  const confirmed = await lease.cancel("op-d");
  assert.equal(confirmed.stopped, true);
  assert.equal((await lease.inspect("op-d")).status, "cancelled");
});

test("renewal extends, reports unsupported, and refuses when expired", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const lease = await allocate(adapter, "acq-renew");

  adapter.queueRenew({ kind: "extend" });
  const extended = await lease.renew("2999-07-01T00:00:00Z");
  assert.deepEqual(
    { status: extended.status, renewalSupported: extended.renewalSupported },
    { status: "active", renewalSupported: true },
  );

  adapter.queueRenew({ kind: "unsupported" });
  const unsupported = await lease.renew("2999-08-01T00:00:00Z");
  assert.equal(unsupported.renewalSupported, false);

  adapter.queueRenew({ kind: "refuse" });
  const refused = await lease.renew("2999-09-01T00:00:00Z");
  assert.equal(refused.status, "expired");

  // Provider-side expiry: the lease keeps refusing new work.
  const reactivated = await adapter.acquire(acquireRequest("acq-renew"));
  assert.ok(reactivated instanceof FakeEnvironmentLease);
  reactivated && adapter.expireLease(reactivated.environmentId);
  await assert.rejects(
    reactivated.invoke(invocation("op-after-expiry")),
    (error: unknown) => isPortableCode(error) && error.code === "LeaseExpired",
  );
});

test("release is idempotent and scripted failures stay retryable", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const lease = await allocate(adapter, "acq-release");

  adapter.queueRelease({ kind: "fail-retryable" });
  const failed = await lease.release();
  assert.deepEqual(
    { status: failed.status, retryable: failed.retryable },
    { status: "failed", retryable: true },
  );

  // The retry succeeds, and repeating the release changes nothing.
  const succeeded = await lease.release();
  assert.equal(succeeded.status, "released");
  const again = await lease.release();
  assert.deepEqual(
    { status: again.status, retryable: again.retryable },
    { status: "released", retryable: false },
  );

  const other = await allocate(adapter, "acq-release-2");
  adapter.queueRelease({ kind: "fail-permanent" });
  const permanent = await other.release();
  assert.deepEqual(
    { status: permanent.status, retryable: permanent.retryable },
    { status: "failed", retryable: false },
  );
});

test("binding reports unsupported explicitly by default", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const lease = await allocate(adapter);
  const context = {
    authority: { principal: "user://test", policyRef: "policy://test" },
    resolveSecret: async (reference: string) => reference,
  };

  const unsupported = await lease.bind(RESOURCE, context);
  assert.equal(unsupported.status, "unsupported");

  const bound: ResourceRef = { ...RESOURCE, id: "res-2" };
  adapter.queueBind({ kind: "bound", binding: bound });
  const result = await lease.bind(RESOURCE, context);
  assert.equal(result.status, "bound");
  assert.deepEqual(result.binding, bound);

  adapter.queueBind({ kind: "failed" });
  const failed = await lease.bind(RESOURCE, context);
  assert.equal(failed.status, "failed");
});

test("malformed inputs are invalid requests before any effect", async () => {
  const adapter = new FakeEnvironmentAdapter();
  await assert.rejects(
    adapter.acquire({
      acquisitionId: "",
      request: { name: "worker", requires: {} },
      authority: { principal: "user://test", policyRef: "policy://test" },
    }),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
  const lease = await allocate(adapter);
  await assert.rejects(
    lease.invoke({ ...invocation("op-bad"), operation: "Not An Operation" }),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
  assert.equal(adapter.recordedOperations().length, 0);
});

test("the fake runs entirely in process with no provider side effects", async () => {
  // No network, no accounts: allocation truth is a plain in-memory map.
  const adapter = new FakeEnvironmentAdapter();
  const lease = await allocate(adapter, "acq-local");
  assert.ok(adapter.allocationOf("acq-local")?.environmentId === lease.environmentId);
});
