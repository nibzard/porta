import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PortableRuntime } from "../index.js";
import type { ManagedSession } from "../index.js";
import { PolicyAuthority } from "../core/policy.js";
import { ControlStore } from "../store/control-store.js";
import type { BindResourceInput, BindTransport, ResourceFlowOptions } from "../runtime/resources.js";

/**
 * Replacement, recovery, and events over the CLI (SPEC.md sections 16
 * and 18.1).
 *
 * Three guarantees: plan mode reports state dispositions while it
 * allocates nothing; a completed replacement reports both generations
 * and its journal resumes by sequence; and recovery reports unresolved
 * operations and pending cleanup instead of hiding them.
 */

/** The executable entry point of the CLI. */
const MAIN = fileURLToPath(new URL("./main.js", import.meta.url));

/** Run one CLI child process and capture code, stdout, and stderr. */
function run(args: string[], input?: string): { code: number; out: string[]; err: string } {
  const child = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  assert.ok(child.error === undefined, child.error?.message);
  const out = (child.stdout ?? "").split("\n").filter((line) => line.length > 0);
  return { code: child.status ?? -1, out, err: child.stderr ?? "" };
}

/** One parsed JSON record from one output line. */
function recordOf(result: { out: string[] }): Record<string, unknown> {
  assert.equal(result.out.length, 1, `expected one record, got ${result.out.length}`);
  return JSON.parse(result.out[0]!) as Record<string, unknown>;
}

/** The persisted description of one session, read through `describe`. */
function describeOf(store: string, session: string): Record<string, unknown> {
  const described = run(["describe", "--store", store, "--session", session]);
  assert.equal(described.code, 0, described.err);
  return recordOf(described);
}

/** One temporary directory holding a workspace, store, policy, adapter. */
interface ReplacementFixture {
  root: string;
  store: string;
  policy: string;
  adapter: string;
  workspace: string;
  sessionId: string;
  attachmentId: string;
  environmentId: string;
  revisionId: string;
  cleanup(): void;
}

/** Build the fixture: one checkpointed session with one worker. */
function fixture(): ReplacementFixture {
  const root = mkdtempSync(join(tmpdir(), "porta-replacement-cli-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "app.txt"), "base\n");
  const store = join(root, "control.db");
  const policy = join(root, "policy.json");
  writeFileSync(
    policy,
    JSON.stringify({
      schemaVersion: 1,
      providers: ["local-process"],
      operations: ["exec.process@1"],
      transferDestinations: ["local"],
    }),
  );
  const supervisor = join(root, "supervisor");
  const indexUrl = new URL("../index.js", import.meta.url).href;
  const adapter = join(root, "worker-adapter.mjs");
  writeFileSync(
    adapter,
    `import { LocalProcessAdapter } from ${JSON.stringify(indexUrl)};\n` +
      `export const adapter = new LocalProcessAdapter({ supervisorDir: ${JSON.stringify(supervisor)} });\n`,
  );
  const created = run([
    "session",
    "create",
    "--policy-ref",
    "policy://replacement",
    "--workspace",
    workspace,
    "--store",
    store,
  ]);
  assert.equal(created.code, 0, created.err);
  const sessionId = recordOf(created)["id"] as string;

  const checkpointRequest = join(root, "checkpoint.json");
  writeFileSync(
    checkpointRequest,
    JSON.stringify({
      requestKey: "checkpoint-1",
      source: { kind: "bridge", rootPath: workspace },
    }),
  );
  const checkpointed = run([
    "checkpoint",
    "--request",
    checkpointRequest,
    "--stability",
    "locked",
    "--store",
    store,
    "--session",
    sessionId,
  ]);
  assert.equal(checkpointed.code, 0, checkpointed.err);
  const revisionId = (recordOf(checkpointed) as { revision: { id: string } }).revision.id;

  const attachRequest = join(root, "attach.json");
  writeFileSync(
    attachRequest,
    JSON.stringify({ name: "worker", providerId: "local-process", requires: {} }),
  );
  const attached = run([
    "attach",
    "--request",
    attachRequest,
    "--request-key",
    "worker-1",
    "--adapter",
    adapter,
    "--principal",
    "user://replacement",
    "--policy-file",
    policy,
    "--store",
    store,
    "--session",
    sessionId,
  ]);
  assert.equal(attached.code, 0, attached.err);
  const attachment = recordOf(attached) as { attachmentId: string; environmentId?: string };
  return {
    root,
    store,
    policy,
    adapter,
    workspace,
    sessionId,
    attachmentId: attachment.attachmentId,
    environmentId: attachment.environmentId ?? "",
    revisionId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The bind transport the tests use: it reports every reference bound. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource };
  },
};

/** The authority the in-process bind calls run under. */
const bindOptions: ResourceFlowOptions = {
  authority: PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    operations: ["exec.process@1"],
    transferDestinations: ["local"],
  }),
};

