import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { PolicyAuthority } from "../core/policy.js";
import { PortableRuntime } from "../runtime/session.js";
import { LocalProcessAdapter } from "../adapters/local-process-adapter.js";
import type { LocalProcessAdapter as Adapter } from "../adapters/local-process-adapter.js";
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
    transferDestinations: ["local"],
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
