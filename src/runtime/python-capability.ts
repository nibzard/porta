import { resolve as resolvePath, sep } from "node:path";
import { invalidRequestError, invalidRequestFromValidation } from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import { DEFS } from "../schema/defs.js";
import type { CapabilityDescriptor } from "../schema/capability.js";
import { ValidationError, assertValid } from "../schema/validate.js";

/**
 * The `exec.python@1` capability contract (SPEC.md section 14.2).
 *
 * One operation — `evaluate` — carries Python source, JSON-compatible
 * variables, and authorized bindings. The result carries a
 * JSON-compatible value, the captured output, or one structured
 * exception; never an exit code, and never a stack trace alone.
 *
 * The descriptor must declare the engine, the language subset, the
 * supported imports, the persistent-state behavior, and the limits
 * (SPEC.md section 14.2). Matching is exact on those attributes: a
 * lightweight interpreter declares `subset: "lite"`, and a requirement
 * for full Python semantics does not match it. Selecting Monty by
 * engine says nothing about compatibility with every Python program.
 *
 * Version one uses isolated evaluation calls. Interpreter locals are
 * never portable workspace state: no input field names them, no
 * result carries them, and a descriptor that claims persistent
 * interpreter state fails `checkPythonAttributes`.
 */

/** Identifier of the capability this module contracts. */
export const PYTHON_CAPABILITY_ID = "exec.python@1";

/** Operations version one requires (SPEC.md section 14.2). */
export const PYTHON_OPERATIONS = ["evaluate"] as const;

/** One operation name of `exec.python@1`. */
export type PythonOperation = (typeof PYTHON_OPERATIONS)[number];

/**
 * Language subsets this capability version defines.
 *
 * `full` is not a member on purpose: full Python execution is a
 * different contract, and a lightweight engine must not satisfy a
 * requirement that asks for it (SPEC.md section 14.2).
 */
export const PYTHON_SUBSETS = ["lite", "lite-plus"] as const;

/** One declared language subset. */
export type PythonSubset = (typeof PYTHON_SUBSETS)[number];

/**
 * The persistent-state behavior this version allows.
 *
 * `call-isolated` is the only value: each `evaluate` call starts from
 * a clean interpreter, so no locals survive a call and none can be
 * mistaken for workspace state.
 */
export const PYTHON_PERSISTENT_STATES = ["call-isolated"] as const;

/** One declared persistent-state behavior. */
export type PythonPersistentState = (typeof PYTHON_PERSISTENT_STATES)[number];

/** Declared limits of one Python provider (SPEC.md section 14.2). */
export interface PythonLimits {
  /** Source bytes one call may carry. */
  maxSourceBytes: number;
  /** Wall-clock bound of one call, in milliseconds. */
  maxDurationMs: number;
  /** Captured output bytes one call may hold; the rest drops with a flag. */
  maxOutputBytes: number;
}

/**
 * Declared attributes of a Python provider (SPEC.md section 14.2).
 *
 * An environment that offers `exec.python@1` advertises these in its
 * capability attributes. Every key must be present and well formed:
 * an incomplete declaration fails `checkPythonAttributes` and
 * therefore matching, rather than narrowing silently.
 */
export interface PythonAttributeDeclarations {
  /** Engine identity, for example `monty`. Never a version claim. */
  engine: string;
  /** Language subset the engine interprets. */
  subset: PythonSubset;
  /** Importable module names; `*` alone means everything importable. */
  imports: string[];
  /** Persistent-state behavior; only `call-isolated` exists here. */
  persistentState: PythonPersistentState;
  /** Host-function names the provider can bind for a call. */
  hostFunctions: string[];
  limits: PythonLimits;
}

/** Attribute keys every `exec.python@1` provider must declare. */
export const PYTHON_ATTRIBUTE_KEYS = [
  "engine",
  "subset",
  "imports",
  "persistentState",
  "hostFunctions",
  "limits",
] as const;

const NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const MODULE_PATTERN = "^(\\*|[A-Za-z_][A-Za-z0-9_.]*)$";

