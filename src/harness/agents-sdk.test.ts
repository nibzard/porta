import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { PolicyAuthority } from "../core/policy.js";
import { PortableRuntime } from "../runtime/session.js";
import { LocalProcessAdapter } from "../adapters/local-process-adapter.js";
import type { LocalProcessAdapter as Adapter } from "../adapters/local-process-adapter.js";
import type { EnvironmentLease } from "../schema/adapter.js";
import { authorityForApproval, AgentsToolkit } from "./agents-sdk.js";
import type { HarnessApproval, HarnessApprovalSource } from "./agents-sdk.js";

/**
 * The harness integration demonstration (SPEC.md section 17).
 *
 * Four guarantees: the built-in tool route and the local bridge are
 * defined and visible to the agent; a trusted approval narrows into
 * bounded runtime authority while model text grants nothing; remote
 * verification synchronizes local edits through the checkpoint
 * contract before anything runs; and session reopening restores
 * records while stating, plainly, that it never restores the harness
 * conversation.
 */

/** One bench: directories, a store, a session, an attachment, a toolkit. */
interface Bench {
  root: string;
  bridge: string;
  store: ControlStore;
  sessionId: string;
  attachmentId: string;
  adapter: Adapter;
  toolkit: AgentsToolkit;
  /** Recorded approvals the approval flow returned. */
  granted: (HarnessApproval | null)[];
  done(): void;
}

/** The trusted operator base every approval narrows. */
function baseAuthority(): PolicyAuthority {
  return PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: ["local-process"],
    operations: ["exec.process@1", "workspace.fs@1"],
    locations: ["local", "remote"],
    transferDestinations: ["local"],
    networkEgress: "unrestricted",
    hostFilesystemAccess: true,
    maxEnvironmentLifetimeMs: 86_400_000,
    maxResources: {
      memoryBytes: 4 * 1024 ** 3,
      storageBytes: 4 * 1024 ** 3,
      gpuMemoryBytes: 4 * 1024 ** 3,
    },
  });
}

/** The approval flow of a harness that approves what its user clicked. */
function approving(bench: { granted: (HarnessApproval | null)[] }): HarnessApprovalSource {
  return {
    async approve(requested) {
      void requested;
      return bench.granted.shift() ?? null;
    },
  };
}

