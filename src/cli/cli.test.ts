import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("extra command words are invalid grammar, not a matched prefix", async () => {
  const restoreEnv = clearPortableEnv();
  const root = mkdtempSync(join(tmpdir(), "porta-cli-"));
  try {
    const db = join(root, "control.db");
    // The matched prefix must consume every command word: an extra
    // word is an unknown command, whatever its prefix matches.
    const extra = await cli([
      "session",
      "create",
      "accidental-extra-word",
      "--policy-ref",
      "policy://review",
      "--store",
      db,
    ]);
    assert.equal(extra.code, 2);
    assert.deepEqual(extra.out, []);
    assert.ok(extra.err[0]?.includes("Unknown command"));
    assert.equal(existsSync(db), false, "no database may appear");

    // Multiword commands reject extra words the same way.
    const opExtra = await cli([
      "operation",
      "inspect",
      "extra",
      "--operation",
      "op-1",
      "--store",
      db,
      "--session",
      "ses_x",
    ]);
    assert.equal(opExtra.code, 2);
    assert.ok(opExtra.err[0]?.includes("Unknown command"));

    // A valid command still runs and accepts --json everywhere.
    const created = await cli([
      "session",
      "create",
      "--policy-ref",
      "policy://review",
      "--store",
      db,
      "--json",
    ]);
    assert.equal(created.code, 0, created.err.join("\n"));
    assert.equal(typeof recordOf(created.out[0])["id"], "string");
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("misplaced boolean options exit 2 without side effects", async () => {
  const restoreEnv = clearPortableEnv();
  const root = mkdtempSync(join(tmpdir(), "porta-cli-"));
  try {
    const db = join(root, "control.db");
    // --plan belongs to replace alone; effect and payment grants
    // belong to the conformance command alone.
    const misplaced: Array<[string[], string]> = [
      [["describe", "--plan", "--store", db, "--session", "ses_x"], "--plan"],
      [["describe", "--external-effects", "--store", db, "--session", "ses_x"], "--external-effects"],
      [["describe", "--paid-allocation", "--store", db, "--session", "ses_x"], "--paid-allocation"],
      [["session", "create", "--plan", "--policy-ref", "policy://review", "--store", db], "--plan"],
    ];
    for (const [args, flag] of misplaced) {
      const result = await cli(args);
      assert.equal(result.code, 2, `${flag} on ${args[0]} must be invalid grammar`);
      assert.ok(
        result.err[0]?.includes(`Option ${flag} does not apply`),
        `${flag}: ${result.err[0]}`,
      );
    }
    assert.equal(existsSync(db), false, "no database may appear");
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
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

test("PORTABLE_POLICY admits attach, invoke, and materialize without the flag", async () => {
  const fx = await fixture();
  try {
    process.env["PORTABLE_STORE"] = fx.storePath;
    process.env["PORTABLE_SESSION"] = fx.sessionId;
    process.env["PORTABLE_POLICY"] = fx.policyPath;

    // Attach needs no --policy-file: the environment names the document.
    const adapterPath = writeAdapterModule(fx, "env-adapter.mjs");
    const attachRequest = join(fx.root, "attach.json");
    writeFileSync(
      attachRequest,
      JSON.stringify({
        name: "worker",
        providerId: "fake-local",
        requires: { "exec.process@1": { engine: { equals: "fake-process" } } },
      }),
    );
    const attached = await cli([
      "attach",
      "--request",
      attachRequest,
      "--request-key",
      "attach-env-1",
      "--adapter",
      adapterPath,
      "--principal",
      "user://cli",
    ]);
    assert.equal(attached.code, 0, attached.err.join("\n"));
    const attachmentId = (recordOf(attached.out[0]) as { attachmentId: string }).attachmentId;

    // Invoke runs under the environment policy too.
    const invoked = await cli([
      "invoke",
      "--request",
      writeInvokeRequest(fx, attachmentId, "op-env-1"),
    ]);
    assert.equal(invoked.code, 0, invoked.err.join("\n"));
    assert.equal(recordOf(invoked.out[0])["status"], "accepted");

    // Materialize needs the environment policy for its transfer checks.
    const revisionId = await bridgeCheckpoint(fx, "cp-env-1");
    const destination = join(fx.root, "copy");
    const materialized = await cli([
      "materialize",
      "--revision",
      revisionId,
      "--destination",
      destination,
      "--mode",
      "read-only",
    ]);
    assert.equal(materialized.code, 0, materialized.err.join("\n"));
    assert.ok(existsSync(join(destination, "notes.txt")));
  } finally {
    delete process.env["PORTABLE_STORE"];
    delete process.env["PORTABLE_SESSION"];
    delete process.env["PORTABLE_POLICY"];
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("an explicit --policy-file wins over PORTABLE_POLICY", async () => {
  const fx = await fixture();
  try {
    const attachmentId = await attachWorker(fx);
    const requestPath = writeInvokeRequest(fx, attachmentId, "op-precedence-1");

    // The environment names a policy that grants no operation. The flag
    // names the fixture's permissive policy; the flag must win.
    const denyPath = join(fx.root, "deny.json");
    writeFileSync(
      denyPath,
      JSON.stringify({
        schemaVersion: 1,
        providers: ["fake-local"],
        operations: [],
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
    process.env["PORTABLE_STORE"] = fx.storePath;
    process.env["PORTABLE_SESSION"] = fx.sessionId;
    process.env["PORTABLE_POLICY"] = denyPath;
    const granted = await cli(["invoke", "--request", requestPath, "--policy-file", fx.policyPath]);
    assert.equal(granted.code, 0, granted.err.join("\n"));

    // An invalid explicit file never falls back to the environment: the
    // invocation fails as invalid input instead of borrowing the valid
    // policy from PORTABLE_POLICY.
    process.env["PORTABLE_POLICY"] = fx.policyPath;
    const invalid = await cli([
      "invoke",
      "--request",
      requestPath,
      "--policy-file",
      join(fx.root, "missing.json"),
    ]);
    assert.equal(invalid.code, 2);
    assert.ok(invalid.err[0]?.includes("does not exist or does not read"));

    // The same request under the denying environment policy alone fails
    // as a known denial, proving the first invocation used the flag.
    process.env["PORTABLE_POLICY"] = denyPath;
    const denied = await cli(["invoke", "--request", writeInvokeRequest(fx, attachmentId, "op-precedence-2")]);
    assert.equal(denied.code, 1);
    assert.ok(denied.err[0]?.includes("not allowed"));
  } finally {
    delete process.env["PORTABLE_STORE"];
    delete process.env["PORTABLE_SESSION"];
    delete process.env["PORTABLE_POLICY"];
    fx.restoreEnv();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("missing or empty policy configuration exits 2 with a clear error", async () => {
  const fx = await fixture();
  try {
    process.env["PORTABLE_STORE"] = fx.storePath;
    process.env["PORTABLE_SESSION"] = fx.sessionId;
    const attachmentId = await attachWorker(fx);
    const requestPath = writeInvokeRequest(fx, attachmentId, "op-missing-policy-1");

    // Nothing names a policy document.
    const absent = await cli(["invoke", "--request", requestPath]);
    assert.equal(absent.code, 2);
    assert.deepEqual(absent.out, []);
    assert.ok(absent.err[0]?.includes("needs a policy authority"));
    assert.ok(absent.err[0]?.includes("PORTABLE_POLICY"));

    // An empty value is absent, not a path.
    process.env["PORTABLE_POLICY"] = "";
    const empty = await cli(["invoke", "--request", requestPath]);
    assert.equal(empty.code, 2);
    assert.ok(empty.err[0]?.includes("needs a policy authority"));
  } finally {
    delete process.env["PORTABLE_STORE"];
    delete process.env["PORTABLE_SESSION"];
    delete process.env["PORTABLE_POLICY"];
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

test("invalid policy refuses before opening the store or loading adapter code", async () => {
  const root = mkdtempSync(join(tmpdir(), "porta-policy-order-"));
  try {
    const marker = join(root, "loaded");
    const module = join(root, "adapter.mjs");
    writeFileSync(module, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export const adapter = {acquire: async () => {}};`);
    const request = join(root, "request.json");
    writeFileSync(request, JSON.stringify({name: "worker", requires: {}}));
    for (const content of [undefined, "{", JSON.stringify({schemaVersion: 1, providers: 42})]) {
      const policy = join(root, "policy.json");
      if (content !== undefined) writeFileSync(policy, content);
      for (const command of ["attach", "invoke", "materialize"]) {
        const db = join(root, `${command}.db`);
        const args = command === "attach"
          ? ["--request", request, "--request-key", "test", "--adapter", module, "--principal", "user://test"]
          : command === "invoke" ? ["--request", request]
          : ["--revision", "rev-test", "--destination", join(root, "copy"), "--mode", "proposal"];
        const {io, err} = recordingIo();
        assert.equal(await runCli([command, "--store", db, "--session", "missing", "--policy-file", policy, ...args], io), 2, err.join("\n"));
        assert.equal(existsSync(db), false);
        assert.equal(existsSync(marker), false);
      }
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});