/**
 * Read one provider's declared Python attributes.
 *
 * Returns the parsed declarations, or null when a key is missing or
 * malformed. A descriptor that claims persistent interpreter state
 * also returns null: this contract holds isolated calls only, so
 * interpreter locals never become durable state of any kind.
 */
export function checkPythonAttributes(
  attributes: object,
): PythonAttributeDeclarations | null {
  const { engine, subset, imports, persistentState, hostFunctions, limits } =
    attributes as Partial<PythonAttributeDeclarations>;
  if (typeof engine !== "string" || engine.length === 0 || engine.length > 64) {
    return null;
  }
  if (subset !== "lite" && subset !== "lite-plus") {
    return null;
  }
  if (
    !Array.isArray(imports) ||
    !imports.every((name) => typeof name === "string" && new RegExp(MODULE_PATTERN).test(name))
  ) {
    return null;
  }
  if (persistentState !== "call-isolated") {
    return null;
  }
  if (
    !Array.isArray(hostFunctions) ||
    !hostFunctions.every(
      (name) => typeof name === "string" && new RegExp(NAME_PATTERN).test(name) && name.length > 0,
    )
  ) {
    return null;
  }
  if (!isLimits(limits)) {
    return null;
  }
  return {
    engine,
    subset,
    imports: [...imports],
    persistentState,
    hostFunctions: [...hostFunctions],
    limits: { ...limits },
  };
}

/** Whether one value reads as a complete limits declaration. */
function isLimits(value: unknown): value is PythonLimits {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const { maxSourceBytes, maxDurationMs, maxOutputBytes } = value as Partial<PythonLimits>;
  return (
    isPositiveInteger(maxSourceBytes) &&
    isPositiveInteger(maxDurationMs) &&
    isPositiveInteger(maxOutputBytes)
  );
}

/** Whether one value is a positive safe integer. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// -- Inputs and results -------------------------------------------------------

/** One name the source may use, bound to a host function or a copy path. */
export interface PythonBinding {
  /** Variable name the source sees. */
  name: string;
  /** What the name binds to. */
  kind: "host-function" | "workspace";
  /** Copy-relative path; required for `workspace`, refused otherwise. */
  path?: string;
  /** Copy access mode; `read` unless stated otherwise. */
  mode?: "read" | "read-write";
}

/** Input of the `evaluate` operation. */
export interface PythonEvaluateInput {
  /** Python source the engine evaluates in one isolated call. */
  source: string;
  /** JSON-compatible variables visible to the source by name. */
  variables?: Record<string, unknown>;
  /** Names the call may use, bound by the authorizing host or copy. */
  bindings?: PythonBinding[];
  /** Wall-clock bound of the call, in milliseconds. */
  timeoutMs?: number;
  /** Output capture ceiling of this call; it may only narrow. */
  maxOutputBytes?: number;
}

/** The interpreter output one call captured. */
export interface PythonCapturedOutput {
  /** Captured output as UTF-8 text. */
  text: string;
  /** Captured bytes the text holds. */
  byteLength: number;
  /** `true` when output was dropped after a limit. */
  truncated: boolean;
}

/** One structured interpreter exception (SPEC.md section 14.2). */
export interface PythonException {
  /** Exception type name, for example `NameError`. */
  type: string;
  /** The exception message. */
  message: string;
  /** Traceback text, when the engine provides one. */
  traceback?: string;
  /** One-based source line of the failure. */
  line?: number;
  /** One-based source column of the failure. */
  column?: number;
}

/** Result of the `evaluate` operation. */
export interface PythonEvaluateResult {
  /** The value the call returned; JSON-compatible. Absent on exception. */
  value?: unknown;
  output: PythonCapturedOutput;
  /** Present exactly when the call raised; `value` is absent then. */
  exception?: PythonException;
  /** `true` when the timeout ended the call, not the program. */
  timedOut: boolean;
  startedAt: string;
  endedAt: string;
}

