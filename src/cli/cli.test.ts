import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, USAGE } from "./cli.js";
import {
  FakeEnvironmentAdapter,
  PolicyAuthority,
  PortableRuntime,
  providerUnavailableError,
  VERSION,
} from "../index.js";
import { ControlStore } from "../store/control-store.js";

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out(line: string): void {
        out.push(line);
      },
      err(line: string): void {
        err.push(line);
      },
    },
  };
}

/** Run the CLI in-process and capture its code and output. */
async function cli(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const rec = recordingIo();
  const code = await runCli(args, rec.io);
  return { code, out: rec.out, err: rec.err };
}

/** One parsed JSON record from one output line. */
function recordOf(line: string | undefined): Record<string, unknown> {
  assert.ok(line !== undefined, "the command printed no record");
  return JSON.parse(line) as Record<string, unknown>;
}

/** Clear the PORTABLE_* variables and return the restore function. */
function clearPortableEnv(): () => void {
  const keys = ["PORTABLE_STORE", "PORTABLE_POLICY", "PORTABLE_SESSION"];
  const saved = keys.map((key) => process.env[key]);
  for (const key of keys) {
    delete process.env[key];
  }
  return () => {
    keys.forEach((key, index) => {
      if (saved[index] !== undefined) {
        process.env[key] = saved[index];
      }
    });
  };
}

/** One CLI fixture: a store, a session created through the CLI, a policy. */
interface Fixture {
  root: string;
  storePath: string;
  policyPath: string;
  sessionId: string;
  runtime: PortableRuntime;
  restoreEnv: () => void;
}

/** Build one fixture; every test cleans up with `rmSync(f.root)`. */
async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "porta-cli-"));
  const restoreEnv = clearPortableEnv();
  const storePath = join(root, "control.db");
  const policyPath = join(root, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: 1,
      providers: ["fake-local"],
      operations: ["exec.process@1/run"],
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
    }),
  );
  const created = await cli([
    "session",
    "create",
    "--policy-ref",
    "policy://cli",
    "--store",
    storePath,
  ]);
  assert.equal(created.code, 0, created.err.join("\n"));
  const sessionId = recordOf(created.out[0])["id"] as string;
  const runtime = new PortableRuntime(ControlStore.open(storePath));
  return { root, storePath, policyPath, sessionId, runtime, restoreEnv };
}

/** Checkpoint one bridge directory through the CLI and return the revision. */
async function bridgeCheckpoint(fx: Fixture, requestKey = "cp-1"): Promise<string> {
  const bridgeRoot = join(fx.root, "bridge");
  mkdirSync(bridgeRoot);
  writeFileSync(join(bridgeRoot, "notes.txt"), "first\n");
  const requestPath = join(fx.root, "checkpoint.json");
  writeFileSync(
    requestPath,
    JSON.stringify({
      requestKey,
      source: { kind: "bridge", rootPath: bridgeRoot },
    }),
  );
  const result = await cli([
    "checkpoint",
    "--request",
    requestPath,
    "--stability",
    "locked",
    "--store",
    fx.storePath,
    "--session",
    fx.sessionId,
  ]);
  assert.equal(result.code, 0, result.err.join("\n"));
  const outcome = recordOf(result.out[0]) as { revision: { id: string } };
  return outcome.revision.id;
}