/** Build one bench with a local-bridge route and one attached worker. */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "porta-harness-"));
  const bridge = join(root, "bridge");
  mkdirSync(bridge);
  writeFileSync(join(bridge, "app.txt"), "v1\n");
  const store = ControlStore.open(join(root, "control.db"));
  const runtime = new PortableRuntime(store);
  const session = await runtime.createSession({ policyRef: "policy://harness" });
  const runsRoot = join(root, "runs");
  mkdirSync(runsRoot);
  const adapter = new LocalProcessAdapter({
    supervisorDir: join(root, "supervisor"),
    workingCopyRoot: runsRoot,
  });
  const attached = await session.attach({
    adapter,
    request: { name: "worker", providerId: "local-process", requires: {} },
    requestKey: "attach-worker-1",
    principal: "user://operator",
    authority: baseAuthority(),
  });
  const holder: { granted: (HarnessApproval | null)[] } = { granted: [] };
  const toolkit = new AgentsToolkit({
    session,
    blobs: new BlobStore(join(root, "blobs"), store),
    route: { decision: "local-bridge", bridgeRootPath: bridge },
    authority: baseAuthority(),
    approvals: approving(holder),
    principal: "user://operator",
    leaseOf: (environmentId) => Promise.resolve(adapter.lease(environmentId)),
    runsRoot,
    harnessContextRef: "agents-sdk://thread/7f3c",
  });
  return {
    root,
    bridge,
    store,
    sessionId: session.id,
    attachmentId: attached.attachmentId,
    adapter,
    toolkit,
    granted: holder.granted,
    done: () => {
      try {
        store.close();
      } catch {
        // The reopen test closes this connection itself.
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the local bridge, file authority, and built-in tool route are defined and visible", async () => {
  const state = await bench();
  try {
    // A local-bridge route offers the checkpoint tool; the route
    // itself rides along on every context update.
    const names = state.toolkit.tools().map((tool) => tool.name);
    assert.deepEqual(names, ["portable_environment", "portable_checkpoint", "portable_run"]);

    const first = await state.toolkit.environmentContext();
    assert.equal(first.builtInToolRoute.decision, "local-bridge");
    assert.equal(first.builtInToolRoute.bridgeRootPath, state.bridge);
    assert.equal(first.workspace.workspaceId.length > 0, true);
    assert.equal(first.workspace.headRevisionId, undefined);
    assert.equal(first.harnessContextRef, "agents-sdk://thread/7f3c");
    const worker = first.attachments.find((entry) => entry.attachmentId === state.attachmentId);
    assert.equal(worker?.status, "active");
    assert.deepEqual(worker?.capabilities, ["exec.process@1"]);
    assert.equal(first.resources.length, 0);

    // Checkpointing the bridge is the synchronization contract: local
    // edits become a durable revision, and the context update reports
    // the new head.
    const tool = state.toolkit.tools().find((entry) => entry.name === "portable_checkpoint")!;
    const outcome = JSON.parse(await tool.execute({})) as {
      status: string;
      revisionId: string;
      created: boolean;
      environment: { workspace: { headRevisionId?: string } };
    };
    assert.equal(outcome.status, "checkpointed");
    assert.equal(outcome.created, true);
    assert.equal(outcome.environment.workspace.headRevisionId, outcome.revisionId);

    // An excluded route names no bridge and offers no checkpoint: all
    // shell and file work stays managed work under Portable policy.
    const store = ControlStore.inMemory();
    const runtime = new PortableRuntime(store);
    const session = await runtime.createSession({ policyRef: "policy://harness" });
    const excluded = new AgentsToolkit({
      session,
      blobs: new BlobStore(join(state.root, "excluded-blobs"), store),
      route: { decision: "excluded" },
      authority: baseAuthority(),
      approvals: approving({ granted: [] }),
      principal: "user://operator",
      leaseOf: () => {
        throw new Error("no environment is attached");
      },
    });
    assert.deepEqual(
      excluded.tools().map((tool) => tool.name),
      ["portable_environment", "portable_run"],
    );
    assert.equal((await excluded.environmentContext()).builtInToolRoute.decision, "excluded");
    await assert.rejects(
      excluded.synchronizeBridge(),
      (error: unknown) =>
        (error as { code?: unknown }).code === "PolicyDenied" &&
        /excluded its built-in tools/.test(String((error as { message?: unknown }).message)),
    );
  } finally {
    state.done();
  }
});

test("a trusted approval narrows authority; model text grants nothing", async () => {
  const state = await bench();
  try {
    const base = baseAuthority();

    // An approved subset narrows: the process capability survives, the
    // file capability the approval never named does not.
    const narrowed = authorityForApproval(base, {
      approvedBy: "user://ada",
      operations: ["exec.process@1"],
    });
    assert.equal(narrowed.checkOperation("exec.process@1", "run"), null);
    assert.ok(narrowed.checkOperation("workspace.fs@1", "read") !== null);

    // An approval cannot widen: a capability the base withholds stays
    // withheld even when the approval names it.
    const widened = authorityForApproval(base, {
      approvedBy: "user://ada",
      operations: ["browser.session@1", "exec.process@1"],
    });
    assert.ok(widened.checkOperation("browser.session@1", "navigate") !== null);
    assert.equal(widened.checkOperation("exec.process@1", "run"), null);

    // An approval with no authenticated approver refuses. Generated
    // text that requests a capability is not an approval, so anything
    // the model strings together dies here.
    const refusesUntrusted = (error: unknown): boolean =>
      (error as { code?: unknown }).code === "InvalidRequest" &&
      /grants nothing/.test(String((error as { message?: unknown }).message));
    assert.throws(
      () => authorityForApproval(base, { approvedBy: "model://turn-12" }),
      refusesUntrusted,
    );
    assert.throws(() => authorityForApproval(base, {} as HarnessApproval), refusesUntrusted);

    // An expired approval grants nothing.
    assert.throws(
      () =>
        authorityForApproval(base, {
          approvedBy: "user://ada",
          operations: ["exec.process@1"],
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      (error: unknown) => (error as { code?: unknown }).code === "PolicyDenied",
    );

    // The run tool asks the approval flow first. No approval: the run
    // refuses as data, and no operation was ever admitted.
    state.granted.push(null);
    const run = state.toolkit.tools().find((tool) => tool.name === "portable_run")!;
    const refused = JSON.parse(await run.execute({ command: "true" })) as {
      status: string;
      code: string;
      environment: { sessionId: string };
    };
    assert.equal(refused.status, "refused");
    assert.equal(refused.code, "no-approval");
    assert.equal(state.store.listOperationsBySession(state.sessionId).length, 0);

    // An approval that omits the process capability leaves the derived
    // authority without it: admission refuses under PolicyDenied.
    state.granted.push({ approvedBy: "user://ada", operations: ["workspace.fs@1"] });
    const denied = JSON.parse(await run.execute({ command: "true" })) as {
      status: string;
      code: string;
    };
    assert.equal(denied.status, "refused");
    assert.equal(denied.code, "PolicyDenied");

    // A covering approval runs the command through the lease, and the
    // tool result carries the environment context update.
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const completed = JSON.parse(
      await run.execute({ command: "printf", args: ["%s", "managed"] }),
    ) as {
      status: string;
      operationId: string;
      result: { exitCode?: number };
      environment: { attachments: { capabilities: string[] }[] };
    };
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.exitCode, 0);
    assert.equal(completed.environment.attachments.length, 1);
    const record = state.store.getOperation(completed.operationId);
    assert.equal(record?.status, "completed");
  } finally {
    state.done();
  }
});

test("a malformed approval expiry grants nothing and reaches no admission", async () => {
  const state = await bench();
  try {
    const base = baseAuthority();
    const refuses = (error: unknown): boolean =>
      (error as { code?: unknown }).code === "InvalidRequest";

    // An expiry that is not a UTC timestamp refuses: malformed text,
    // an impossible calendar date, an empty value, and non-strings.
    for (const expiresAt of [
      "invalid",
      "2026-02-30T00:00:00Z",
      "",
      "2026-09-12 12:00:00",
      123,
      null,
      { moment: "soon" },
    ] as unknown[]) {
      assert.throws(
        () =>
          authorityForApproval(base, {
            approvedBy: "user://ada",
            operations: ["exec.process@1"],
            ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as never }),
          }),
        refuses,
        `refuses ${JSON.stringify(expiresAt)}`,
      );
    }

    // A controlled clock fixes the comparison boundary: an expiry equal
    // to the current time is expired, not active.
    const fixed = Date.parse("2026-09-12T12:00:00Z");
    assert.throws(
      () =>
        authorityForApproval(
          base,
          { approvedBy: "user://ada", operations: ["exec.process@1"], expiresAt: "2026-09-12T12:00:00Z" },
          () => fixed,
        ),
      (error: unknown) => (error as { code?: unknown }).code === "PolicyDenied",
    );

    // A valid future expiry grants a narrowed authority.
    const future = authorityForApproval(
      base,
      { approvedBy: "user://ada", operations: ["exec.process@1"], expiresAt: "3026-09-12T12:00:00Z" },
      () => fixed,
    );
    assert.equal(future.checkOperation("exec.process@1", "run"), null);
    assert.ok(future.checkOperation("workspace.fs@1", "read") !== null);

    // A malformed expiry refuses inside the run tool before admission:
    // no operation record exists, so nothing can reach dispatch.
    const run = state.toolkit.tools().find((tool) => tool.name === "portable_run")!;
    state.granted.push({
      approvedBy: "user://ada",
      operations: ["exec.process@1"],
      expiresAt: "invalid",
    });
    const refused = JSON.parse(await run.execute({ command: "true" })) as {
      status: string;
      code: string;
    };
    assert.equal(refused.status, "refused");
    assert.equal(refused.code, "InvalidRequest");
    assert.equal(state.store.listOperationsBySession(state.sessionId).length, 0);
  } finally {
    state.done();
  }
});

