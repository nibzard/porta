import { resolve as resolvePath, sep } from "node:path";
import { invalidRequestError, invalidRequestFromValidation } from "../core/errors.js";
import { DEFS } from "../schema/defs.js";
import type { CapabilityDescriptor } from "../schema/capability.js";
import type { ResourceRef } from "../schema/resource.js";
import { ValidationError, assertValid } from "../schema/validate.js";

/**
 * The `exec.process@1` capability contract (SPEC.md section 14.1).
 *
 * Four operations — `run`, `start`, `inspect`, and `terminate` — carry
 * validated requests and results. This module is the contract, not an
 * adapter: it states the exact shape of every input and output, the
 * declared attributes an environment must advertise, and the helpers
 * that give the shared fields their semantics.
 *
 * Commands take argument arrays. Nothing interprets a command string:
 * shell interpretation happens only when the caller explicitly names a
 * shell executable as the command and passes the script as one
 * argument (`shellInvocation` builds that pair).
 *
 * The local adapter (SPEC.md section 7) and remote adapters implement
 * this contract behind the environment lease; conformance cases check
 * both against these schemas.
 */

/** Identifier of the capability this module contracts. */
export const PROCESS_CAPABILITY_ID = "exec.process@1";

/** Operations version one requires (SPEC.md section 14.1). */
export const PROCESS_OPERATIONS = ["run", "start", "inspect", "terminate"] as const;

/** One operation name of `exec.process@1`. */
export type ProcessOperation = (typeof PROCESS_OPERATIONS)[number];

/** Encodings standard input may name explicitly. */
export type ProcessStdinEncoding = "utf-8" | "base64";

/** Caps on captured output (SPEC.md section 14.1). */
export interface ProcessOutputLimits {
  /** Captured bytes one stream may hold; the rest drops with a flag. */
  maxBytesPerStream?: number;
  /** Captured bytes both streams may hold together. */
  maxTotalBytes?: number;
}

/** Shared launch fields of `run` and `start`. */
export interface ProcessLaunchInput {
  /** Executable name or path, resolved by the provider. Never a shell line. */
  command: string;
  /** Argument array passed verbatim; no splitting, globbing, or quoting. */
  args?: string[];
  /**
   * Working directory. Relative paths resolve inside the authorized
   * working copy; absolute paths and escapes need `hostAccess`.
   */
  cwd?: string;
  /** Environment additions merged over the provider's base environment. */
  env?: Record<string, string>;
  /** Standard input content, decoded per `stdinEncoding`. */
  stdin?: string;
  stdinEncoding?: ProcessStdinEncoding;
  /** Wall-clock bound from process start, in milliseconds. */
  timeoutMs?: number;
  outputLimits?: ProcessOutputLimits;
  /** Explicit allowance for paths and executables outside the copy. */
  hostAccess?: boolean;
}

/** Input of the `run` operation: launch and wait for exit. */
export type ProcessRunInput = ProcessLaunchInput;

/** Input of the `start` operation: launch and return the resource. */
export type ProcessStartInput = ProcessLaunchInput;

/** Input of the `inspect` operation. */
export interface ProcessInspectInput {
  resourceId: string;
}

/** Input of the `terminate` operation. */
export interface ProcessTerminateInput {
  resourceId: string;
  /** Signal to send; the default is the first signal the adapter declares. */
  signal?: string;
}

/** One captured output stream: inline bytes or an artifact reference. */
export interface ProcessStreamCapture {
  /** Inline capture, base64; present for small outputs. */
  dataBase64?: string;
  /** Artifact-store digest; present when the capture went to storage. */
  digest?: string;
  /** Captured bytes held by this capture. */
  byteLength: number;
  /** `true` when output was dropped after a limit. */
  truncated: boolean;
  /** Dropped bytes, when the provider could count them. */
  omittedBytes?: number;
}

/** Result of the `run` operation. */
export interface ProcessRunResult {
  /** Process exit code; absent when a signal ended the process. */
  exitCode?: number;
  /** Termination signal, when one ended the process. */
  signal?: string;
  /** `true` when the timeout ended the process, not the program. */
  timedOut: boolean;
  stdout: ProcessStreamCapture;
  stderr: ProcessStreamCapture;
  startedAt: string;
  endedAt: string;
}

/** Result of the `start` operation. */
export interface ProcessStartResult {
  /** The process resource this start created. */
  resource: ResourceRef;
  /** Provider-side process identity; provenance only, no authority. */
  providerProcessId?: string;
  startedAt: string;
}

/** Observation states of a started process. */
export type ProcessState = "running" | "exited" | "terminated" | "unknown";

