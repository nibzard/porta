import test from "node:test";
import assert from "node:assert/strict";
import { assertValid } from "../schema/validate.js";
import { capabilityDescriptorSchema } from "../schema/capability.js";
import type { ResourceRef } from "../schema/resource.js";
import {
  PROCESS_CAPABILITY_ID,
  PROCESS_OPERATIONS,
  checkProcessAttributes,
  decodeProcessStdin,
  mergeProcessEnvironment,
  processCapabilityDescriptor,
  processRunResultSchema,
  processStartResultSchema,
  processTerminateResultSchema,
  resolveProcessCwd,
  shellInvocation,
  validateProcessInput,
  validateProcessInspectInput,
  validateProcessRunInput,
  validateProcessStartInput,
  validateProcessTerminateInput,
} from "./process-capability.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
function refuse(run: () => unknown): { code: string; details?: unknown } | null {
  try {
    run();
  } catch (error) {
    if (isPortableCode(error)) {
      return error;
    }
    throw error;
  }
  return null;
}

test("the descriptor declares the required operations and attributes", () => {
  const descriptor = processCapabilityDescriptor();
  assertValid(capabilityDescriptorSchema, descriptor);
  assert.equal(descriptor.id, PROCESS_CAPABILITY_ID);
  assert.deepEqual(Object.keys(descriptor.operations).sort(), [...PROCESS_OPERATIONS].sort());

  // The declared attributes parse: matching can rely on them.
  const declared = checkProcessAttributes(descriptor.attributes);
  assert.ok(declared !== null);
  assert.deepEqual(declared.signals, ["SIGTERM", "SIGINT", "SIGKILL"]);
  assert.equal(declared.descendantTermination, "confirmed");
  assert.equal(declared.binaryOutput, true);
  assert.equal(declared.processLifetime, "attachment");

  // Start declares the process resource it creates.
  assert.equal(descriptor.operations.start?.createsResource, "process");
  // Run streams output; terminate is effectful and cancellable.
  assert.equal(descriptor.operations.run?.streaming, true);
  assert.equal(descriptor.operations.terminate?.cancellation, "confirmed");

  // Incomplete or malformed declarations fail instead of narrowing.
  assert.equal(checkProcessAttributes({}), null);
  assert.equal(
    checkProcessAttributes({ ...descriptor.attributes, signals: [] }),
    null,
  );
  assert.equal(
    checkProcessAttributes({ ...descriptor.attributes, descendantTermination: "maybe" }),
    null,
  );
  assert.equal(
    checkProcessAttributes({ ...descriptor.attributes, binaryOutput: "yes" }),
    null,
  );
  assert.equal(
    checkProcessAttributes({ ...descriptor.attributes, processLifetime: "forever" }),
    null,
  );

  // An adapter narrows the reference attributes with its own truth.
  const narrow = processCapabilityDescriptor({
    signals: ["SIGTERM"],
    descendantTermination: "best-effort",
    binaryOutput: false,
    processLifetime: "operation",
  });
  const narrowed = checkProcessAttributes(narrow.attributes);
  assert.ok(narrowed !== null);
  assert.deepEqual(narrowed.signals, ["SIGTERM"]);
  assert.equal(narrowed.processLifetime, "operation");
});

