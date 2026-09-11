import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ControlStore, StoreError } from "./control-store.js";
import type { MutationLease } from "./control-store.js";

const execFileAsync = promisify(execFile);

/** Directory of this compiled test file, where the worker script lives too. */
function dirnameOf(moduleUrl: string): string {
  return fileURLToPath(new URL(".", moduleUrl));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function seededStore(): ControlStore {
  const store = ControlStore.inMemory();
  store.createSession({
    id: "sess-1",
    schemaVersion: 1,
    status: "open",
    workspaceId: "ws-1",
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: "2026-09-11T00:00:00Z",
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

function kindOf(value: unknown): string | undefined {
  return value instanceof StoreError ? value.kind : undefined;
}

test("the first acquisition takes fencing token one", () => {
  const store = seededStore();
  const lease = store.acquireMutationLease("sess-1", "att-1", "controller-a", 60_000);
  assert.equal(lease.fencingToken, 1);
  assert.equal(lease.holder, "controller-a");
  assert.equal(store.getMutationLease("sess-1", "att-1")?.fencingToken, 1);
  assert.throws(
    () => store.acquireMutationLease("sess-1", "att-1", "controller-b", 60_000),
    (error: unknown) => kindOf(error) === "lease-held",
  );
  assert.throws(() => store.acquireMutationLease("sess-1", "att-1", "x", 0), StoreError);
});

test("tokens rise monotonically across expiry, release, and reacquire", async () => {
  const store = seededStore();
  const first = store.acquireMutationLease("sess-1", "att-1", "controller-a", 40);
  await sleep(60);
  // The expired lease can be taken over; the token never repeats.
  const second = store.acquireMutationLease("sess-1", "att-1", "controller-b", 60_000);
  assert.equal(second.fencingToken, first.fencingToken + 1);

  // A released lease is acquirable too, again with a higher token.
  store.releaseMutationLease("sess-1", "att-1", second.fencingToken);
  const third = store.acquireMutationLease("sess-1", "att-1", "controller-c", 60_000);
  assert.equal(third.fencingToken, second.fencingToken + 1);
});

test("an expired controller cannot commit after a takeover", async () => {
  const store = seededStore();
  const stale = store.acquireMutationLease("sess-1", "att-1", "controller-a", 40);
  await sleep(60);
  const fresh = store.acquireMutationLease("sess-1", "att-1", "controller-b", 60_000);

  // The delayed provider response arrives for the expired controller.
  assert.throws(
    () =>
      store.mutateWithLease("sess-1", "att-1", stale.fencingToken, () =>
        store.casAttachment(
          "att-1",
          { generation: 1 },
          {
            sessionId: "sess-1",
            attachmentId: "att-1",
            name: "worker",
            generation: 1,
            status: "released",
            capabilityIds: ["exec.process@1"],
          },
        ),
      ),
    (error: unknown) => kindOf(error) === "fenced-out",
  );
  // The fenced-out write left nothing behind.
  assert.equal(store.getAttachment("att-1")?.status, "active");

  // The current token commits the same mutation.
  const applied = store.mutateWithLease("sess-1", "att-1", fresh.fencingToken, () =>
    store.casAttachment(
      "att-1",
      { generation: 1 },
      {
        sessionId: "sess-1",
        attachmentId: "att-1",
        name: "worker",
        generation: 2,
        status: "replacing",
        capabilityIds: ["exec.process@1"],
      },
    ),
  );
  assert.equal(applied?.generation, 2);
});

test("a lapsed lease rejects commits even without a takeover", async () => {
  const store = seededStore();
  const lease = store.acquireMutationLease("sess-1", "att-1", "controller-a", 40);
  await sleep(60);
  // Nobody else acquired; the expired token still carries no authority.
  assert.throws(
    () => store.mutateWithLease("sess-1", "att-1", lease.fencingToken, () => "committed"),
    (error: unknown) => kindOf(error) === "lease-expired",
  );
});

test("validateMutationLease accepts only the live token", () => {
  const store = seededStore();
  const lease = store.acquireMutationLease("sess-1", "att-1", "controller-a", 60_000);
  store.validateMutationLease("sess-1", "att-1", lease.fencingToken);
  assert.throws(
    () => store.validateMutationLease("sess-1", "att-1", lease.fencingToken + 1),
    (error: unknown) => kindOf(error) === "fenced-out",
  );
  assert.throws(
    () => store.validateMutationLease("sess-1", "missing", lease.fencingToken),
    (error: unknown) => kindOf(error) === "not-found",
  );
  store.releaseMutationLease("sess-1", "att-1", lease.fencingToken);
  assert.throws(
    () => store.validateMutationLease("sess-1", "att-1", lease.fencingToken),
    (error: unknown) => kindOf(error) === "fenced-out",
  );
});

test("a failed fenced mutation rolls its body back", () => {
  const store = seededStore();
  const lease = store.acquireMutationLease("sess-1", "att-1", "controller-a", 60_000);
  store.releaseMutationLease("sess-1", "att-1", lease.fencingToken);
  assert.throws(
    () =>
      store.mutateWithLease("sess-1", "att-1", lease.fencingToken, () => {
        store.appendEvent("sess-1", "attachment.released", "att-1", {});
        return "done";
      }),
    StoreError,
  );
  // The event from the fenced body did not commit.
  assert.equal(store.listEvents("sess-1", 0).length, 0);
});

test("release and replacement serialize on one lease", () => {
  const store = seededStore();
  // The release flow takes the mutation lease.
  const releasing = store.acquireMutationLease("sess-1", "att-1", "release-flow", 60_000);
  // The replacement flow must wait for the same lock.
  assert.throws(
    () => store.acquireMutationLease("sess-1", "att-1", "replace-flow", 60_000),
    (error: unknown) => kindOf(error) === "lease-held",
  );
  // After release, the replacement proceeds with the next token.
  assert.equal(store.releaseMutationLease("sess-1", "att-1", releasing.fencingToken), true);
  // Release is idempotent for the same token while nothing else moved.
  assert.equal(store.releaseMutationLease("sess-1", "att-1", releasing.fencingToken), true);
  const replacing = store.acquireMutationLease("sess-1", "att-1", "replace-flow", 60_000);
  assert.equal(replacing.fencingToken, releasing.fencingToken + 1);
  // The old token cannot release the new holder's lease.
  assert.equal(store.releaseMutationLease("sess-1", "att-1", releasing.fencingToken), false);
});

test("renewal extends a held lease and refuses stale tokens", () => {
  const store = seededStore();
  const lease = store.acquireMutationLease("sess-1", "att-1", "controller-a", 5_000);
  const renewed = store.renewMutationLease("sess-1", "att-1", lease.fencingToken, 10_000);
  assert.ok(renewed);
  assert.ok(Date.parse(renewed.expiresAt) >= Date.parse(lease.expiresAt));
  // A stale token cannot renew.
  assert.equal(store.renewMutationLease("sess-1", "att-1", 999, 10_000), null);
  // A released lease cannot renew.
  store.releaseMutationLease("sess-1", "att-1", lease.fencingToken);
  assert.equal(store.renewMutationLease("sess-1", "att-1", lease.fencingToken, 10_000), null);
  assert.throws(() => store.renewMutationLease("sess-1", "missing", 1, 10_000), StoreError);
});

test("leases survive restart and keep fencing history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-lease-"));
  const path = join(dir, "control.db");
  const store = ControlStore.open(path);
  store.createSession({
    id: "sess-1",
    schemaVersion: 1,
    status: "open",
    workspaceId: "ws-1",
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: "2026-09-11T00:00:00Z",
  });
  const short = store.acquireMutationLease("sess-1", "att-1", "controller-a", 40);
  store.close();
  await sleep(60);

  const reopened = ControlStore.open(path);
  const stored: MutationLease | null = reopened.getMutationLease("sess-1", "att-1");
  assert.equal(stored?.fencingToken, short.fencingToken);
  // The expired lease still refuses commits after the restart.
  assert.throws(
    () => reopened.validateMutationLease("sess-1", "att-1", short.fencingToken),
    (error: unknown) => kindOf(error) === "lease-expired",
  );
  // Takeover continues the token sequence.
  const taken = reopened.acquireMutationLease("sess-1", "att-1", "controller-b", 60_000);
  assert.equal(taken.fencingToken, 2);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrations apply in order and rerun safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-migrate-"));
  const path = join(dir, "control.db");
  const store = ControlStore.open(path);
  store.close();
  const reopened = ControlStore.open(path);
  assert.deepEqual(reopened.appliedMigrations(), [1, 2, 3, 4, 5, 6]);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("separate controller processes fence the expired one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-lease-race-"));
  const path = join(dir, "control.db");
  const setup = ControlStore.open(path);
  setup.createSession({
    id: "sess-1",
    schemaVersion: 1,
    status: "open",
    workspaceId: "ws-1",
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: "2026-09-11T00:00:00Z",
  });
  setup.close();

  const workerOf = (role: string): Promise<{ role: string; token?: number; committed?: boolean; reason?: string }> =>
    execFileAsync(process.execPath, [join(dirnameOf(import.meta.url), "lease-worker.js"), path, role]).then(
      ({ stdout }) => JSON.parse(stdout.trim()),
    );
  const [stale, fresh] = await Promise.all([workerOf("stale"), workerOf("fresh")]);

  // The fresh controller acquired after expiry and committed.
  assert.equal(fresh.committed, true);
  assert.equal(fresh.token, 2);
  // The stale controller's delayed response never commits. Which guard
  // fires depends on process scheduling under load; both refuse the write.
  assert.equal(stale.committed, false);
  assert.ok(
    stale.reason === "fenced-out" || stale.reason === "lease-expired",
    `unexpected rejection kind ${String(stale.reason)}`,
  );

  // Only the fresh controller's event committed.
  const reader = ControlStore.open(path);
  const events = reader.listEvents("sess-1", 0);
  assert.deepEqual(
    events.map((event) => event.data.by),
    ["fresh"],
  );
  reader.close();
  rmSync(dir, { recursive: true, force: true });
});
