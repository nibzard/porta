import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalProcessAdapter, PortableRuntime } from "../index.js";
import type { ManagedSession } from "../index.js";
import { BlobStore } from "../store/blob-store.js";
import { ControlStore } from "../store/control-store.js";
import type { AdapterInvocation } from "../schema/adapter.js";

/**
 * The attachment and operation commands, run as child processes
 * (SPEC.md section 16).
 *
 * Three guarantees: request keys and generations reach the library
 * without being regenerated on retries; a completed process failure
 * keeps its process exit code in its result; and long operations
 * return identifiers that later CLI processes still inspect.
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

/** One temporary directory holding a store, a policy, and an adapter. */
interface OperationsFixture {
  root: string;
  store: string;
  policy: string;
  adapter: string;
  supervisor: string;
  sessionId: string;
  attachmentId: string;
  environmentId: string;
  cleanup(): void;
}

/** Build the fixture: one session with one attached local worker. */
function fixture(): OperationsFixture {
  const root = mkdtempSync(join(tmpdir(), "porta-operations-"));
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
    "policy://operations",
    "--store",
    store,
  ]);
  assert.equal(created.code, 0, created.err);
  const sessionId = recordOf(created)["id"] as string;
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
    "user://operations",
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
    supervisor,
    sessionId,
    attachmentId: attachment.attachmentId,
    environmentId: attachment.environmentId ?? "",
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Open the fixture session in-process for execution and settling. */
async function openFixtureSession(fx: OperationsFixture): Promise<ManagedSession> {
  const control = ControlStore.open(fx.store);
  return new PortableRuntime(control).openSession(fx.sessionId);
}