test("launch inputs validate with explicit field semantics", () => {
  const full = validateProcessRunInput({
    command: "python3",
    args: ["-c", "print('hi')"],
    cwd: "analysis",
    env: { PORT: "8080" },
    stdin: "hello",
    stdinEncoding: "utf-8",
    timeoutMs: 5000,
    outputLimits: { maxBytesPerStream: 65536, maxTotalBytes: 131072 },
  });
  assert.equal(full.command, "python3");
  assert.deepEqual(full.args, ["-c", "print('hi')"]);

  // Arguments must be an array: a shell line as a string refuses.
  const stringArgs = refuse(() =>
    validateProcessRunInput({ command: "sh", args: "-c echo hi" }),
  );
  assert.ok(stringArgs !== null && stringArgs.code === "InvalidRequest");

  // Environment names cannot carry an assignment.
  const badEnv = refuse(() => validateProcessRunInput({ command: "ls", env: { "A=B": "1" } }));
  assert.ok(badEnv !== null && badEnv.code === "InvalidRequest");

  // The timeout is a positive whole number.
  for (const timeoutMs of [0, -1, 1.5]) {
    const bad = refuse(() => validateProcessRunInput({ command: "ls", timeoutMs }));
    assert.ok(bad !== null && bad.code === "InvalidRequest");
  }

  // Output limits are positive whole numbers.
  const badLimit = refuse(() =>
    validateProcessRunInput({ command: "ls", outputLimits: { maxBytesPerStream: 0 } }),
  );
  assert.ok(badLimit !== null && badLimit.code === "InvalidRequest");

  // The command itself is required.
  const noCommand = refuse(() => validateProcessRunInput({ args: ["ls"] }));
  assert.ok(noCommand !== null && noCommand.code === "InvalidRequest");

  // Unknown fields refuse: the contract stays closed.
  const extra = refuse(() =>
    validateProcessRunInput({ command: "ls", shellScript: "echo hi" }),
  );
  assert.ok(extra !== null && extra.code === "InvalidRequest");

  // Start validates under the same launch shape; the dispatcher and
  // the direct validator agree.
  const dispatchStarted = validateProcessInput("start", {
    command: "server",
    args: ["--port", "8080"],
    hostAccess: false,
  });
  assert.ok("command" in dispatchStarted && dispatchStarted.command === "server");
  const started = validateProcessStartInput({
    command: "server",
    args: ["--port", "8080"],
    hostAccess: false,
  });
  assert.equal(started.command, "server");

  // Inspect and terminate validate their resource identifier.
  const inspected = validateProcessInspectInput({ resourceId: "res-1" });
  assert.equal(inspected.resourceId, "res-1");
  const terminated = validateProcessTerminateInput({ resourceId: "res-1", signal: "SIGKILL" });
  assert.equal(terminated.signal, "SIGKILL");
  const badSignal = refuse(() =>
    validateProcessTerminateInput({ resourceId: "res-1", signal: "kill -9" }),
  );
  assert.ok(badSignal !== null && badSignal.code === "InvalidRequest");
});

test("shell interpretation needs an explicit shell executable", () => {
  // The blessed path: name the shell, pass the script as one argument.
  const shell = shellInvocation("/bin/sh", "echo hi; echo ho >&2");
  assert.deepEqual(shell, { command: "/bin/sh", args: ["-c", "echo hi; echo ho >&2"] });
  const validated = validateProcessRunInput(shell);
  assert.equal(validated.command, "/bin/sh");
  assert.deepEqual(validated.args, ["-c", "echo hi; echo ho >&2"]);

  // An empty shell or script refuses.
  assert.ok(refuse(() => shellInvocation("", "echo hi")) !== null);
  assert.ok(refuse(() => shellInvocation("/bin/sh", "")) !== null);

  // A command string carrying metacharacters stays one literal
  // executable name; the contract never splits it. Interpretation is
  // the provider's exec call, not a shell.
  const literal = validateProcessRunInput({
    command: "echo hi && rm -rf /",
    args: ["a;b", "|pipe", "$VAR", "*"],
  });
  assert.equal(literal.command, "echo hi && rm -rf /");
  assert.deepEqual(literal.args, ["a;b", "|pipe", "$VAR", "*"]);
});

test("working directories resolve inside the copy unless host access is explicit", () => {
  const bound = { copyRoot: "/workspace/copy", hostAccess: false };

  // An absent directory names the copy root.
  assert.equal(resolveProcessCwd(undefined, bound), "/workspace/copy");
  // A relative path resolves inside the copy.
  assert.equal(resolveProcessCwd("sub/dir", bound), "/workspace/copy/sub/dir");
  assert.equal(resolveProcessCwd("./sub", bound), "/workspace/copy/sub");

  // Escapes and absolute paths refuse without host access.
  const escape = refuse(() => resolveProcessCwd("../out", bound));
  assert.ok(escape !== null && escape.code === "InvalidRequest");
  assert.equal((escape.details as { reason?: string }).reason, "working-directory-escape");
  assert.ok(refuse(() => resolveProcessCwd("/etc", bound)) !== null);

  // Explicit host access allows both.
  const host = { copyRoot: "/workspace/copy", hostAccess: true };
  assert.equal(resolveProcessCwd("../out", host), "/workspace/out");
  assert.equal(resolveProcessCwd("/etc", host), "/etc");
});

