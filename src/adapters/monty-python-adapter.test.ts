import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterOperation, EnvironmentLease } from "../schema/adapter.js";
import type { AcquisitionLimits } from "../schema/policy.js";
import { MONTY_PYTHON_PROVIDER_ID, MONTY_VERIFIED_IMPORTS, MontyPythonAdapter } from "./monty-python-adapter.js";
import type { MontyPythonAdapterOptions } from "./monty-python-adapter.js";
import type { PythonEvaluateResult } from "../runtime/python-capability.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
async function refuse(run: () => unknown): Promise<{ code: string; details?: unknown } | null> {
  try {
    await run();
  } catch (error) {
    if (isPortableCode(error)) {
      return error;
    }
    throw error;
  }
  return null;
}

/** One adapter over a scratch working copy, plus its first lease. */
interface Fixture {
  adapter: MontyPythonAdapter;
  lease: EnvironmentLease;
  copyRoot: string;
  close(): Promise<void>;
}

/** Explicit grants every successful acquire in this file carries. */
const LIMITS: AcquisitionLimits = {
  executionLocations: ["local", "remote"],
  networkEgress: "unrestricted",
  egressAllowlist: [],
  hostFilesystemAccess: true,
  maxEnvironmentLifetimeMs: 86_400_000,
  maxResources: {
    memoryBytes: 4 * 1024 ** 3,
    storageBytes: 4 * 1024 ** 3,
    gpuMemoryBytes: 4 * 1024 ** 3,
  },
};

async function make(options: MontyPythonAdapterOptions = {}): Promise<Fixture> {
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-monty-"));
  mkdirSync(join(copyRoot, "data"), { recursive: true });
  writeFileSync(join(copyRoot, "data", "note.txt"), "hello from the copy");
  const adapter = new MontyPythonAdapter({
    workspaceRoot: copyRoot,
    hostFunctions: { double: (n: unknown) => (n as number) * 2 },
    ...options,
  });
  const lease = await adapter.acquire({
    acquisitionId: `acq-${randomUUID()}`,
    request: {
      name: "python",
      providerId: MONTY_PYTHON_PROVIDER_ID,
      requires: {},
    },
    authority: { principal: "user://test", policyRef: "policy://test" },
    limits: LIMITS,
  });
  return {
    adapter,
    lease,
    copyRoot,
    close: async () => {
      await lease.release();
      await adapter.close();
    },
  };
}

/** One evaluate call against the fixture's lease. */
async function evaluate(
  lease: EnvironmentLease,
  input: unknown,
  operationId = `op-${randomUUID()}`,
): Promise<AdapterOperation> {
  return lease.invoke({
    operationId,
    capability: "exec.python@1",
    operation: "evaluate",
    input,
    environmentId: lease.environmentId,
    limits: {},
  });
}

/** The result of one completed evaluate operation. */
function resultOf(operation: AdapterOperation): PythonEvaluateResult {
  assert.equal(operation.status, "completed");
  return operation.result as PythonEvaluateResult;
}

test("evaluation runs isolated programs with variables, output, and host functions", async () => {
  const fixture = await make();
  try {
    const value = resultOf(
      await evaluate(fixture.lease, {
        source: "double(n) + 1",
        variables: { n: 20 },
        bindings: [{ name: "double", kind: "host-function" }],
      }),
    );
    assert.equal(value.value, 41);
    assert.equal(value.timedOut, false);
    assert.deepEqual(value.output, { text: "", byteLength: 0, truncated: false });

    const printed = resultOf(
      await evaluate(fixture.lease, {
        source: 'print("counting")\n[double(x) for x in items]',
        variables: { items: [1, 2] },
        bindings: [{ name: "double", kind: "host-function" }],
      }),
    );
    assert.deepEqual(printed.value, [2, 4]);
    assert.equal(printed.output.text, "counting\n");

    // A host error crosses as the program's exception.
    const failing = new MontyPythonAdapter({
      hostFunctions: {
        boom: () => {
          throw new TypeError("bad arg");
        },
      },
    });
    const boomLease = await failing.acquire({
      acquisitionId: `acq-${randomUUID()}`,
      request: { name: "python", providerId: MONTY_PYTHON_PROVIDER_ID, requires: {} },
      authority: { principal: "user://test", policyRef: "policy://test" },
      limits: LIMITS,
    });
    const failed = resultOf(
      await evaluate(boomLease, {
        source: "boom()",
        bindings: [{ name: "boom", kind: "host-function" }],
      }),
    );
    assert.equal(failed.exception?.type, "TypeError");
    assert.equal(failed.exception?.message, "bad arg");
    await boomLease.release();
    await failing.close();

    // Structure: statement programs carry the null value.
    const statement = resultOf(await evaluate(fixture.lease, { source: "x = 5" }));
    assert.equal(statement.value, null);
  } finally {
    await fixture.close();
  }
});