/** Write one invoke request file and return its path. */
function writeInvocation(
  fx: OperationsFixture,
  requestKey: string,
  operation: string,
  input: Record<string, unknown>,
): string {
  const path = join(fx.root, `invoke-${requestKey}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      attachment: { sessionId: fx.sessionId, attachmentId: fx.attachmentId, generation: 1 },
      capability: "exec.process@1",
      operation,
      input,
      requestKey,
    }),
  );
  return path;
}

/** Invoke through the CLI and return the durable operation record. */
function invokeAccepted(
  fx: OperationsFixture,
  requestKey: string,
  operation: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result = run([
    "invoke",
    "--request",
    writeInvocation(fx, requestKey, operation, input),
    "--policy-file",
    fx.policy,
    "--store",
    fx.store,
    "--session",
    fx.sessionId,
  ]);
  assert.equal(result.code, 0, result.err);
  return recordOf(result);
}

/** One adapter dispatch of an admitted operation. */
function dispatchOf(fx: OperationsFixture, operationId: string, operation: string, input: unknown): AdapterInvocation {
  return {
    operationId,
    capability: "exec.process@1",
    operation,
    input,
    environmentId: fx.environmentId,
    limits: {},
  };
}

test("invoke returns durable identifiers that retries reuse and later processes inspect", async () => {
  const fx = fixture();
  try {
    const operation = invokeAccepted(fx, "op-durable-1", "run", {
      command: "/bin/sh",
      args: ["-c", "exit 0"],
    });
    const operationId = operation["id"] as string;
    assert.equal(operation["status"], "accepted");

    // A retry under the same request key returns the same operation;
    // the key is never regenerated.
    const retried = invokeAccepted(fx, "op-durable-1", "run", {
      command: "/bin/sh",
      args: ["-c", "exit 0"],
    });
    assert.equal(retried["id"], operationId);

    // A new CLI process still inspects the record.
    const inspected = run([
      "operation",
      "inspect",
      "--operation",
      operationId,
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(inspected.code, 0, inspected.err);
    assert.equal(recordOf(inspected)["id"], operationId);
  } finally {
    fx.cleanup();
  }
});

test("a completed process failure keeps its exit code in its result", async () => {
  const fx = fixture();
  try {
    const input = { command: "/bin/sh", args: ["-c", "exit 3"] };
    const operation = invokeAccepted(fx, "op-exit-3", "run", input);
    const operationId = operation["id"] as string;

    // The executor side: dispatch, run through the adapter lease, and
    // settle with the recorded result artifact as the reference.
    const session = await openFixtureSession(fx);
    await session.markDispatched(operationId);
    const adapter = new LocalProcessAdapter({ supervisorDir: fx.supervisor });
    const lease = adapter.lease(fx.environmentId);
    const executed = await lease.invoke(dispatchOf(fx, operationId, "run", input));
    assert.equal(executed.status, "completed");
    assert.equal((executed.result as { exitCode?: number }).exitCode, 3);
    const blobs = BlobStore.beside(fx.store, session.controlStore);
    const artifact = await session.artifact(blobs, operationId, {
      data: JSON.stringify(executed.result),
      mediaType: "application/json",
    });
    await session.settle(operationId, {
      kind: "completed",
      resultRef: artifact.retrieval.location,
    });

    // A nonzero process exit is a successful Portable invocation: the
    // inspect exits 0 and reports completion with the result reference.
    const inspected = run([
      "operation",
      "inspect",
      "--operation",
      operationId,
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(inspected.code, 0, inspected.err);
    const record = recordOf(inspected) as { status: string; resultRef?: string };
    assert.equal(record.status, "completed");
    assert.ok(record.resultRef !== undefined);

    // The exit code survives in the recorded result bytes.
    const read = await session.readArtifactBlob(blobs, artifact.digest);
    assert.equal((JSON.parse(Buffer.from(read.data).toString("utf8")) as { exitCode: number }).exitCode, 3);
  } finally {
    fx.cleanup();
  }
});

test("operation cancel stops a started process from another CLI process", async () => {
  const fx = fixture();
  try {
    const input = { command: "/bin/sh", args: ["-c", "sleep 30 & sleep 30; wait"] };
    const operation = invokeAccepted(fx, "op-sleep", "start", input);
    const operationId = operation["id"] as string;

    // The start itself completes at once; the process it started is
    // the resource the still-running operation owns. Its durable
    // handle is the adapter record under the same operation id.
    const session = await openFixtureSession(fx);
    await session.markDispatched(operationId);
    const adapter = new LocalProcessAdapter({ supervisorDir: fx.supervisor });
    const started = await adapter.lease(fx.environmentId).invoke(
      dispatchOf(fx, operationId, "start", input),
    );
    assert.equal(started.status, "completed");
    assert.ok((started.result as { resourceId?: string }).resourceId !== undefined);

    // A separate CLI process cancels through the adapter lease.
    const cancelled = run([
      "operation",
      "cancel",
      "--operation",
      operationId,
      "--adapter",
      fx.adapter,
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(cancelled.code, 0, cancelled.err);
    const cancellation = recordOf(cancelled) as {
      operation: { status: string };
      cancellation: { stopped: boolean };
    };
    assert.equal(cancellation.cancellation.stopped, true);
    assert.equal(cancellation.operation.status, "cancelled");
  } finally {
    fx.cleanup();
  }
});

test("release confirms once and a retry never reaches the provider", async () => {
  const fx = fixture();
  try {
    const released = run([
      "release",
      "--attachment",
      fx.attachmentId,
      "--generation",
      "1",
      "--request-key",
      "release-1",
      "--adapter",
      fx.adapter,
      "--principal",
      "user://operations",
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(released.code, 0, released.err);
    assert.equal(recordOf(released)["status"], "released");

    // The retry under the same key reports the recorded release.
    const retried = run([
      "release",
      "--attachment",
      fx.attachmentId,
      "--generation",
      "1",
      "--request-key",
      "release-1",
      "--adapter",
      fx.adapter,
      "--principal",
      "user://operations",
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    assert.equal(retried.code, 0, retried.err);
    assert.equal(recordOf(retried)["status"], "already-released");

    const described = run([
      "describe",
      "--store",
      fx.store,
      "--session",
      fx.sessionId,
    ]);
    const description = recordOf(described) as { attachments: { status: string }[] };
    assert.equal(description.attachments[0]?.status, "released");
  } finally {
    fx.cleanup();
  }
});