test("remote verification synchronizes local edits before anything runs", async () => {
  const state = await bench();
  try {
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const run = state.toolkit.tools().find((tool) => tool.name === "portable_run")!;
    const answer = JSON.parse(
      await run.execute({ command: "tee", args: ["generated.txt"], verify: true }),
    ) as {
      status: string;
      result: { exitCode?: number };
      verify: {
        synchronizedRevisionId: string;
        synchronizedNewRevision: boolean;
        testedRevisionId: string;
        changedPaths: { path: string; change: string }[];
      };
    };

    // The bridge's edits were synchronized first, and the tested
    // revision is exactly that synchronized revision.
    assert.equal(answer.status, "completed");
    assert.equal(answer.result.exitCode, 0);
    assert.equal(answer.verify.synchronizedNewRevision, true);
    assert.equal(answer.verify.testedRevisionId, answer.verify.synchronizedRevisionId);

    // The run happened inside the private verification copy: the file
    // it wrote is a measured change, and the bridge itself stays
    // untouched.
    assert.deepEqual(answer.verify.changedPaths, [
      { path: "generated.txt", change: "added" },
    ]);
    assert.equal(existsSync(join(state.bridge, "generated.txt")), false);

    // A later local edit is picked up by the next verification: the
    // synchronized revision moves.
    writeFileSync(join(state.bridge, "app.txt"), "v2\n");
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const second = JSON.parse(
      await run.execute({ command: "tee", args: ["generated.txt"], verify: true }),
    ) as { verify: { synchronizedRevisionId: string; testedRevisionId: string } };
    assert.notEqual(second.verify.synchronizedRevisionId, answer.verify.synchronizedRevisionId);
    assert.equal(second.verify.testedRevisionId, second.verify.synchronizedRevisionId);
  } finally {
    state.done();
  }
});

