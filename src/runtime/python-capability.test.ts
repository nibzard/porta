import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchEnvironment, validateCapabilityDescriptors } from "../core/matching.js";
import type { EnvironmentOffer } from "../schema/capability.js";
import {
  PYTHON_CAPABILITY_ID,
  checkEvaluateWithinLimits,
  checkPythonAttributes,
  pythonCapabilityDescriptor,
  resolvePythonBindingPath,
  validatePythonEvaluateInput,
  validatePythonEvaluateResult,
} from "./python-capability.js";
import type { PythonAttributeDeclarations } from "./python-capability.js";

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

/** One offer whose only capability is the reference Python descriptor. */
function pythonOffer(attributes?: PythonAttributeDeclarations): EnvironmentOffer {
  const descriptor = pythonCapabilityDescriptor(attributes);
  return {
    providerId: "py-local",
    platform: { os: "linux", arch: "x64" },
    capabilities: [{ id: descriptor.id, attributes: descriptor.attributes }],
  };
}

/** The reference declarations the default descriptor must carry. */
const REFERENCE: PythonAttributeDeclarations = {
  engine: "monty",
  subset: "lite",
  imports: [],
  persistentState: "call-isolated",
  hostFunctions: [],
  limits: { maxSourceBytes: 262144, maxDurationMs: 30000, maxOutputBytes: 262144 },
};

/** The reference declarations with one field replaced. */
function declaredWith(
  patch: Partial<PythonAttributeDeclarations>,
): PythonAttributeDeclarations {
  return { ...REFERENCE, ...patch };
}

test("the reference descriptor validates and parses its own attributes", () => {
  const descriptor = pythonCapabilityDescriptor();
  assert.equal(descriptor.id, PYTHON_CAPABILITY_ID);
  assert.deepEqual(Object.keys(descriptor.operations), ["evaluate"]);
  assert.equal(descriptor.operations.evaluate!.stateful, false);
  assert.doesNotThrow(() => validateCapabilityDescriptors([descriptor]));

  const parsed = checkPythonAttributes(descriptor.attributes);
  assert.ok(parsed !== null);
  assert.deepEqual(parsed, REFERENCE);

  // A malformed or overclaiming declaration fails the parse, and
  // therefore matching, instead of narrowing silently.
  assert.equal(checkPythonAttributes({}), null);
  assert.equal(
    checkPythonAttributes(declaredWith({ subset: "full" as PythonAttributeDeclarations["subset"] })),
    null,
  );
  assert.equal(checkPythonAttributes(declaredWith({ engine: "" })), null);
  assert.equal(checkPythonAttributes(declaredWith({ imports: ["not a module!"] })), null);
  assert.equal(
    checkPythonAttributes(
      declaredWith({ persistentState: "interpreter-session" as PythonAttributeDeclarations["persistentState"] }),
    ),
    null,
  );
  assert.equal(
    checkPythonAttributes(declaredWith({ limits: { maxSourceBytes: 0, maxDurationMs: 10, maxOutputBytes: 10 } })),
    null,
  );
});

test("matching distinguishes a lite interpreter from full Python semantics", () => {
  const offer = pythonOffer();

  const lite = matchEnvironment(
    {
      name: "python",
      requires: {
        [PYTHON_CAPABILITY_ID]: {
          subset: { equals: "lite" },
          engine: { equals: "monty" },
          persistentState: { equals: "call-isolated" },
        },
      },
    },
    [offer],
  );
  assert.equal(lite.providerId, "py-local");

  // A requirement for full semantics never matches a lite engine.
  const full = refuse(() =>
    matchEnvironment(
      {
        name: "python",
        requires: { [PYTHON_CAPABILITY_ID]: { subset: { equals: "full" } } },
      },
      [offer],
    ),
  );
  assert.equal(full?.code, "RequirementUnsatisfied");

  // A different capability id is a different contract.
  const otherId = refuse(() =>
    matchEnvironment(
      { name: "python", requires: { "python.full@1": {} } },
      [offer],
    ),
  );
  assert.equal(otherId?.code, "RequirementUnsatisfied");

  // Persistent interpreter state is not on offer in version one.
  const persistent = refuse(() =>
    matchEnvironment(
      {
        name: "python",
        requires: { [PYTHON_CAPABILITY_ID]: { persistentState: { equals: "persistent" } } },
      },
      [offer],
    ),
  );
  assert.equal(persistent?.code, "RequirementUnsatisfied");

  // The subsets are distinct: lite does not satisfy lite-plus.
  const plusOffer = pythonOffer(declaredWith({ subset: "lite-plus" }));
  const plus = refuse(() =>
    matchEnvironment(
      {
        name: "python",
        requires: { [PYTHON_CAPABILITY_ID]: { subset: { equals: "lite" } } },
      },
      [plusOffer],
    ),
  );
  assert.equal(plus?.code, "RequirementUnsatisfied");
});

test("input validation accepts isolated calls and refuses to carry interpreter locals", () => {
  const minimal = validatePythonEvaluateInput({ source: "1 + 1" });
  assert.equal(minimal.source, "1 + 1");

  const full = validatePythonEvaluateInput({
    source: "render(table)",
    variables: { table: { rows: 2 } },
    bindings: [
      { name: "render", kind: "host-function" },
      { name: "data", kind: "workspace", path: "input/table.json", mode: "read" },
    ],
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });
  assert.equal(full.bindings?.length, 2);

  // Interpreter locals are not input: no field names them.
  assert.equal(refuse(() => validatePythonEvaluateInput({ source: "x", localsPath: "locals.pkl" }))?.code, "InvalidRequest");
  assert.equal(
    refuse(() => validatePythonEvaluateInput({ source: "x", persistLocals: true }))?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() => validatePythonEvaluateInput({ source: "x", interpreterSession: "sess-1" }))?.code,
    "InvalidRequest",
  );
  assert.equal(refuse(() => validatePythonEvaluateInput({ source: "" }))?.code, "InvalidRequest");
  assert.equal(refuse(() => validatePythonEvaluateInput({}))?.code, "InvalidRequest");
  assert.equal(
    refuse(() => validatePythonEvaluateInput({ source: "x", variables: { "not a name": 1 } }))?.code,
    "InvalidRequest",
  );
});