/** Result of the `inspect` operation. */
export interface ProcessInspectResult {
  resourceId: string;
  state: ProcessState;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  startedAt?: string;
  endedAt?: string;
}

/** Result of the `terminate` operation. */
export interface ProcessTerminateResult {
  resourceId: string;
  /** `true` only when the provider confirmed the stop. */
  confirmed: boolean;
  /** Whether descendants stopped with the process. */
  descendantsStopped: boolean;
  /** The signal the provider sent. */
  signal: string;
  state: ProcessState;
  exitCode?: number;
}

/**
 * Declared attributes of a process provider (SPEC.md section 14.1).
 *
 * An environment that offers `exec.process@1` advertises these in its
 * capability attributes; matching fails when a requirement names a
 * signal or a lifetime the provider does not declare.
 */
export interface ProcessAttributeDeclarations {
  /** Signal names `terminate` accepts, default first. */
  signals: string[];
  /** How far termination reaches into descendants. */
  descendantTermination: "none" | "best-effort" | "confirmed";
  /** Whether captures may carry bytes outside UTF-8 text. */
  binaryOutput: boolean;
  /** How long a started process outlives its invocation. */
  processLifetime: "operation" | "attachment";
}

/** Attribute keys every `exec.process@1` provider must declare. */
export const PROCESS_ATTRIBUTE_KEYS = [
  "signals",
  "descendantTermination",
  "binaryOutput",
  "processLifetime",
] as const;

/**
 * Read one provider's declared process attributes.
 *
 * Returns the parsed declarations, or null when an attribute is
 * missing or malformed: an incomplete declaration fails matching
 * rather than narrowing silently (SPEC.md section 14.1).
 */
export function checkProcessAttributes(
  attributes: Record<string, unknown>,
): ProcessAttributeDeclarations | null {
  const { signals, descendantTermination, binaryOutput, processLifetime } =
    attributes as Partial<ProcessAttributeDeclarations>;
  if (
    !Array.isArray(signals) ||
    signals.length === 0 ||
    !signals.every((signal) => typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal))
  ) {
    return null;
  }
  if (
    descendantTermination !== "none" &&
    descendantTermination !== "best-effort" &&
    descendantTermination !== "confirmed"
  ) {
    return null;
  }
  if (typeof binaryOutput !== "boolean") {
    return null;
  }
  if (processLifetime !== "operation" && processLifetime !== "attachment") {
    return null;
  }
  return { signals, descendantTermination, binaryOutput, processLifetime };
}

// -- Schemas -----------------------------------------------------------------

const commandProperty = { type: "string", minLength: 1, maxLength: 4096 };
const argsProperty = {
  type: "array",
  maxItems: 1024,
  items: { type: "string", maxLength: 32768 },
};
const cwdProperty = { type: "string", minLength: 1, maxLength: 4096 };
const envProperty = {
  type: "object",
  maxProperties: 256,
  propertyNames: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^=]+$" },
  additionalProperties: { type: "string", maxLength: 65536 },
};
const stdinEncodingProperty = { enum: ["utf-8", "base64"] };
const timeoutProperty = { type: "integer", minimum: 1, maximum: 2147483647 };
const outputLimitsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxBytesPerStream: { type: "integer", minimum: 1, maximum: 9007199254740991 },
    maxTotalBytes: { type: "integer", minimum: 1, maximum: 9007199254740991 },
  },
};
const signalProperty = { type: "string", pattern: "^SIG[A-Z0-9]+$", maxLength: 16 };
const resourceIdProperty = { $ref: "#/$defs/identifier" };

function launchInputSchema(required: string[]): Record<string, unknown> {
  return {
    $defs: DEFS,
    type: "object",
    required,
    additionalProperties: false,
    properties: {
      command: commandProperty,
      args: argsProperty,
      cwd: cwdProperty,
      env: envProperty,
      stdin: { type: "string", maxLength: 8388608 },
      stdinEncoding: stdinEncodingProperty,
      timeoutMs: timeoutProperty,
      outputLimits: outputLimitsSchema,
      hostAccess: { type: "boolean" },
    },
  };
}

/** Schema of the `run` input. */
export const processRunInputSchema = launchInputSchema(["command"]);

/** Schema of the `start` input. */
export const processStartInputSchema = launchInputSchema(["command"]);

/** Schema of the `inspect` input. */
export const processInspectInputSchema = {
  $id: "https://portable.dev/schema/process/inspect-input.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId"],
  additionalProperties: false,
  properties: { resourceId: resourceIdProperty },
} as const;

/** Schema of the `terminate` input. */
export const processTerminateInputSchema = {
  $id: "https://portable.dev/schema/process/terminate-input.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    signal: signalProperty,
  },
} as const;