test("reopening restores records and states the limits of conversation restoration", async () => {
  const state = await bench();
  let sessionId = state.sessionId;
  try {
    const checkpoint = await state.toolkit.synchronizeBridge();
    const before = await state.toolkit.environmentContext();
    assert.equal(before.workspace.headRevisionId, checkpoint.revisionId);
    sessionId = state.sessionId;

    // Simulate the harness process dying: a new store connection, a
    // new runtime, the same durable session. Only the supervisor
    // directory and the control database survive.
    state.store.close();
    const store = ControlStore.open(join(state.root, "control.db"));
    const reopened = new AgentsToolkit({
      session: await new PortableRuntime(store).openSession(sessionId),
      blobs: new BlobStore(join(state.root, "blobs"), store),
      route: { decision: "local-bridge", bridgeRootPath: state.bridge },
      authority: baseAuthority(),
      approvals: approving({ granted: [] }),
      principal: "user://operator",
      leaseOf: (environmentId) => Promise.resolve(state.adapter.lease(environmentId)),
      harnessContextRef: "agents-sdk://thread/7f3c",
    });
    const outcome = await reopened.reopen();

    // The durable records came back: the head, the attachment with its
    // capabilities, and the explicit non-claim about the conversation.
    assert.equal(outcome.conversationRestored, false);
    assert.equal(outcome.report.conversationRestored, false);
    assert.equal(outcome.report.workspace.headRevisionId, checkpoint.revisionId);
    assert.equal(outcome.report.attachments.length, 1);
    const context = await reopened.environmentContext();
    assert.equal(context.workspace.headRevisionId, checkpoint.revisionId);
    assert.equal(context.attachments[0]?.capabilities[0], "exec.process@1");

    // The notice states the limits: what reopened, what did not, and
    // where the harness conversation actually lives.
    assert.match(outcome.harnessNotice, /durable records/);
    assert.match(outcome.harnessNotice, /did not restore the harness conversation/);
    assert.match(outcome.harnessNotice, /did not\s+resume the agent loop/);
    assert.match(outcome.harnessNotice, /agents-sdk:\/\/thread\/7f3c/);
    assert.match(outcome.harnessNotice, /uninterpreted/);
    store.close();
  } finally {
    state.done();
  }
});