test("state isolation: nothing defined in one call survives into the next", async () => {
  const fixture = await make();
  try {
    const first = resultOf(await evaluate(fixture.lease, { source: "leaked = 99\nleaked" }));
    assert.equal(first.value, 99);

    const second = resultOf(await evaluate(fixture.lease, { source: "leaked" }));
    assert.equal(second.exception?.type, "NameError");
    assert.equal(second.value, undefined);

    // Imported modules do not survive either.
    await evaluate(fixture.lease, { source: "import math\nmath.floor(2.5)" });
    const gone = resultOf(await evaluate(fixture.lease, { source: "math.floor(2.5)" }));
    assert.equal(gone.exception?.type, "NameError");
  } finally {
    await fixture.close();
  }
});

test("serialization: JSON values cross, and results the contract cannot carry refuse", async () => {
  const fixture = await make();
  try {
    const nested = resultOf(
      await evaluate(fixture.lease, {
        source: "payload",
        variables: { payload: { rows: [1, 2.5, true, null], name: "table" } },
      }),
    );
    assert.deepEqual(nested.value, { rows: [1, 2.5, true, null], name: "table" });

    const tuple = resultOf(await evaluate(fixture.lease, { source: "(1, 'two', None)" }));
    assert.deepEqual(tuple.value, [1, "two", null]);

    // A dict with string keys crosses as a JSON object.
    const dict = resultOf(await evaluate(fixture.lease, { source: "{'a': 1, 'b': {'c': 2}}" }));
    assert.deepEqual(dict.value, { a: 1, b: { c: 2 } });

    // Results the contract cannot carry refuse with the fix named:
    // a set, and a dict keyed by something other than strings.
    const set = resultOf(await evaluate(fixture.lease, { source: "{1, 2}" }));
    assert.equal(set.exception?.type, "TypeError");
    assert.ok(set.exception?.message.includes("json.dumps"));
    assert.equal(set.value, undefined);
    const keyed = resultOf(await evaluate(fixture.lease, { source: "{1: 'x'}" }));
    assert.equal(keyed.exception?.type, "TypeError");
    assert.ok(keyed.exception?.message.includes("json.dumps"));
    assert.equal(keyed.value, undefined);

    // With the fix applied, the same programs answer.
    const fixed = resultOf(
      await evaluate(fixture.lease, { source: "import json\njson.dumps({'a': 1})" }),
    );
    assert.equal(fixed.value, '{"a": 1}');
  } finally {
    await fixture.close();
  }
});

test("unsupported imports raise structured exceptions, and verified imports run", async () => {
  const fixture = await make();
  try {
    for (const name of ["random", "statistics", "time", "uuid"]) {
      const missing = resultOf(await evaluate(fixture.lease, { source: `import ${name}` }));
      assert.equal(missing.exception?.type, "ModuleNotFoundError", name);
      assert.ok(
        missing.exception?.message.includes(name),
        `the message names ${name}`,
      );
    }

    const math = resultOf(
      await evaluate(fixture.lease, { source: "import math\nmath.floor(3.7)" }),
    );
    assert.equal(math.value, 3);
    const json = resultOf(
      await evaluate(fixture.lease, { source: 'import json\njson.loads(\'{"k": 2}\')["k"]' }),
    );
    assert.equal(json.value, 2);

    // The declared imports list carries the same truth as the engine.
    const manifest = await fixture.lease.manifest();
    const declared = manifest.capabilities[0]!.attributes as { imports: string[] };
    assert.ok(declared.imports.includes("math"));
    assert.ok(declared.imports.includes("json"));
    assert.ok(!declared.imports.includes("random"));
    assert.deepEqual([...MONTY_VERIFIED_IMPORTS].sort(), [...declared.imports].sort());
  } finally {
    await fixture.close();
  }
});