test("binding validation keeps host functions and workspace paths apart", () => {
  const missingPath = refuse(() =>
    validatePythonEvaluateInput({
      source: "read(data)",
      bindings: [{ name: "data", kind: "workspace" }],
    }),
  );
  assert.equal(missingPath?.code, "InvalidRequest");

  const strayPath = refuse(() =>
    validatePythonEvaluateInput({
      source: "f()",
      bindings: [{ name: "f", kind: "host-function", path: "input/data.json" }],
    }),
  );
  assert.equal(strayPath?.code, "InvalidRequest");

  const strayMode = refuse(() =>
    validatePythonEvaluateInput({
      source: "f()",
      bindings: [{ name: "f", kind: "host-function", mode: "read" }],
    }),
  );
  assert.equal(strayMode?.code, "InvalidRequest");

  const twice = refuse(() =>
    validatePythonEvaluateInput({
      source: "f(f())",
      bindings: [
        { name: "f", kind: "host-function" },
        { name: "f", kind: "host-function" },
      ],
    }),
  );
  assert.equal(twice?.code, "InvalidRequest");

  // A workspace binding without a mode reads only.
  const read = validatePythonEvaluateInput({
    source: "read(data)",
    bindings: [{ name: "data", kind: "workspace", path: "input/data.json" }],
  });
  assert.equal(read.bindings?.[0]?.mode, undefined);
});

test("results answer with exactly one of a value or a structured exception", () => {
  const startedAt = "2026-09-11T10:00:00.000Z";
  const endedAt = "2026-09-11T10:00:01.000Z";

  const value = validatePythonEvaluateResult({
    value: null,
    output: { text: "", byteLength: 0, truncated: false },
    timedOut: false,
    startedAt,
    endedAt,
  });
  assert.equal(value.value, null);

  const raised = validatePythonEvaluateResult({
    exception: { type: "NameError", message: "name 'x' is not defined", line: 1, column: 1 },
    output: { text: "", byteLength: 0, truncated: false },
    timedOut: false,
    startedAt,
    endedAt,
  });
  assert.equal(raised.exception?.type, "NameError");

  const printed = validatePythonEvaluateResult({
    value: 4,
    output: { text: "working\n", byteLength: 9, truncated: false },
    timedOut: false,
    startedAt,
    endedAt,
  });
  assert.equal(printed.output.text, "working\n");

  // Both answers or neither answer refuse.
  assert.equal(
    refuse(() =>
      validatePythonEvaluateResult({
        value: 1,
        exception: { type: "ValueError", message: "boom" },
        output: { text: "", byteLength: 0, truncated: false },
        timedOut: false,
        startedAt,
        endedAt,
      }),
    )?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() =>
      validatePythonEvaluateResult({
        output: { text: "", byteLength: 0, truncated: false },
        timedOut: false,
        startedAt,
        endedAt,
      }),
    )?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() =>
      validatePythonEvaluateResult({
        value: 1,
        output: { text: "", byteLength: 0, truncated: false },
        startedAt,
        endedAt,
      }),
    )?.code,
    "InvalidRequest",
  );
});

test("calls may only narrow the declared limits", () => {
  const declared = {
    maxSourceBytes: 16,
    maxDurationMs: 1000,
    maxOutputBytes: 64,
  };

  assert.equal(
    checkEvaluateWithinLimits(
      { source: "x".repeat(16), timeoutMs: 1000, maxOutputBytes: 64 },
      declared,
    ),
    null,
  );
  assert.equal(checkEvaluateWithinLimits({ source: "x".repeat(15) }, declared), null);

  const source = checkEvaluateWithinLimits({ source: "x".repeat(17) }, declared);
  assert.equal(source?.code, "InvalidRequest");

  const duration = checkEvaluateWithinLimits({ source: "x", timeoutMs: 1001 }, declared);
  assert.equal(duration?.code, "InvalidRequest");

  const output = checkEvaluateWithinLimits({ source: "x", maxOutputBytes: 65 }, declared);
  assert.equal(output?.code, "InvalidRequest");
});

test("workspace binding paths resolve inside the authorized copy only", () => {
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-python-"));

  const inside = resolvePythonBindingPath(
    { path: join("input", "data.json") },
    { copyRoot },
  );
  assert.ok(inside.startsWith(copyRoot));

  assert.equal(resolvePythonBindingPath({ path: "." }, { copyRoot }), copyRoot);

  // An escape or an absolute path always refuses: Python bindings
  // never reach the host filesystem.
  assert.equal(
    refuse(() => resolvePythonBindingPath({ path: join("..", "escape.json") }, { copyRoot }))?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() =>
      resolvePythonBindingPath({ path: join(copyRoot, "data.json") }, { copyRoot }),
    )?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() =>
      resolvePythonBindingPath({ path: join("input", "..", "..", "secret.json") }, { copyRoot }),
    )?.code,
    "InvalidRequest",
  );
});