// -- R2: one request key, one provider invocation ------------------------------

/** One lease whose invoke pauses until the test releases it. */
function gatedLease(
  lease: EnvironmentLease,
  gates: { onEnter(): void; held: Promise<void> },
): EnvironmentLease {
  return {
    environmentId: lease.environmentId,
    ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
    manifest: () => lease.manifest(),
    invoke: async (request) => {
      gates.onEnter();
      await gates.held;
      return lease.invoke(request);
    },
    inspect: (operationId) => lease.inspect(operationId),
    cancel: (operationId) => lease.cancel(operationId),
    bind: (resource, context) => lease.bind(resource, context),
    renew: (expiresAt) => lease.renew(expiresAt),
    release: () => lease.release(),
  };
}

test("one request key reaches one provider invocation across concurrent callers", async () => {
  const state = await bench();
  try {
    // The provider call pauses on a gate, so the first dispatch stays
    // in flight while the second caller reaches the same operation.
    let invocations = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredOnce = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const session = await new PortableRuntime(state.store).openSession(state.sessionId);
    const toolkit = new AgentsToolkit({
      session,
      blobs: new BlobStore(join(state.root, "blobs"), state.store),
      route: { decision: "local-bridge", bridgeRootPath: state.bridge },
      authority: baseAuthority(),
      approvals: approving(state),
      principal: "user://operator",
      leaseOf: async (environmentId) =>
        gatedLease(await state.adapter.lease(environmentId), {
          onEnter: () => {
            invocations += 1;
            entered();
          },
          held,
        }),
      runsRoot: join(state.root, "runs"),
      harnessContextRef: "agents-sdk://thread/7f3c",
    });
    const run = toolkit.tools().find((tool) => tool.name === "portable_run")!;
    const launch = { command: "printf", args: ["%s", "once"], requestKey: "once-1" };

    // Two approvals, two callers, one request key.
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const first = run.execute({ ...launch });
    // The first dispatch holds the provider gate from here on.
    await enteredOnce;
    const second = run.execute({ ...launch });
    release();

    const answers = (await Promise.all([first, second])).map((answer) =>
      JSON.parse(answer as string),
    ) as Array<{ status: string; operationId: string; result?: { exitCode?: number } }>;
    const a = answers[0]!;
    const b = answers[1]!;

    // One logical request, one provider invocation, one effect.
    assert.equal(invocations, 1);
    assert.equal(a.status, "completed");
    assert.equal(a.result?.exitCode, 0);
    assert.equal(b.status, "completed");
    assert.equal(b.operationId, a.operationId);
    assert.equal(b.result?.exitCode, 0);
    const settled = state.store.getOperation(a.operationId);
    assert.equal(settled?.status, "completed");

    // A later caller under the same key reads the recorded result and
    // never reaches the provider again.
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const third = JSON.parse(await run.execute({ ...launch })) as {
      status: string;
      operationId: string;
      result?: { exitCode?: number };
    };
    assert.equal(invocations, 1);
    assert.equal(third.status, "completed");
    assert.equal(third.operationId, a.operationId);
    assert.equal(third.result?.exitCode, 0);
  } finally {
    state.done();
  }
});

// -- F3: recoverable verification preparation ----------------------------------

/** One run answer, with the verification fields the toolkit reports. */
interface RunAnswer {
  status: string;
  code?: string;
  message?: string;
  operationId: string;
  result?: { exitCode?: number };
  verify?: {
    synchronizedRevisionId: string;
    synchronizedNewRevision: boolean;
    testedRevisionId: string;
    verificationCopyId: string;
    changedPaths?: { path: string; change: string }[];
  };
}