/** Attach one worker through the library, for commands to operate on. */
async function attachWorker(fx: Fixture): Promise<string> {
  const session = await fx.runtime.openSession(fx.sessionId);
  const attached = await session.attach({
    adapter: new FakeEnvironmentAdapter(),
    request: {
      name: "worker",
      providerId: "fake-local",
      requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
    },
    requestKey: "attach-fixture-1",
    principal: "user://cli",
    authority: PolicyAuthority.fromPolicy({
      schemaVersion: 1,
      providers: ["fake-local"],
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
  });
  return attached.attachmentId;
}

/** Write one invoke request file for the fixture's worker. */
function writeInvokeRequest(fx: Fixture, attachmentId: string, requestKey: string): string {
  const path = join(fx.root, `${requestKey}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      attachment: { sessionId: fx.sessionId, attachmentId, generation: 1 },
      capability: "exec.process@1",
      operation: "run",
      input: { command: "echo", args: ["hi"] },
      requestKey,
    }),
  );
  return path;
}

/** Write one adapter module exporting a fresh fake adapter. */
function writeAdapterModule(fx: Fixture, name: string): string {
  const indexUrl = new URL("../index.js", import.meta.url).href;
  const path = join(fx.root, name);
  writeFileSync(
    path,
    `import { FakeEnvironmentAdapter } from ${JSON.stringify(indexUrl)};\n` +
      `export const adapter = new FakeEnvironmentAdapter();\n`,
  );
  return path;
}

// -- Standalone options ------------------------------------------------------

test("--version prints the library version and exits 0", async () => {
  const rec = recordingIo();
  const code = await runCli(["--version"], rec.io);
  assert.equal(code, 0);
  assert.deepEqual(rec.out, [VERSION]);
  assert.deepEqual(rec.err, []);
});

test("-v prints the library version and exits 0", async () => {
  const rec = recordingIo();
  assert.equal(await runCli(["-v"], rec.io), 0);
  assert.deepEqual(rec.out, [VERSION]);
});

test("--help prints usage and exits 0", async () => {
  const rec = recordingIo();
  const code = await runCli(["--help"], rec.io);
  assert.equal(code, 0);
  assert.deepEqual(rec.out, [USAGE]);
  assert.deepEqual(rec.err, []);
});

test("no arguments prints usage and exits 0", async () => {
  const rec = recordingIo();
  assert.equal(await runCli([], rec.io), 0);
  assert.deepEqual(rec.out, [USAGE]);
});

test("unknown command writes diagnostics to stderr and exits 2", async () => {
  const rec = recordingIo();
  const code = await runCli(["frobnicate"], rec.io);
  assert.equal(code, 2);
  assert.deepEqual(rec.out, []);
  assert.ok(rec.err[0]?.includes("Unknown command or option: frobnicate"));
});

test("extra arguments after --version exit 2", async () => {
  const rec = recordingIo();
  assert.equal(await runCli(["--version", "--json"], rec.io), 2);
  assert.deepEqual(rec.out, []);
  assert.ok(rec.err[0]?.includes("Unexpected argument"));
});

// -- Configuration honesty ---------------------------------------------------

test("a missing store or session is invalid input, never a guess", async () => {
  const restoreEnv = clearPortableEnv();
  try {
    const noStore = await cli(["describe"]);
    assert.equal(noStore.code, 2);
    assert.deepEqual(noStore.out, []);
    assert.ok(noStore.err[0]?.includes("Pass --store PATH"));

    const root = mkdtempSync(join(tmpdir(), "porta-cli-"));
    try {
      const noSession = await cli(["describe", "--store", join(root, "control.db")]);
      assert.equal(noSession.code, 2);
      assert.ok(noSession.err[0]?.includes("never guesses"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    restoreEnv();
  }
});

test("PORTABLE_STORE and PORTABLE_SESSION resolve like their flags", async () => {
  const fx = await fixture();
  try {
    process.env["PORTABLE_STORE"] = fx.storePath;
    process.env["PORTABLE_SESSION"] = fx.sessionId;
    const result = await cli(["describe"]);
    assert.equal(result.code, 0, result.err.join("\n"));
    const description = recordOf(result.out[0]) as { session: { id: string } };
    assert.equal(description.session.id, fx.sessionId);
  } finally {
    delete process.env["PORTABLE_STORE"];
    delete process.env["PORTABLE_SESSION"];
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// -- Session lifecycle -------------------------------------------------------

test("session create prints one JSON session record and exits 0", async () => {
  const fx = await fixture();
  try {
    const again = await cli([
      "session",
      "create",
      "--policy-ref",
      "policy://other",
      "--store",
      fx.storePath,
    ]);
    assert.equal(again.code, 0, again.err.join("\n"));
    assert.equal(again.out.length, 1);
    const record = recordOf(again.out[0]) as { id: string; status: string; workspaceId: string };
    assert.ok(record.id.startsWith("sess-"));
    assert.equal(record.status, "open");
    assert.ok(record.workspaceId.startsWith("ws-"));
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("describe prints the persisted description of the named session", async () => {
  const fx = await fixture();
  try {
    const result = await cli([
      "describe",
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(result.code, 0, result.err.join("\n"));
    assert.deepEqual(result.err, []);
    const description = recordOf(result.out[0]) as {
      session: { id: string };
      workspace: { workspaceId: string };
    };
    assert.equal(description.session.id, fx.sessionId);
    assert.ok(description.workspace.workspaceId.startsWith("ws-"));
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// -- Workspace and journal ---------------------------------------------------

test("checkpoint reads a request file and prints the outcome", async () => {
  const fx = await fixture();
  try {
    const revisionId = await bridgeCheckpoint(fx);
    assert.ok(revisionId.length > 0);
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("events prints the journal as newline-delimited JSON", async () => {
  const fx = await fixture();
  try {
    await bridgeCheckpoint(fx);
    const result = await cli(["events", "--store", fx.storePath, "--session", fx.sessionId]);
    assert.equal(result.code, 0, result.err.join("\n"));
    assert.ok(result.out.length >= 1);
    const events = result.out.map((line) => JSON.parse(line) as { sequence: number });
    for (let index = 1; index < events.length; index += 1) {
      assert.ok(events[index]!.sequence > events[index - 1]!.sequence);
    }
    const tailed = await cli([
      "events",
      "--after",
      String(events[0]!.sequence),
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(tailed.code, 0);
    const tail = tailed.out.map((line) => JSON.parse(line) as { sequence: number });
    assert.equal(tail.length, events.length - 1);
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workspace accept refuses a moved head as a known failure", async () => {
  const fx = await fixture();
  try {
    const result = await cli([
      "workspace",
      "accept",
      "--proposal",
      "prop-none",
      "--expected-head",
      "rev-wrong",
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, []);
    assert.ok(result.err[0]?.includes("moved past the expected base"));
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// -- Operations ---------------------------------------------------------------

test("invoke admits through a policy file and prints the durable operation", async () => {
  const fx = await fixture();
  try {
    const attachmentId = await attachWorker(fx);
    const requestPath = writeInvokeRequest(fx, attachmentId, "op-cli-1");
    const result = await cli([
      "invoke",
      "--request",
      requestPath,
      "--policy-file",
      fx.policyPath,
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(result.code, 0, result.err.join("\n"));
    const operation = recordOf(result.out[0]) as {
      id: string;
      status: string;
      attachment: { attachmentId: string };
    };
    assert.equal(operation.status, "accepted");
    assert.equal(operation.attachment.attachmentId, attachmentId);

    const inspected = await cli([
      "operation",
      "inspect",
      "--operation",
      operation.id,
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(inspected.code, 0);
    assert.equal(recordOf(inspected.out[0])["status"], "accepted");

    // A lost response settles unknown; inspection reports it and exits 3.
    const session = await fx.runtime.openSession(fx.sessionId);
    await session.settle(operation.id, {
      kind: "unknown",
      error: providerUnavailableError("The response was lost."),
    });
    const unknown = await cli([
      "operation",
      "inspect",
      "--operation",
      operation.id,
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(unknown.code, 3);
    assert.equal(recordOf(unknown.out[0])["status"], "unknown");
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

/** Invoke one accepted operation through the CLI and return its record. */
async function invokeAccepted(fx: Fixture, requestKey: string): Promise<{ id: string }> {
  const attachmentId = await attachWorker(fx);
  const requestPath = writeInvokeRequest(fx, attachmentId, requestKey);
  const invoked = await cli([
    "invoke",
    "--request",
    requestPath,
    "--policy-file",
    fx.policyPath,
    "--store",
    fx.storePath,
    "--session",
    fx.sessionId,
  ]);
  assert.equal(invoked.code, 0, invoked.err.join("\n"));
  return recordOf(invoked.out[0]) as { id: string };
}

test("an adapter module without an adapter export is invalid input", async () => {
  const fx = await fixture();
  try {
    const operation = await invokeAccepted(fx, "op-cli-2");
    const path = join(fx.root, "not-an-adapter.mjs");
    writeFileSync(path, "export const nothing = 1;\n");
    const result = await cli([
      "operation",
      "cancel",
      "--operation",
      operation.id,
      "--adapter",
      path,
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(result.code, 2);
    assert.ok(result.err[0]?.includes("exports no `adapter`"));
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("operation cancel reports a known failure when the provider fails", async () => {
  const fx = await fixture();
  try {
    const operation = await invokeAccepted(fx, "op-cli-3");
    const indexUrl = new URL("../index.js", import.meta.url).href;
    const adapterPath = join(fx.root, "unreachable-adapter.mjs");
    writeFileSync(
      adapterPath,
      `import { providerUnavailableError } from ${JSON.stringify(indexUrl)};\n` +
        `const unreachable = providerUnavailableError("The provider is unreachable.");\n` +
        `const lease = {\n` +
        `  environmentId: "env-unreachable",\n` +
        `  manifest: async () => { throw unreachable; },\n` +
        `  invoke: async () => { throw unreachable; },\n` +
        `  inspect: async () => { throw unreachable; },\n` +
        `  cancel: async () => { throw unreachable; },\n` +
        `  bind: async () => { throw unreachable; },\n` +
        `  renew: async () => { throw unreachable; },\n` +
        `  release: async () => { throw unreachable; },\n` +
        `};\n` +
        `export const adapter = {\n` +
        `  async acquire() { throw unreachable; },\n` +
        `  lease: () => lease,\n` +
        `};\n`,
    );
    const result = await cli([
      "operation",
      "cancel",
      "--operation",
      operation.id,
      "--adapter",
      adapterPath,
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, []);
    assert.ok(result.err[0]?.includes("The provider is unreachable."));
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// -- Attachment and replacement ----------------------------------------------

test("attach loads the operator-named adapter module and prints the summary", async () => {
  const fx = await fixture();
  try {
    const adapterPath = writeAdapterModule(fx, "worker-adapter.mjs");
    const requestPath = join(fx.root, "attach.json");
    writeFileSync(
      requestPath,
      JSON.stringify({
        name: "worker",
        providerId: "fake-local",
        requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
      }),
    );
    const result = await cli([
      "attach",
      "--request",
      requestPath,
      "--request-key",
      "attach-cli-1",
      "--adapter",
      adapterPath,
      "--principal",
      "user://cli",
      "--policy-file",
      fx.policyPath,
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(result.code, 0, result.err.join("\n"));
    const summary = recordOf(result.out[0]) as {
      attachmentId: string;
      generation: number;
      environmentId?: string;
    };
    assert.ok(summary.attachmentId.length > 0);
    assert.equal(summary.generation, 1);
    assert.ok(summary.environmentId !== undefined);
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("replace --plan prints a plan without side effects", async () => {
  const fx = await fixture();
  try {
    const attachmentId = await attachWorker(fx);
    const revisionId = await bridgeCheckpoint(fx);
    const requestPath = join(fx.root, "replace.json");
    writeFileSync(
      requestPath,
      JSON.stringify({
        request: {
          source: { sessionId: fx.sessionId, attachmentId, generation: 1 },
          destination: { requires: {} },
          workspaceRevisionId: revisionId,
          requiredResources: [],
          reconstruct: [],
          activeOperations: "reject",
          requestKey: "replace-plan-1",
        },
      }),
    );
    const result = await cli([
      "replace",
      "--plan",
      "--request",
      requestPath,
      "--store",
      fx.storePath,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(result.code, 0, result.err.join("\n"));
    const plan = recordOf(result.out[0]) as {
      attachmentId: string;
      blockers: unknown[];
    };
    assert.equal(plan.attachmentId, attachmentId);
    assert.deepEqual(plan.blockers, []);

    // Planning moved no attachment and no head.
    const session = await fx.runtime.openSession(fx.sessionId);
    const description = await session.describe();
    assert.equal(description.attachments[0]?.generation, 1);
    assert.equal(description.workspace.headRevisionId, revisionId);
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// -- Standard input and the executable ----------------------------------------

test("a request on standard input needs no shell interpolation", async () => {
  const fx = await fixture();
  try {
    const mainPath = fileURLToPath(new URL("./main.js", import.meta.url));
    const bridgeRoot = join(fx.root, "bridge");
    mkdirSync(bridgeRoot);
    writeFileSync(join(bridgeRoot, "notes.txt"), "from stdin\n");
    const request = JSON.stringify({
      requestKey: "cp-stdin",
      source: { kind: "bridge", rootPath: bridgeRoot },
    });
    const child = spawnSync(
      process.execPath,
      [
        mainPath,
        "checkpoint",
        "--request",
        "-",
        "--stability",
        "locked",
        "--store",
        fx.storePath,
        "--session",
        fx.sessionId,
      ],
      { input: request, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const outcome = JSON.parse(child.stdout.trim()) as { revision: { id: string } };
    assert.ok(outcome.revision.id.length > 0);

    const version = spawnSync(process.execPath, [mainPath, "--version"], { encoding: "utf8" });
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), VERSION);
  } finally {
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});