// -- Schemas -------------------------------------------------------------------

const timeoutProperty = { type: "integer", minimum: 1, maximum: 2147483647 };
const bindingSchema = {
  type: "object",
  required: ["name", "kind"],
  additionalProperties: false,
  properties: {
    name: { type: "string", pattern: NAME_PATTERN, maxLength: 256 },
    kind: { enum: ["host-function", "workspace"] },
    path: { type: "string", minLength: 1, maxLength: 4096 },
    mode: { enum: ["read", "read-write"] },
  },
};

/** Schema of the `evaluate` input. */
export const pythonEvaluateInputSchema = {
  $id: "https://portable.dev/schema/python/evaluate-input.json",
  $defs: DEFS,
  type: "object",
  required: ["source"],
  additionalProperties: false,
  properties: {
    source: { type: "string", minLength: 1, maxLength: 524288 },
    variables: {
      type: "object",
      maxProperties: 256,
      propertyNames: { type: "string", pattern: NAME_PATTERN, maxLength: 256 },
      additionalProperties: true,
    },
    bindings: { type: "array", maxItems: 64, items: bindingSchema },
    timeoutMs: timeoutProperty,
    maxOutputBytes: { type: "integer", minimum: 1, maximum: 9007199254740991 },
  },
} as const;

/** Schema of the `evaluate` result. */
export const pythonEvaluateResultSchema = {
  $id: "https://portable.dev/schema/python/evaluate-result.json",
  $defs: DEFS,
  type: "object",
  required: ["output", "timedOut", "startedAt", "endedAt"],
  additionalProperties: false,
  properties: {
    value: true,
    output: {
      type: "object",
      required: ["text", "byteLength", "truncated"],
      additionalProperties: false,
      properties: {
        text: { type: "string", maxLength: 8388608 },
        byteLength: { $ref: "#/$defs/byteSize" },
        truncated: { type: "boolean" },
      },
    },
    exception: {
      type: "object",
      required: ["type", "message"],
      additionalProperties: false,
      properties: {
        type: { type: "string", minLength: 1, maxLength: 128 },
        message: { type: "string", maxLength: 8192 },
        traceback: { type: "string", maxLength: 65536 },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
      },
    },
    timedOut: { type: "boolean" },
    startedAt: { $ref: "#/$defs/timestamp" },
    endedAt: { $ref: "#/$defs/timestamp" },
  },
  // Exactly one of value or exception answers a call: a success may
  // carry the value null, and a failure never invents a value.
  oneOf: [
    { required: ["value"], not: { required: ["exception"] } },
    { required: ["exception"], not: { required: ["value"] } },
  ],
} as const;

// -- Validation -----------------------------------------------------------------