test("environment additions merge over the base", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/agent" };
  assert.deepEqual(mergeProcessEnvironment(base), { ...base });
  assert.deepEqual(mergeProcessEnvironment(base, { PATH: "/opt/bin", EXTRA: "1" }), {
    PATH: "/opt/bin",
    HOME: "/home/agent",
    EXTRA: "1",
  });
  // The inputs stay untouched.
  assert.deepEqual(base, { PATH: "/usr/bin", HOME: "/home/agent" });
});

test("standard input decodes under its explicit encoding", () => {
  assert.deepEqual(decodeProcessStdin({}), new Uint8Array(0));
  assert.deepEqual(
    decodeProcessStdin({ stdin: "hi" }),
    new Uint8Array([0x68, 0x69]),
  );
  assert.deepEqual(
    decodeProcessStdin({ stdin: "aGk=", stdinEncoding: "base64" }),
    new Uint8Array([0x68, 0x69]),
  );
  const binary = new Uint8Array([0x00, 0xff, 0x10]);
  const encoded = Buffer.from(binary).toString("base64");
  assert.deepEqual(
    decodeProcessStdin({ stdin: encoded, stdinEncoding: "base64" }),
    binary,
  );
  const malformed = refuse(() =>
    decodeProcessStdin({ stdin: "not base64 !!", stdinEncoding: "base64" }),
  );
  assert.ok(malformed !== null && malformed.code === "InvalidRequest");
});

test("results validate, including termination statements", () => {
  // A completed run: nonzero exit is still completion, not failure.
  assertValid(processRunResultSchema, {
    exitCode: 1,
    timedOut: false,
    stdout: { dataBase64: Buffer.from("hello").toString("base64"), byteLength: 5, truncated: false },
    stderr: { byteLength: 0, truncated: false },
    startedAt: "2026-09-11T00:00:00.000Z",
    endedAt: "2026-09-11T00:00:01.000Z",
  });
  // A timed-out run ends by signal, with truncation accounted.
  assertValid(processRunResultSchema, {
    signal: "SIGKILL",
    timedOut: true,
    stdout: { byteLength: 65536, truncated: true, omittedBytes: 4096 },
    stderr: { byteLength: 0, truncated: false },
    startedAt: "2026-09-11T00:00:00.000Z",
    endedAt: "2026-09-11T00:00:05.000Z",
  });
  // A capture may reference the artifact store instead of inline bytes.
  assertValid(processRunResultSchema, {
    exitCode: 0,
    timedOut: false,
    stdout: { digest: "a".repeat(64), byteLength: 10_000_000, truncated: false },
    stderr: { byteLength: 0, truncated: false },
    startedAt: "2026-09-11T00:00:00.000Z",
    endedAt: "2026-09-11T00:00:02.000Z",
  });

  // Start returns a process resource reference.
  const resource: ResourceRef = {
    id: "res-1",
    sessionId: "sess-1",
    type: "process",
    owner: { sessionId: "sess-1", attachmentId: "att-1", generation: 1 },
    lifetime: "attachment",
    recovery: "none",
  };
  assertValid(processStartResultSchema, {
    resource,
    providerProcessId: "pid-4242",
    startedAt: "2026-09-11T00:00:00.000Z",
  });

  // Terminate states confirmation and descendant stopping explicitly.
  assertValid(processTerminateResultSchema, {
    resourceId: "res-1",
    confirmed: true,
    descendantsStopped: true,
    signal: "SIGTERM",
    state: "terminated",
  });
  assertValid(processTerminateResultSchema, {
    resourceId: "res-1",
    confirmed: false,
    descendantsStopped: false,
    signal: "SIGTERM",
    state: "running",
  });
  // A terminate result without the statements refuses.
  assert.throws(() =>
    assertValid(processTerminateResultSchema, {
      resourceId: "res-1",
      confirmed: true,
      signal: "SIGTERM",
      state: "terminated",
    }),
  );
});