test("limits: the engine ends calls at the cap and output truncates", async () => {
  const fixture = await make({ limits: { maxDurationMs: 1000, maxOutputBytes: 16 } });
  try {
    // A wedged program ends at its duration limit, with the timeout
    // named as what ended it.
    const started = Date.now();
    const timedOut = resultOf(
      await evaluate(fixture.lease, { source: "x = 0\nwhile True:\n    x = x + 1", timeoutMs: 700 }),
    );
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.exception?.type, "TimeoutError");
    assert.ok(Date.now() - started < 5000, "the engine enforces the cap, not a backstop race");

    // The caller may only narrow the declared duration.
    const widened = await refuse(() =>
      evaluate(fixture.lease, { source: "1", timeoutMs: 2000 }),
    );
    assert.equal(widened?.code, "InvalidRequest");

    // Printed output truncates at the cap with the flag set.
    const loud = resultOf(
      await evaluate(fixture.lease, {
        source: 'print("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")',
        timeoutMs: 1000,
      }),
    );
    assert.equal(loud.output.byteLength, 16);
    assert.equal(loud.output.truncated, true);
    assert.equal(loud.output.text, "aaaaaaaaaaaaaaaa");

    // An oversized source refuses before any session starts.
    const oversized = await refuse(() =>
      evaluate(fixture.lease, { source: `x = 1\n${"y = 2\n".repeat(60000)}` }),
    );
    assert.equal(oversized?.code, "InvalidRequest");
  } finally {
    await fixture.close();
  }
});

test("workspace bindings read and write the authorized copy under their mode", async () => {
  const fixture = await make();
  try {
    const read = resultOf(
      await evaluate(fixture.lease, {
        source: "open('/mnt/data/note.txt').read()",
        bindings: [{ name: "data", kind: "workspace", path: "data" }],
      }),
    );
    assert.equal(read.value, "hello from the copy");

    // A read binding refuses writes inside the sandbox.
    const denied = resultOf(
      await evaluate(fixture.lease, {
        source: "open('/mnt/data/note.txt', 'w').write('no')",
        bindings: [{ name: "data", kind: "workspace", path: "data" }],
      }),
    );
    assert.equal(denied.exception?.type, "PermissionError");

    // A read-write binding writes through to the copy.
    const written = resultOf(
      await evaluate(fixture.lease, {
        source: "open('/mnt/data/note.txt', 'w').write('changed')",
        bindings: [{ name: "data", kind: "workspace", path: "data", mode: "read-write" }],
      }),
    );
    assert.equal(written.value, 7);
    assert.equal(readFileSync(join(fixture.copyRoot, "data", "note.txt"), "utf8"), "changed");

    // No path outside the authorized copy resolves.
    const escape = await refuse(() =>
      evaluate(fixture.lease, {
        source: "1",
        bindings: [{ name: "data", kind: "workspace", path: "../outside" }],
      }),
    );
    assert.equal(escape?.code, "InvalidRequest");
    const missing = await refuse(() =>
      evaluate(fixture.lease, {
        source: "1",
        bindings: [{ name: "data", kind: "workspace", path: "no-such-dir" }],
      }),
    );
    assert.equal(missing?.code, "InvalidRequest");

    // Without an authorized copy, workspace bindings refuse outright.
    const bare = new MontyPythonAdapter();
    const bareLease = await bare.acquire({
      acquisitionId: `acq-${randomUUID()}`,
      request: { name: "python", providerId: MONTY_PYTHON_PROVIDER_ID, requires: {} },
      authority: { principal: "user://test", policyRef: "policy://test" },
      limits: LIMITS,
    });
    const refused = await refuse(() =>
      evaluate(bareLease, {
        source: "1",
        bindings: [{ name: "data", kind: "workspace", path: "data" }],
      }),
    );
    assert.equal(refused?.code, "InvalidRequest");
    await bareLease.release();
    await bare.close();
  } finally {
    await fixture.close();
  }
});