/** Validate one `evaluate` input and return it with its semantics fixed. */
export function validatePythonEvaluateInput(input: unknown): PythonEvaluateInput {
  try {
    assertValid(pythonEvaluateInputSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  const checked = input as PythonEvaluateInput;
  const names = new Set<string>();
  for (const binding of checked.bindings ?? []) {
    if (names.has(binding.name)) {
      throw invalidRequestError(`The binding name ${binding.name} is used twice.`, {
        name: binding.name,
      });
    }
    names.add(binding.name);
    if (binding.kind === "workspace") {
      if (binding.path === undefined) {
        throw invalidRequestError(
          `The workspace binding ${binding.name} names no path inside the authorized copy.`,
          { name: binding.name },
        );
      }
    } else if (binding.path !== undefined || binding.mode !== undefined) {
      throw invalidRequestError(
        `The host-function binding ${binding.name} carries workspace fields.`,
        { name: binding.name },
      );
    }
  }
  return checked;
}

/** Validate one `evaluate` result. */
export function validatePythonEvaluateResult(result: unknown): PythonEvaluateResult {
  try {
    assertValid(pythonEvaluateResultSchema, result);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  return result as PythonEvaluateResult;
}

// -- Field semantics ------------------------------------------------------------

/**
 * Check one call against the provider's declared limits.
 *
 * Returns the refusal when the source, the requested duration, or the
 * requested output ceiling exceeds what the descriptor declares. A
 * call may only narrow the declared limits, never widen them. Returns
 * null when the call fits.
 */
export function checkEvaluateWithinLimits(
  input: PythonEvaluateInput,
  declared: PythonLimits,
): PortableError | null {
  const sourceBytes = Buffer.byteLength(input.source, "utf8");
  if (sourceBytes > declared.maxSourceBytes) {
    return invalidRequestError(
      `The source carries ${sourceBytes} bytes; the provider allows ${declared.maxSourceBytes}.`,
      { sourceBytes, maxSourceBytes: declared.maxSourceBytes },
    );
  }
  if (input.timeoutMs !== undefined && input.timeoutMs > declared.maxDurationMs) {
    return invalidRequestError(
      `The call asks for ${input.timeoutMs} ms; the provider allows ${declared.maxDurationMs} ms.`,
      { timeoutMs: input.timeoutMs, maxDurationMs: declared.maxDurationMs },
    );
  }
  if (input.maxOutputBytes !== undefined && input.maxOutputBytes > declared.maxOutputBytes) {
    return invalidRequestError(
      `The call asks to capture ${input.maxOutputBytes} bytes; the provider allows ${declared.maxOutputBytes}.`,
      { maxOutputBytes: input.maxOutputBytes, declaredMaxOutputBytes: declared.maxOutputBytes },
    );
  }
  return null;
}

/**
 * Resolve one workspace binding's path inside the authorized copy.
 *
 * A relative path resolves against the copy root and must stay inside
 * it. An absolute path or an escape through `..` always refuses:
 * Python bindings never reach the host filesystem, so this function
 * takes only a copy root — never a host-access grant.
 */
export function resolvePythonBindingPath(
  binding: Pick<PythonBinding, "path">,
  bound: { copyRoot: string },
): string {
  const root = resolvePath(bound.copyRoot);
  if (binding.path === undefined) {
    throw invalidRequestError("The workspace binding names no path.", {});
  }
  if (resolvePath(binding.path) === binding.path) {
    throw invalidRequestError(
      `The binding path ${binding.path} is absolute; it must stay inside the authorized copy.`,
      { path: binding.path, copyRoot: root },
    );
  }
  const absolute = resolvePath(root, binding.path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw invalidRequestError(
      `The binding path ${binding.path} resolves outside the authorized working copy.`,
      { path: binding.path, copyRoot: root, reason: "binding-path-escape" },
    );
  }
  return absolute;
}

// -- Reference descriptor ---------------------------------------------------

/**
 * The reference descriptor of `exec.python@1`.
 *
 * The default attributes describe a lightweight, call-isolated
 * Monty-class interpreter: subset `lite`, no imports, no host
 * functions, bounded source, duration, and output. A concrete adapter
 * overrides the attributes with its own truth; an incomplete
 * declaration fails `checkPythonAttributes` and therefore matching.
 */
export function pythonCapabilityDescriptor(
  attributes: PythonAttributeDeclarations = {
    engine: "monty",
    subset: "lite",
    imports: [],
    persistentState: "call-isolated",
    hostFunctions: [],
    limits: {
      maxSourceBytes: 262144,
      maxDurationMs: 30000,
      maxOutputBytes: 262144,
    },
  },
): CapabilityDescriptor {
  return {
    id: PYTHON_CAPABILITY_ID,
    operations: {
      evaluate: {
        inputSchema: pythonEvaluateInputSchema,
        outputSchema: pythonEvaluateResultSchema,
        stateful: false,
        effects: "mixed",
        retry: "unsafe",
        cancellation: "unsupported",
        streaming: false,
      },
    },
    attributes: {
      engine: attributes.engine,
      subset: attributes.subset,
      imports: [...attributes.imports],
      persistentState: attributes.persistentState,
      hostFunctions: [...attributes.hostFunctions],
      limits: { ...attributes.limits },
    },
  };
}