/** Build a second toolkit over the same durable session. */
async function secondToolkit(
  state: Bench,
  extras: { runsRoot?: string; leaseOf?: (environmentId: string) => Promise<EnvironmentLease> },
): Promise<AgentsToolkit> {
  const session = await new PortableRuntime(state.store).openSession(state.sessionId);
  return new AgentsToolkit({
    session,
    blobs: new BlobStore(join(state.root, "blobs"), state.store),
    route: { decision: "local-bridge", bridgeRootPath: state.bridge },
    authority: baseAuthority(),
    approvals: approving(state),
    principal: "user://operator",
    leaseOf:
      extras.leaseOf ??
      ((environmentId) => Promise.resolve(state.adapter.lease(environmentId))),
    ...(extras.runsRoot !== undefined ? { runsRoot: extras.runsRoot } : { runsRoot: join(state.root, "runs") }),
    harnessContextRef: "agents-sdk://thread/7f3c",
  });
}

test("a new toolkit instance verifies new requests in the same runs directory", async () => {
  const state = await bench();
  try {
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const first = (await state.toolkit.run({
      command: "true",
      verify: true,
      requestKey: "fresh-1",
    })) as unknown as RunAnswer;
    assert.equal(first.status, "completed");

    // A harness restart: a new toolkit, the same session, the same runs
    // directory. A per-instance counter would reoccupy the first copy.
    const restarted = await secondToolkit(state, {});
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const second = (await restarted.run({
      command: "true",
      verify: true,
      requestKey: "fresh-2",
    })) as unknown as RunAnswer;
    assert.equal(second.status, "completed");
    assert.notEqual(second.verify?.verificationCopyId, first.verify?.verificationCopyId);
  } finally {
    state.done();
  }
});

test("concurrent toolkits prepare one request once and stage distinct copies", async () => {
  const state = await bench();
  try {
    const runsRoot = join(state.root, "runs");
    const before = new Set(readdirSync(runsRoot));
    let invocations = 0;
    const counting = async (environmentId: string): Promise<EnvironmentLease> => {
      const lease = await state.adapter.lease(environmentId);
      const counted: EnvironmentLease = {
        environmentId: lease.environmentId,
        ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
        manifest: () => lease.manifest(),
        invoke: async (request) => {
          invocations += 1;
          return lease.invoke(request);
        },
        inspect: (operationId) => lease.inspect(operationId),
        cancel: (operationId) => lease.cancel(operationId),
        bind: (resource, context) => lease.bind(resource, context),
        renew: (expiresAt) => lease.renew(expiresAt),
        release: () => lease.release(),
      };
      return counted;
    };
    const one = await secondToolkit(state, { leaseOf: counting });
    const two = await secondToolkit(state, { leaseOf: counting });
    const launch = { command: "printf", args: ["%s", "once"], verify: true, requestKey: "verify-once-1" };

    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const answers = (await Promise.all([
      one.run({ ...launch }),
      two.run({ ...launch }),
    ])) as unknown as RunAnswer[];

    // One authoritative preparation, one provider invocation, both callers
    // completed on the same recorded copy.
    assert.equal(invocations, 1);
    assert.equal(answers[0]?.status, "completed");
    assert.equal(answers[1]?.status, "completed");
    assert.equal(answers[1]?.operationId, answers[0]?.operationId);
    assert.equal(answers[1]?.verify?.verificationCopyId, answers[0]?.verify?.verificationCopyId);
    const record = state.store.getExecutionProvenance(answers[0]!.operationId);
    assert.equal(record?.verificationCopyId, answers[0]?.verify?.verificationCopyId);

    // Exactly one staging attempt appeared under the runs directory; the
    // losing attempt removed its own uncommitted directories.
    const added = readdirSync(runsRoot).filter((name) => !before.has(name));
    assert.deepEqual(added.length, 1);
  } finally {
    state.done();
  }
});

