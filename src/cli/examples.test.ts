import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The documented CLI example, executed (docs/cli.md).
 *
 * Every step runs as a child process against a temporary local
 * workspace, exactly as the documentation shows it. The test proves
 * three things: the commands call the library and validate expected
 * revisions and generations, conflicts leave existing files and
 * authoritative state unchanged, and the documented transcript runs.
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

/** The workspace head of one session, read through `describe`. */
function headOf(store: string, session: string): string {
  const described = recordOf(run(["describe", "--store", store, "--session", session])) as {
    workspace: { headRevisionId?: string };
  };
  return described.workspace.headRevisionId ?? "none";
}

/** One temporary example directory. */
interface Example {
  root: string;
  store: string;
  session: string;
  workspace: string;
  policy: string;
  adapter: string;
  cleanup(): void;
}

/** Build the example directory the documentation walks through. */
function example(): Example {
  const root = mkdtempSync(join(tmpdir(), "porta-example-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "notes.txt"), "first revision\n");
  const store = join(root, "control.db");
  const policy = join(root, "policy.json");
  writeFileSync(
    policy,
    JSON.stringify({
      schemaVersion: 1,
      providers: ["local-process"],
      transferDestinations: ["local"],
    }),
  );
  const indexUrl = new URL("../index.js", import.meta.url).href;
  const adapter = join(root, "worker-adapter.mjs");
  writeFileSync(
    adapter,
    `import { LocalProcessAdapter } from ${JSON.stringify(indexUrl)};\n` +
      `export const adapter = new LocalProcessAdapter({ supervisorDir: ${JSON.stringify(join(root, "supervisor"))} });\n`,
  );
  return {
    root,
    store,
    session: "",
    workspace,
    policy,
    adapter,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the documented example runs against a temporary local workspace", async () => {
  const fx = example();
  try {
    // 1. Create the session.
    const created = run([
      "session",
      "create",
      "--policy-ref",
      "policy://example",
      "--workspace",
      fx.workspace,
      "--store",
      fx.store,
    ]);
    assert.equal(created.code, 0, created.err);
    const sessionId = recordOf(created)["id"] as string;
    assert.ok(sessionId.startsWith("sess-"));

    // 2. Checkpoint the bridge with a declared stability.
    const checkpointRequest = join(fx.root, "checkpoint.json");
    writeFileSync(
      checkpointRequest,
      JSON.stringify({
        requestKey: "checkpoint-1",
        source: { kind: "bridge", rootPath: fx.workspace },
      }),
    );
    const checkpointed = run([
      "checkpoint",
      "--request",
      checkpointRequest,
      "--stability",
      "locked",
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(checkpointed.code, 0, checkpointed.err);
    const revisionId = (recordOf(checkpointed) as { revision: { id: string } }).revision.id;
    assert.equal(headOf(fx.store, sessionId), revisionId);

    // 3. A checkpoint under a moved head refuses and changes nothing.
    const staleRequest = join(fx.root, "checkpoint-stale.json");
    writeFileSync(
      staleRequest,
      JSON.stringify({
        requestKey: "checkpoint-2",
        source: { kind: "bridge", rootPath: fx.workspace },
        expectedHead: "rev-wrong",
      }),
    );
    const stale = run([
      "checkpoint",
      "--request",
      staleRequest,
      "--stability",
      "locked",
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(stale.code, 1, stale.err);
    assert.equal(headOf(fx.store, sessionId), revisionId);

    // 4. Attach one local-process worker under a stable request key.
    const attachRequest = join(fx.root, "attach.json");
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
      fx.adapter,
      "--principal",
      "user://example",
      "--policy-file",
      fx.policy,
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(attached.code, 0, attached.err);
    const attachment = recordOf(attached) as { attachmentId: string; generation: number };
    assert.equal(attachment.generation, 1);

    // A retry under the same key recovers the same attachment.
    const retried = run([
      "attach",
      "--request",
      attachRequest,
      "--request-key",
      "worker-1",
      "--adapter",
      fx.adapter,
      "--principal",
      "user://example",
      "--policy-file",
      fx.policy,
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(retried.code, 0, retried.err);
    assert.equal(recordOf(retried)["attachmentId"], attachment.attachmentId);

    // 5. Materialize a private proposal copy.
    const copyDir = join(fx.root, "copy");
    const materialized = run([
      "materialize",
      "--revision",
      revisionId,
      "--destination",
      copyDir,
      "--mode",
      "proposal",
      "--policy-file",
      fx.policy,
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(materialized.code, 0, materialized.err);
    const copyId = (recordOf(materialized) as { record: { id: string } }).record.id;
    assert.equal(readFileSync(join(copyDir, "notes.txt"), "utf8"), "first revision\n");

    // 6. Edit the copy, then propose it.
    writeFileSync(join(copyDir, "notes.txt"), "second revision\n");
    const proposed = run([
      "workspace",
      "propose",
      "--attachment",
      attachment.attachmentId,
      "--generation",
      "1",
      "--copy",
      copyId,
      "--request-key",
      "propose-1",
      "--stability",
      "locked",
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(proposed.code, 0, proposed.err);
    const proposal = recordOf(proposed) as { proposal: { id: string }; candidate: { id: string } };
    assert.notEqual(proposal.candidate.id, revisionId);

    // A retry under the same key returns the recorded proposal, not a
    // new one.
    const reproposed = run([
      "workspace",
      "propose",
      "--attachment",
      attachment.attachmentId,
      "--generation",
      "1",
      "--copy",
      copyId,
      "--request-key",
      "propose-1",
      "--stability",
      "locked",
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(reproposed.code, 0, reproposed.err);
    const repeated = recordOf(reproposed) as { proposal: { id: string }; created: boolean };
    assert.equal(repeated.proposal.id, proposal.proposal.id);
    assert.equal(repeated.created, false);

    // 7. Acceptance under a wrong expected head refuses and changes
    //    nothing: head, proposal standing, and copy files.
    const refused = run([
      "workspace",
      "accept",
      "--proposal",
      proposal.proposal.id,
      "--expected-head",
      "rev-wrong",
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(refused.code, 1, refused.err);
    assert.deepEqual(refused.out, []);
    assert.equal(headOf(fx.store, sessionId), revisionId);
    assert.equal(readFileSync(join(copyDir, "notes.txt"), "utf8"), "second revision\n");

    // 8. Acceptance under the real head moves it to the candidate.
    const accepted = run([
      "workspace",
      "accept",
      "--proposal",
      proposal.proposal.id,
      "--expected-head",
      revisionId,
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(accepted.code, 0, accepted.err);
    const acceptance = recordOf(accepted) as { revisionId: string; previousHeadRevisionId?: string };
    assert.equal(acceptance.revisionId, proposal.candidate.id);
    assert.equal(acceptance.previousHeadRevisionId, revisionId);
    assert.equal(headOf(fx.store, sessionId), proposal.candidate.id);

    // 9. The journal prints in order and resumes by sequence.
    const events = run(["events", "--store", fx.store, "--session", sessionId]);
    assert.equal(events.code, 0, events.err);
    assert.ok(events.out.length >= 4, "the journal recorded the flow");
    const sequences = events.out.map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    for (let index = 1; index < sequences.length; index += 1) {
      assert.ok(sequences[index]! > sequences[index - 1]!);
    }
    const resumed = run([
      "events",
      "--after",
      String(sequences[2]!),
      "--store",
      fx.store,
      "--session",
      sessionId,
    ]);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(resumed.out.length, events.out.length - 3);
  } finally {
    fx.cleanup();
  }
});