/** One bound resource identifier, bound in-process through the facade. */
async function boundResource(
  fx: ReplacementFixture,
  session: ManagedSession,
  type: string,
  recovery: BindResourceInput["recovery"],
): Promise<string> {
  const description = await session.bindResource(
    {
      type,
      recovery,
      owner: { sessionId: fx.sessionId, attachmentId: fx.attachmentId, generation: 1 },
      capability: "exec.process@1",
      lifetime: "attachment",
    },
    okTransport,
    bindOptions,
  );
  return description.ref.id;
}

/** Identifiers of one resource per recovery mode, bound in-process. */
async function boundResources(
  fx: ReplacementFixture,
): Promise<{ reconstruct: string; reattach: string; native: string; none: string }> {
  const control = ControlStore.open(fx.store);
  const session = await new PortableRuntime(control).openSession(fx.sessionId);
  return {
    reconstruct: await boundResource(fx, session, "process.group", "reconstruct"),
    reattach: await boundResource(fx, session, "browser.session", "reattach"),
    native: await boundResource(fx, session, "interpreter.heap", "native"),
    none: await boundResource(fx, session, "socket", "none"),
  };
}

/** One replacement request, overridable field by field. */
function requestOf(
  fx: ReplacementFixture,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source: { sessionId: fx.sessionId, attachmentId: fx.attachmentId, generation: 1 },
    destination: { requires: {} },
    workspaceRevisionId: fx.revisionId,
    requiredResources: [],
    reconstruct: [],
    activeOperations: "reject",
    requestKey: "replace-1",
    ...overrides,
  };
}