const streamCaptureSchema = {
  type: "object",
  required: ["byteLength", "truncated"],
  additionalProperties: false,
  properties: {
    dataBase64: { type: "string", maxLength: 8388608 },
    digest: { $ref: "#/$defs/digest" },
    byteLength: { $ref: "#/$defs/byteSize" },
    truncated: { type: "boolean" },
    omittedBytes: { $ref: "#/$defs/byteSize" },
  },
};

/** Schema of the `run` result. */
export const processRunResultSchema = {
  $id: "https://portable.dev/schema/process/run-result.json",
  $defs: DEFS,
  type: "object",
  required: ["timedOut", "stdout", "stderr", "startedAt", "endedAt"],
  additionalProperties: false,
  properties: {
    exitCode: { type: "integer", minimum: 0, maximum: 255 },
    signal: signalProperty,
    timedOut: { type: "boolean" },
    stdout: streamCaptureSchema,
    stderr: streamCaptureSchema,
    startedAt: { $ref: "#/$defs/timestamp" },
    endedAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Schema of the `start` result. */
export const processStartResultSchema = {
  $id: "https://portable.dev/schema/process/start-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resource", "startedAt"],
  additionalProperties: false,
  properties: {
    resource: {
      type: "object",
      required: ["id", "sessionId", "type", "owner", "lifetime", "recovery"],
      properties: {
        id: { $ref: "#/$defs/identifier" },
        sessionId: { $ref: "#/$defs/identifier" },
        type: { const: "process" },
        owner: {
          type: "object",
          required: ["sessionId", "attachmentId", "generation"],
          properties: {
            sessionId: { $ref: "#/$defs/identifier" },
            attachmentId: { $ref: "#/$defs/identifier" },
            generation: { $ref: "#/$defs/generation" },
          },
        },
        lifetime: { enum: ["operation", "attachment", "external"] },
        recovery: { enum: ["none", "reconstruct", "reattach", "native"] },
        expiresAt: { $ref: "#/$defs/timestamp" },
      },
    },
    providerProcessId: { type: "string", minLength: 1, maxLength: 256 },
    startedAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Schema of the `inspect` result. */
export const processInspectResultSchema = {
  $id: "https://portable.dev/schema/process/inspect-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId", "state"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    state: { enum: ["running", "exited", "terminated", "unknown"] },
    exitCode: { type: "integer", minimum: 0, maximum: 255 },
    signal: signalProperty,
    timedOut: { type: "boolean" },
    startedAt: { $ref: "#/$defs/timestamp" },
    endedAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Schema of the `terminate` result. */
export const processTerminateResultSchema = {
  $id: "https://portable.dev/schema/process/terminate-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId", "confirmed", "descendantsStopped", "signal", "state"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    confirmed: { type: "boolean" },
    descendantsStopped: { type: "boolean" },
    signal: signalProperty,
    state: { enum: ["running", "exited", "terminated", "unknown"] },
    exitCode: { type: "integer", minimum: 0, maximum: 255 },
  },
} as const;

// -- Validation ---------------------------------------------------------------

/** Validate one `run` input and return it with its semantics fixed. */
export function validateProcessRunInput(input: unknown): ProcessRunInput {
  return checked(processRunInputSchema, input) as ProcessRunInput;
}

/** Validate one `start` input and return it with its semantics fixed. */
export function validateProcessStartInput(input: unknown): ProcessStartInput {
  return checked(processStartInputSchema, input) as ProcessStartInput;
}

/** Validate one `inspect` input. */
export function validateProcessInspectInput(input: unknown): ProcessInspectInput {
  return checked(processInspectInputSchema, input) as ProcessInspectInput;
}

/** Validate one `terminate` input. */
export function validateProcessTerminateInput(input: unknown): ProcessTerminateInput {
  return checked(processTerminateInputSchema, input) as ProcessTerminateInput;
}

/** Any validated `exec.process@1` input. */
export type ProcessInput =
  | ProcessRunInput
  | ProcessStartInput
  | ProcessInspectInput
  | ProcessTerminateInput;

/** Validate the input of one named operation. */
export function validateProcessInput(operation: ProcessOperation, input: unknown): ProcessInput {
  switch (operation) {
    case "run":
      return validateProcessRunInput(input);
    case "start":
      return validateProcessStartInput(input);
    case "inspect":
      return validateProcessInspectInput(input);
    case "terminate":
      return validateProcessTerminateInput(input);
  }
}

function checked(schema: object, input: unknown): unknown {
  try {
    assertValid(schema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  return input;
}

// -- Field semantics ----------------------------------------------------------

/**
 * Build the explicit shell invocation (SPEC.md section 14.1).
 *
 * Shell interpretation happens only when the caller names the shell
 * executable as the command and passes the script as a single
 * argument. This helper constructs that pair; a plain launch never
 * interprets anything.
 */
export function shellInvocation(shell: string, script: string): {
  command: string;
  args: string[];
} {
  if (shell.length === 0 || script.length === 0) {
    throw invalidRequestError("A shell invocation needs a shell executable and a script.", {
      shell,
    });
  }
  return { command: shell, args: ["-c", script] };
}

/** Options that bound one launch's working directory. */
export interface WorkingCopyBound {
  /** Absolute root of the authorized working copy. */
  copyRoot: string;
  /** Whether the caller explicitly allowed host paths. */
  hostAccess: boolean;
}

/**
 * Resolve one launch's working directory (SPEC.md section 14.1).
 *
 * An absent directory names the copy root. A relative path resolves
 * against the root and must stay inside it. An absolute path, or any
 * escape through `..`, needs `hostAccess`; without it the launch
 * refuses rather than reaching outside the authorized copy.
 */
export function resolveProcessCwd(
  cwd: string | undefined,
  bound: WorkingCopyBound,
): string {
  const root = resolvePath(bound.copyRoot);
  if (cwd === undefined) {
    return root;
  }
  const absolute = resolvePath(root, cwd);
  if (absolute === root || absolute.startsWith(`${root}${sep}`)) {
    return absolute;
  }
  if (bound.hostAccess) {
    return absolute;
  }
  throw invalidRequestError(
    `The working directory ${cwd} resolves outside the authorized working copy.`,
    { cwd, copyRoot: root, reason: "working-directory-escape" },
  );
}

/**
 * Merge environment additions over the provider's base (SPEC.md 14.1).
 *
 * Additions win on name conflicts. The result is a fresh map; neither
 * input is modified.
 */
export function mergeProcessEnvironment(
  base: Readonly<Record<string, string>>,
  additions?: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...base, ...(additions ?? {}) };
}

/**
 * Decode one launch's standard input per its explicit encoding.
 *
 * `utf-8` text encodes as UTF-8 bytes; `base64` decodes strictly, so
 * malformed input refuses instead of running under silent corruption.
 */
export function decodeProcessStdin(
  input: Pick<ProcessLaunchInput, "stdin" | "stdinEncoding">,
): Uint8Array {
  if (input.stdin === undefined) {
    return new Uint8Array(0);
  }
  if (input.stdinEncoding === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.stdin)) {
      throw invalidRequestError("The base64 standard input is malformed.", {
        reason: "stdin-encoding",
      });
    }
    return new Uint8Array(Buffer.from(input.stdin, "base64"));
  }
  return new Uint8Array(Buffer.from(input.stdin, "utf8"));
}

// -- Reference descriptor -----------------------------------------------------

/**
 * The reference descriptor of `exec.process@1`.
 *
 * The operation table states the shape of every input and output; the
 * attributes declare the reference environment's signals, descendant
 * termination, binary output, and process lifetime. A concrete
 * adapter overrides the attributes with its own truth; an incomplete
 * declaration fails `checkProcessAttributes` and therefore matching.
 */
export function processCapabilityDescriptor(
  attributes: ProcessAttributeDeclarations = {
    signals: ["SIGTERM", "SIGINT", "SIGKILL"],
    descendantTermination: "confirmed",
    binaryOutput: true,
    processLifetime: "attachment",
  },
): CapabilityDescriptor {
  return {
    id: PROCESS_CAPABILITY_ID,
    operations: {
      run: {
        inputSchema: launchInputSchema(["command"]),
        outputSchema: processRunResultSchema,
        stateful: false,
        effects: "mixed",
        retry: "unsafe",
        cancellation: "confirmed",
        streaming: true,
      },
      start: {
        inputSchema: launchInputSchema(["command"]),
        outputSchema: processStartResultSchema,
        stateful: true,
        effects: "mixed",
        retry: "unsafe",
        cancellation: "confirmed",
        streaming: false,
        createsResource: "process",
      },
      inspect: {
        inputSchema: processInspectInputSchema,
        outputSchema: processInspectResultSchema,
        stateful: false,
        effects: "none",
        retry: "safe",
        cancellation: "unsupported",
        streaming: false,
      },
      terminate: {
        inputSchema: processTerminateInputSchema,
        outputSchema: processTerminateResultSchema,
        stateful: true,
        effects: "external",
        retry: "unsafe",
        cancellation: "confirmed",
        streaming: false,
      },
    },
    attributes: {
      argumentForm: "array",
      shellInterpretation: "explicit-executable-only",
      signals: attributes.signals,
      descendantTermination: attributes.descendantTermination,
      binaryOutput: attributes.binaryOutput,
      processLifetime: attributes.processLifetime,
    },
  };
}