test("the adapter declares its truth and refuses what it cannot do", async () => {
  const fixture = await make();
  try {
    // The offer and manifest carry the verified declaration.
    const offers = await fixture.adapter.describe();
    assert.equal(offers.length, 1);
    assert.equal(offers[0]!.providerId, MONTY_PYTHON_PROVIDER_ID);
    const attributes = offers[0]!.capabilities[0]!.attributes as Record<string, unknown>;
    assert.equal(attributes.engine, "monty");
    assert.equal(attributes.subset, "lite");
    assert.equal(attributes.persistentState, "call-isolated");
    assert.deepEqual(attributes.hostFunctions, ["double"]);
    const enforcement = offers[0]!.enforcement as { engineVersion: string };
    assert.match(enforcement.engineVersion, /^\d+\.\d+\.\d+/);

    // Matching distinguishes lite from full semantics at acquisition.
    const full = await refuse(() =>
      fixture.adapter.acquire({
        acquisitionId: `acq-${randomUUID()}`,
        request: {
          name: "python",
          providerId: MONTY_PYTHON_PROVIDER_ID,
          requires: { "exec.python@1": { subset: { equals: "full" } } },
        },
        authority: { principal: "user://test", policyRef: "policy://test" },
        limits: LIMITS,
      }),
    );
    assert.equal(full?.code, "RequirementUnsatisfied");

    // Unoffered host functions and operations refuse.
    const unknownHost = await refuse(() =>
      evaluate(fixture.lease, {
        source: "tripple(3)",
        bindings: [{ name: "tripple", kind: "host-function" }],
      }),
    );
    assert.equal(unknownHost?.code, "InvalidRequest");
    const wrongOperation = await refuse(() =>
      fixture.lease.invoke({
        operationId: `op-${randomUUID()}`,
        capability: "exec.python@1",
        operation: "run",
        input: {},
        environmentId: fixture.lease.environmentId,
        limits: {},
      }),
    );
    assert.equal(wrongOperation?.code, "UnsupportedOperation");
    const wrongCapability = await refuse(() =>
      fixture.lease.invoke({
        operationId: `op-${randomUUID()}`,
        capability: "exec.process@1",
        operation: "run",
        input: {},
        environmentId: fixture.lease.environmentId,
        limits: {},
      }),
    );
    assert.equal(wrongCapability?.code, "UnsupportedOperation");

    // Cancellation and binding declare themselves unsupported.
    const cancelled = await fixture.lease.cancel("op-anything");
    assert.equal(cancelled.outcome, "unsupported");
    assert.equal(cancelled.stopped, false);
    const bound = await fixture.lease.bind(
      {
        id: "res-1",
        sessionId: "sess-1",
        type: "test",
        owner: { sessionId: "sess-1", attachmentId: "att-1", generation: 1 },
        lifetime: "attachment",
        recovery: "none",
      },
      {
        authority: { principal: "user://test", policyRef: "policy://test" },
        resolveSecret: async () => "",
      },
    );
    assert.equal(bound.status, "unsupported");
  } finally {
    await fixture.close();
  }
});

test("acquisitions are idempotent, inspectable, and release exactly once", async () => {
  const fixture = await make();
  try {
    const adapter = fixture.adapter;
    const acquisitionId = `acq-${randomUUID()}`;
    const request = {
      acquisitionId,
      request: { name: "python", providerId: MONTY_PYTHON_PROVIDER_ID, requires: {} },
      authority: { principal: "user://test", policyRef: "policy://test" },
      limits: LIMITS,
    } as const;
    const first = await adapter.acquire(request);
    const again = await adapter.acquire(request);
    assert.equal(again.environmentId, first.environmentId);

    const reconciled = await adapter.reconcile(acquisitionId);
    assert.equal(reconciled.state, "allocated");
    assert.equal(reconciled.environmentId, first.environmentId);

    // One completed operation inspects to its recorded answer.
    const operationId = `op-${randomUUID()}`;
    await evaluate(fixture.lease, { source: "6 * 7" }, operationId);
    const inspected = await fixture.lease.inspect(operationId);
    assert.equal(inspected.status, "completed");
    const unknown = await refuse(() => fixture.lease.inspect("op-never"));
    assert.equal(unknown?.code, "InvalidRequest");

    // Renewal extends; release ends work and repeats idempotently.
    const extended = await fixture.lease.renew(new Date(Date.now() + 60_000).toISOString());
    assert.equal(extended.status, "active");
    assert.equal((await adapter.reconcile(acquisitionId)).state, "allocated");

    const released = await fixture.lease.release();
    assert.deepEqual(released, { status: "released", retryable: false });
    const repeated = await fixture.lease.release();
    assert.equal(repeated.status, "released");
    assert.equal((await adapter.reconcile(acquisitionId)).state, "allocated");
    await first.release();
    assert.equal((await adapter.reconcile(acquisitionId)).state, "released");

    const refused = await refuse(() => evaluate(fixture.lease, { source: "1" }));
    assert.equal(refused?.code, "LeaseExpired");

    // A fresh acquisition finds nothing held against it.
    assert.equal((await adapter.reconcile(`acq-${randomUUID()}`)).state, "unknown");
  } finally {
    await fixture.close();
  }
});
