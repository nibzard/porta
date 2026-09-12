import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { portableError, providerUnavailableError } from "../core/errors.js";
import { BlobStore, ControlStore, LocalProcessAdapter, PolicyAuthority, PortableRuntime } from "../index.js";
import type { EnvironmentLease } from "../schema/adapter.js";
import type { ManagedSession } from "../runtime/session.js";

/**
 * The README example, executed as documented (review finding 7).
 *
 * Four guarantees: the exact "Use the library" block runs green in a
 * temporary directory and closes every store connection; a policy
 * without the local grants refuses execution instead of half-running;
 * a failed provider answer settles failed, never completed; and
 * repeated dispatch attempts reach the provider at most once.
 */

/** Extract the "Use the library" code block from README.md. */
function readmeExample(): string {
  const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
  const match = readme.match(/```ts\n([\s\S]*?)```/);
  assert.ok(match !== null, "README.md must carry one ts example block");
  assert.ok(match[1]!.includes("claimDispatch"), "the example must dispatch through the claim");
  return match[1]!;
}

test("the documented example runs exactly as written", () => {
  const source = readmeExample();
  const root = mkdtempSync(join(tmpdir(), "porta-readme-"));
  try {
    // The documented import of "portable" resolves to the built library.
    const indexUrl = new URL("../index.js", import.meta.url).href;
    const rewritten = source.replace(
      /from "portable";/,
      `from ${JSON.stringify(indexUrl)};`,
    );
    assert.ok(rewritten !== source, "the example must import from \"portable\"");

    // The example's relative paths land inside this directory.
    writeFileSync(join(root, "example.mjs"), rewritten);
    const run = spawnSync(process.execPath, ["example.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.match(run.stdout, /checkpoint rev-/);
    assert.match(run.stdout, /conversationRestored false/);

    // The run left a store behind and closed its connections: the
    // write-ahead files exist only while a connection is open.
    assert.equal(existsSync(join(root, "control.db")), true);
    assert.equal(existsSync(join(root, "control.db-wal")), false, "the first store closed");
    assert.equal(existsSync(join(root, "control.db-shm")), false, "the reopen store closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** One attachment bench: store, session, worker, and the pieces to drive it. */
interface Bench {
  root: string;
  store: ControlStore;
  session: ManagedSession;
  adapter: LocalProcessAdapter;
  authority: PolicyAuthority;
  environmentId: string;
  ref: { sessionId: string; attachmentId: string; generation: number };
  done(): void;
}

/** Attach one worker under the README's grants. */
async function bench(policyOverrides?: Record<string, unknown>): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "porta-readme-bench-"));
  const store = ControlStore.open(join(root, "control.db"));
  const session = await new PortableRuntime(store).createSession({
    policyRef: "policy://readme",
  });
  const adapter = new LocalProcessAdapter({ supervisorDir: join(root, "supervisor") });
  const authority = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: ["local-process"],
    operations: ["exec.process@1"],
    transferDestinations: ["local"],
    networkEgress: "unrestricted",
    hostFilesystemAccess: true,
    locations: ["local"],
    maxEnvironmentLifetimeMs: 3_600_000,
    ...(policyOverrides ?? {}),
  });
  const compute = await session.attach({
    adapter,
    request: { name: "build", providerId: "local-process", requires: {} },
    requestKey: "attach-readme-1",
    principal: "user://reader",
    authority,
  });
  assert.ok(compute.environmentId !== undefined);
  return {
    root,
    store,
    session,
    adapter,
    authority,
    environmentId: compute.environmentId,
    ref: {
      sessionId: session.id,
      attachmentId: compute.attachmentId,
      generation: compute.generation,
    },
    done: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a policy without the local grants refuses execution", async () => {
  // The grants the README explains are the grants the adapter
  // enforces; without them attachment refuses instead of half-running.
  const root = mkdtempSync(join(tmpdir(), "porta-readme-deny-"));
  const store = ControlStore.open(join(root, "control.db"));
  try {
    const session = await new PortableRuntime(store).createSession({
      policyRef: "policy://readme",
    });
    const adapter = new LocalProcessAdapter({ supervisorDir: join(root, "supervisor") });
    const authority = PolicyAuthority.fromPolicy({
      schemaVersion: 1,
      providers: ["local-process"],
      operations: ["exec.process@1"],
    });
    await assert.rejects(
      session.attach({
        adapter,
        request: { name: "build", providerId: "local-process", requires: {} },
        requestKey: "attach-readme-denied",
        principal: "user://reader",
        authority,
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "PolicyDenied" &&
        /Execution location local is not allowed/.test(
          String((error as { message?: unknown }).message),
        ),
    );
    const description = await session.describe();
    // The refused acquisition still records itself — durably failed,
    // never active.
    assert.ok(
      description.attachments.every((entry) => entry.status !== "active"),
      `attachments recorded ${description.attachments.map((entry) => entry.status).join(", ")}`,
    );
    assert.equal(store.listOperationsBySession(session.id).length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** One lease whose invoke answers what the test chooses. */
function leaseWithInvoke(lease: EnvironmentLease, invoke: EnvironmentLease["invoke"]): EnvironmentLease {
  return {
    environmentId: lease.environmentId,
    ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
    manifest: () => lease.manifest(),
    invoke,
    inspect: (operationId) => lease.inspect(operationId),
    cancel: (operationId) => lease.cancel(operationId),
    bind: (resource, context) => lease.bind(resource, context),
    renew: (expiresAt) => lease.renew(expiresAt),
    release: () => lease.release(),
  };
}

/** The README's admit, claim, dispatch, and settle flow, as one call. */
async function dispatchLikeTheReadme(
  state: { session: ManagedSession; authority: PolicyAuthority },
  lease: EnvironmentLease,
  ref: { sessionId: string; attachmentId: string; generation: number },
  requestKey: string,
): Promise<{ operationId: string; claimed: boolean }> {
  const input = { command: "node", args: ["--version"] };
  const admitted = await state.session.invoke(
    {
      attachment: ref,
      capability: "exec.process@1",
      operation: "run",
      input,
      requestKey,
    },
    { authority: state.authority },
  );
  const claim = await state.session.claimDispatch(admitted.id);
  if (!claim.claimed) {
    return { operationId: admitted.id, claimed: false };
  }
  const answered = await lease.invoke({
    operationId: admitted.id,
    capability: "exec.process@1",
    operation: "run",
    input,
    environmentId: lease.environmentId,
    limits: {},
  });
  if (answered.status === "completed") {
    await state.session.settle(admitted.id, {
      kind: "completed",
      resultRef: JSON.stringify(answered.result ?? null),
    });
  } else {
    await state.session.settle(admitted.id, {
      kind: "failed",
      error:
        answered.error ??
        portableError("ProviderFailed", `The provider answered ${answered.status}.`),
    });
  }
  return { operationId: admitted.id, claimed: true };
}

test("a failed provider answer settles failed, never completed", async () => {
  const state = await bench();
  try {
    const failing = leaseWithInvoke(
      await state.adapter.lease(state.environmentId),
      async (request) => ({
        status: "failed" as const,
        operationId: request.operationId,
        error: providerUnavailableError("The provider refused the run."),
      }),
    );
    const run = await dispatchLikeTheReadme(state, failing, state.ref, "version-failed-1");
    assert.equal(run.claimed, true);
    const record = state.store.getOperation(run.operationId);
    assert.equal(record?.status, "failed");
    assert.equal(record?.resultRef, undefined);
    assert.equal(record?.error?.code, "ProviderUnavailable");
  } finally {
    state.done();
  }
});

test("repeated dispatch attempts reach the provider at most once", async () => {
  const state = await bench();
  try {
    let invocations = 0;
    const real = await state.adapter.lease(state.environmentId);
    const counting = leaseWithInvoke(real, async (request) => {
      invocations += 1;
      return real.invoke(request);
    });
    const first = await dispatchLikeTheReadme(state, counting, state.ref, "version-once-1");
    const second = await dispatchLikeTheReadme(state, counting, state.ref, "version-once-1");
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(second.operationId, first.operationId);
    assert.equal(invocations, 1);
    const record = state.store.getOperation(first.operationId);
    assert.equal(record?.status, "completed");
  } finally {
    state.done();
  }
});

test("the exact README example closes stores and releases attachments on failures", () => {
  const indexUrl = new URL("../index.js", import.meta.url).href;
  const source = readmeExample().replace(/from "portable";/, `from ${JSON.stringify(indexUrl)};`);
  for (const fault of ["attach", "checkpoint", "release", "reopen"]) {
    const root = mkdtempSync(join(tmpdir(), "porta-readme-failure-"));
    try {
      writeFileSync(join(root, "example.mjs"), source);
      writeFileSync(join(root, "check.mjs"), `
import assert from 'node:assert/strict';
import {ControlStore, ManagedSession} from ${JSON.stringify(indexUrl)};
const stores = [];
let releases = 0;
const open = ControlStore.open;
ControlStore.open = function(...args) { const store = open.apply(this, args); stores.push(store); return store; };
const release = ManagedSession.prototype.release;
ManagedSession.prototype.release = async function(...args) { releases++; return release.apply(this, args); };
const fault = ${JSON.stringify(fault)};
ManagedSession.prototype[fault] = async function() {
  if (fault === 'release') releases++;
  throw new Error('injected ' + fault);
};
await assert.rejects(import('./example.mjs'), new RegExp('injected ' + fault));
assert.equal(stores.length, fault === 'reopen' ? 2 : 1);
assert.equal(releases, fault === 'attach' ? 0 : 1);
for (const store of stores) assert.throws(() => store.close(), /closed|not open/i);
`);
      const run = spawnSync(process.execPath, ["check.mjs"], {cwd: root, encoding: "utf8", timeout: 10000});
      assert.equal(run.status, 0, `${fault}: ${run.stderr}`);
    } finally { rmSync(root, {recursive: true, force: true}); }
  }
});