test("a completed retry returns its recorded result and tested revision", async () => {
  const state = await bench();
  try {
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const first = (await state.toolkit.run({
      command: "printf",
      args: ["%s", "one"],
      verify: true,
      requestKey: "recorded-1",
    })) as unknown as RunAnswer;
    assert.equal(first.status, "completed");

    // The bridge changes after the run settled. A retry under the same
    // request key must return the recorded outcome, not re-stage: the
    // workspace head stays where the first run left it.
    writeFileSync(join(state.bridge, "app.txt"), "v2\n");
    const headBefore = (await state.toolkit.environmentContext()).workspace.headRevisionId;
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const retry = (await state.toolkit.run({
      command: "printf",
      args: ["%s", "one"],
      verify: true,
      requestKey: "recorded-1",
    })) as unknown as RunAnswer;
    assert.equal(retry.status, "completed");
    assert.equal(retry.operationId, first.operationId);
    assert.deepEqual(retry.result, first.result);
    assert.equal(retry.verify?.testedRevisionId, first.verify?.testedRevisionId);
    assert.equal(retry.verify?.verificationCopyId, first.verify?.verificationCopyId);
    const headAfter = (await state.toolkit.environmentContext()).workspace.headRevisionId;
    assert.equal(headAfter, headBefore);
  } finally {
    state.done();
  }
});

test("a retry adopts the preparation a crashed process recorded", async () => {
  const state = await bench();
  try {
    // Stage a preparation the way the toolkit would, then let the
    // "process die": the operation holds a preparation and no dispatch.
    const session = await new PortableRuntime(state.store).openSession(state.sessionId);
    const blobs = new BlobStore(join(state.root, "blobs"), state.store);
    const authority = baseAuthority();
    const checkpoint = await state.toolkit.synchronizeBridge();
    const head = checkpoint.revisionId;
    const description = await session.describe();
    const attachment = description.attachments.find((entry) => entry.status === "active")!;
    const attachmentRef = {
      sessionId: state.sessionId,
      attachmentId: attachment.attachmentId,
      generation: attachment.generation,
    };
    const admitted = await session.invoke(
      {
        requestKey: "crash-1",
        attachment: attachmentRef,
        capability: "exec.process@1",
        operation: "run",
        input: { command: "tee", args: ["crash.txt"] },
      },
      { authority },
    );
    const attempt = join(state.root, "runs", "run-crashed");
    const copy = await session.materialize(blobs, head, join(attempt, "input"), {
      authority,
      mode: "proposal",
    });
    const prepared = await session.prepareVerificationRun(
      blobs,
      {
        operationId: admitted.id,
        attachment: attachmentRef,
        capability: "exec.process@1",
        operation: "run",
        arguments: { command: "tee", args: ["crash.txt"] },
        workingCopyId: copy.record.id,
      },
      { authority, destination: join(attempt, "verify") },
    );

    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const retry = (await state.toolkit.run({
      command: "tee",
      args: ["crash.txt"],
      verify: true,
      requestKey: "crash-1",
    })) as unknown as RunAnswer;
    assert.equal(retry.status, "completed");
    assert.equal(retry.operationId, admitted.id);
    assert.equal(retry.verify?.verificationCopyId, prepared.verificationCopy.id);
    assert.equal(retry.verify?.testedRevisionId, prepared.provenance.testedRevisionId);
    // The command ran inside the recorded copy: its change is measured.
    assert.deepEqual(retry.verify?.changedPaths, [{ path: "crash.txt", change: "added" }]);
  } finally {
    state.done();
  }
});

test("a refused preparation leaves the operation recoverable", async () => {
  const state = await bench();
  try {
    // The runs root names a file, so staging cannot create directories.
    writeFileSync(join(state.root, "not-a-dir"), "");
    const broken = await secondToolkit(state, { runsRoot: join(state.root, "not-a-dir") });
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const refused = (await broken.run({
      command: "true",
      verify: true,
      requestKey: "recover-1",
    })) as unknown as RunAnswer;
    assert.equal(refused.status, "refused");

    // The failed attempt committed no preparation, so a healthy toolkit
    // retries the same request key and completes it.
    state.granted.push({ approvedBy: "user://ada", operations: ["exec.process@1"] });
    const recovered = (await state.toolkit.run({
      command: "true",
      verify: true,
      requestKey: "recover-1",
    })) as unknown as RunAnswer;
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.operationId !== "", true);
  } finally {
    state.done();
  }
});