test("plan mode reports state dispositions and allocates nothing", async () => {
  const fx = fixture();
  try {
    const ids = await boundResources(fx);
    const envelope = join(fx.root, "replace-plan.json");
    writeFileSync(
      envelope,
      JSON.stringify({
        request: requestOf(fx, {
          requiredResources: [ids.reconstruct],
          reconstruct: [
            {
              id: "recipe-worker",
              inputRevisionId: fx.revisionId,
              requiredCapabilities: ["exec.process@1"],
              steps: [
                {
                  capability: "exec.process@1",
                  operation: "run",
                  input: { command: "/bin/sh", args: ["-c", "exit 0"] },
                },
              ],
              outputs: [`process.group ${ids.reconstruct}`],
              failureConditions: ["ProviderUnavailable"],
            },
          ],
          requestKey: "replace-plan-1",
        }),
      }),
    );

    const planned = run([
      "replace",
      "--request",
      envelope,
      "--plan",
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(planned.code, 0, planned.err);
    const plan = recordOf(planned) as {
      preserved: { class: string; action: string }[];
      reconstructed: { subject: string }[];
      reattached: { resourceId: string }[];
      invalidated: { resourceId: string }[];
      blockers: unknown[];
    };

    // The workspace content is portable state the transfer carries.
    assert.equal(plan.preserved.length, 1);
    assert.equal(plan.preserved[0]?.class, "portable");
    assert.equal(plan.preserved[0]?.action, "transfer");
    // Each recovery mode lands in its treatment bucket.
    assert.deepEqual(
      plan.reconstructed.map((entry) => entry.subject),
      [`process.group ${ids.reconstruct}`],
    );
    assert.deepEqual(
      plan.reattached.map((entry) => entry.resourceId),
      [ids.reattach],
    );
    assert.deepEqual(
      [...plan.invalidated.map((entry) => entry.resourceId)].sort(),
      [ids.native, ids.none].sort(),
    );
    assert.deepEqual(plan.blockers, []);

    // Planning allocated nothing: the attachment never moved and no
    // destination environment exists.
    const described = describeOf(fx.store, fx.sessionId) as {
      attachments: { attachmentId: string; generation: number; status: string }[];
      unresolvedAllocations: unknown[];
    };
    assert.equal(described.attachments.length, 1);
    assert.equal(described.attachments[0]?.attachmentId, fx.attachmentId);
    assert.equal(described.attachments[0]?.generation, 1);
    assert.equal(described.attachments[0]?.status, "active");
  } finally {
    fx.cleanup();
  }
});

test("replace completes the switch and reports both generations", async () => {
  const fx = fixture();
  try {
    const copyRoot = join(fx.root, "destination-copy");
    const envelope = join(fx.root, "replace.json");
    writeFileSync(
      envelope,
      JSON.stringify({
        request: requestOf(fx, { requestKey: "replace-run-1" }),
        destination: {
          adapterModule: fx.adapter,
          copyRoot,
          principal: "user://replacement",
        },
      }),
    );

    const replaced = run([
      "replace",
      "--request",
      envelope,
      "--policy-file",
      fx.policy,
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(replaced.code, 0, replaced.err);
    const result = recordOf(replaced) as {
      outcome: string;
      oldGeneration?: number;
      newGeneration?: number;
      newEnvironmentId?: string;
      cleanup: { id: string }[];
    };
    assert.equal(result.outcome, "completed");
    assert.equal(result.oldGeneration, 1);
    assert.equal(result.newGeneration, 2);
    assert.ok(result.newEnvironmentId?.startsWith("env-local"));
    // The source environment's release stands as a cleanup obligation.
    assert.ok(result.cleanup.length >= 1);

    // The workspace content arrived in the destination copy.
    assert.equal(readFileSync(join(copyRoot, "app.txt"), "utf8"), "base\n");

    // The switched attachment holds generation 2 on the new
    // environment, and the obligation stays visible until cleanup.
    const described = describeOf(fx.store, fx.sessionId) as {
      attachments: {
        attachmentId: string;
        generation: number;
        status: string;
        environmentId?: string;
      }[];
      pendingCleanup: string[];
    };
    const switched = described.attachments.find(
      (entry) => entry.attachmentId === fx.attachmentId,
    );
    assert.equal(switched?.generation, 2);
    assert.equal(switched?.status, "active");
    assert.equal(switched?.environmentId, result.newEnvironmentId);
    assert.ok(described.pendingCleanup.length >= 1);

    // The journal of the whole flow prints in order and resumes by
    // sequence.
    const events = run(["events", "--store", fx.store, "--session", fx.sessionId]);
    assert.equal(events.code, 0, events.err);
    const sequences = events.out.map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    assert.ok(sequences.length >= 3, "the journal recorded the flow");
    for (let index = 1; index < sequences.length; index += 1) {
      assert.ok(sequences[index]! > sequences[index - 1]!);
    }
    const resumed = run([
      "events",
      "--after",
      String(sequences[sequences.length - 3]!),
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(resumed.out.length, 2);
  } finally {
    fx.cleanup();
  }
});

test("recover reports unresolved operations and pending cleanup", async () => {
  const fx = fixture();
  try {
    // One admitted operation that never settles is in flight exactly
    // as stored.
    const invokeRequest = join(fx.root, "invoke.json");
    writeFileSync(
      invokeRequest,
      JSON.stringify({
        attachment: { sessionId: fx.sessionId, attachmentId: fx.attachmentId, generation: 1 },
        capability: "exec.process@1",
        operation: "run",
        input: { command: "/bin/sh", args: ["-c", "sleep 30"] },
        requestKey: "op-in-flight",
      }),
    );
    const invoked = run([
      "invoke",
      "--request",
      invokeRequest,
      "--policy-file",
      fx.policy,
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(invoked.code, 0, invoked.err);
    const operationId = recordOf(invoked)["id"] as string;

    const recovered = run(["recover", "--store", fx.store, "--session", fx.sessionId]);
    assert.equal(recovered.code, 0, recovered.err);
    const report = recordOf(recovered) as {
      inFlightOperations: { operationId: string; status: string }[];
      conversationRestored: boolean;
      attachments: { needsReconciliation: boolean }[];
    };
    assert.equal(report.inFlightOperations.length, 1);
    assert.equal(report.inFlightOperations[0]?.operationId, operationId);
    assert.equal(report.inFlightOperations[0]?.status, "accepted");
    // Reopening restores records, never a conversation.
    assert.equal(report.conversationRestored, false);
    assert.equal(report.attachments[0]?.needsReconciliation, false);

    // A provider that will not confirm the release leaves an
    // unresolved outcome and a pending cleanup obligation.
    const failing = join(fx.root, "unreleasing-adapter.mjs");
    writeFileSync(
      failing,
      `import { LocalProcessAdapter } from ${JSON.stringify(new URL("../index.js", import.meta.url).href)};\n` +
        `const inner = new LocalProcessAdapter({ supervisorDir: ${JSON.stringify(join(fx.root, "supervisor"))} });\n` +
        `const wrap = (lease) => ({\n` +
        `  manifest: () => lease.manifest(),\n` +
        `  invoke: (r) => lease.invoke(r),\n` +
        `  inspect: (id) => lease.inspect(id),\n` +
        `  cancel: (id) => lease.cancel(id),\n` +
        `  bind: (r, c) => lease.bind(r, c),\n` +
        `  renew: (e) => lease.renew(e),\n` +
        `  release: async () => ({ status: "failed", retryable: true, detail: "The provider is down for this test." }),\n` +
        `});\n` +
        `export const adapter = {\n` +
        `  describe: () => inner.describe(),\n` +
        `  acquire: async (request) => wrap(await inner.acquire(request)),\n` +
        `  reconcile: (id) => inner.reconcile(id),\n` +
        `  lease: (environmentId) => wrap(inner.lease(environmentId)),\n` +
        `};\n`,
    );
    const released = run([
      "release",
      "--attachment",
      fx.attachmentId,
      "--generation",
      "1",
      "--request-key",
      "release-1",
      "--adapter",
      failing,
      "--principal",
      "user://replacement",
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(released.code, 3, released.err);
    assert.equal(recordOf(released)["status"], "unresolved");

    const described = describeOf(fx.store, fx.sessionId) as { pendingCleanup: string[] };
    assert.ok(described.pendingCleanup.length >= 1);

    // Recovery reports the reconciliation the attachment still needs.
    const recoveredAgain = run(["recover", "--store", fx.store, "--session", fx.sessionId]);
    assert.equal(recoveredAgain.code, 0, recoveredAgain.err);
    const after = recordOf(recoveredAgain) as {
      attachments: { needsReconciliation: boolean }[];
    };
    assert.equal(after.attachments[0]?.needsReconciliation, true);
  } finally {
    fx.cleanup();
  }
});
