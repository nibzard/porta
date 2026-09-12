import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  Monty,
  MontyCrashedError,
  MontyError,
  MontyRuntimeError,
  MontySyntaxError,
} from "@pydantic/monty";
import { MountDir } from "@pydantic/monty/node";
import {
  invalidRequestError,
  invalidRequestFromValidation,
  leaseExpiredError,
  policyDeniedError,
  providerUnavailableError,
  unsupportedOperationError,
} from "../core/errors.js";
import { ValidationError, assertValid } from "../schema/validate.js";
import { adapterInvocationSchema, authorizedAcquireRequestSchema } from "../schema/adapter.js";
import type {
  AdapterInvocation,
  AdapterOperation,
  AdapterOperationStatus,
  AcquisitionStatus,
  AuthorizedAcquireRequest,
  BindingResult,
  CancellationResult,
  EnvironmentAdapter,
  EnvironmentLease,
  LeaseStatus,
  ReleaseResult,
  AuthorizedContext,
} from "../schema/adapter.js";
import type {
  EnforcementFacts,
  EnvironmentManifest,
  EnvironmentOffer,
} from "../schema/capability.js";
import type { ResourceRef } from "../schema/resource.js";
import { checkTargetSatisfies, manifestTarget } from "../core/matching.js";
import {
  PYTHON_CAPABILITY_ID,
  checkEvaluateWithinLimits,
  pythonCapabilityDescriptor,
  resolvePythonBindingPath,
  validatePythonEvaluateInput,
  validatePythonEvaluateResult,
} from "../runtime/python-capability.js";
import type {
  PythonAttributeDeclarations,
  PythonBinding,
  PythonEvaluateInput,
  PythonEvaluateResult,
  PythonException,
} from "../runtime/python-capability.js";
import { VERSION } from "../version.js";

/**
 * Monty Python adapter (SPEC.md sections 8, 14.2, and 22).
 *
 * The adapter executes the `exec.python@1` contract on the Monty
 * engine — a sandboxed Python-subset interpreter that runs in
 * crash-isolated worker subprocesses. Every `evaluate` call checks
 * out one fresh session, runs one program, and returns the worker:
 * no name, global, or definition survives a call, which is the
 * `call-isolated` behavior the descriptor declares.
 *
 * The declaration is the engine's measured truth. The imports list
 * holds the modules this engine was verified to import and use;
 * anything else raises `ModuleNotFoundError` inside the call. Dicts
 * and sets cross to the host as opaque objects, so a result commits
 * only after a JSON-compatibility gate: a program that ends in a
 * value the contract cannot carry answers with a structured
 * exception, never with a silently emptied value.
 *
 * Limits are enforced by the engine, not trusted from the caller: the
 * duration limit ends the call at the cap and the result answers with
 * a `TimeoutError` exception and `timedOut` set. Printed output is
 * captured under the output cap; the rest drops with `truncated`.
 *
 * See docs/adapters/monty-python.md for the selected engine version,
 * the verified subset, and the requirements this engine leaves
 * unsupported.
 */

/** Provider identity of this adapter. */
export const MONTY_PYTHON_PROVIDER_ID = "monty-python";

/**
 * Imports this engine was verified to import and use. Anything else
 * raises `ModuleNotFoundError` at run time; matching sees the same
 * list, so a requirement for an unlisted module fails acquisition.
 */
export const MONTY_VERIFIED_IMPORTS = [
  "base64",
  "collections",
  "datetime",
  "functools",
  "itertools",
  "json",
  "math",
  "re",
] as const;

/** Default lease lifetime: fifteen minutes. */
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/**
 * Typed enforcement facts of this engine (SPEC.md 7).
 *
 * The interpreter workers run locally, hold no network, and see only
 * the authorized copy mounts — never the host filesystem.
 */
const ENFORCEMENT_FACTS: EnforcementFacts = {
  executionLocation: "local",
  networkEgress: "none",
  hostFilesystemAccess: false,
};

/** Default memory bound of one worker: 256 MiB. */
const DEFAULT_WORKER_MEMORY_BYTES = 256 * 1024 * 1024;

/** Default worker pool cap. */
const DEFAULT_MAX_PROCESSES = 2;

/** Backstop deadline of one pool turn, in seconds. */
const DEFAULT_REQUEST_TIMEOUT_SECS = 60;

/** Depth bound of the JSON-compatibility gate. */
const MAX_JSON_DEPTH = 128;

/** Virtual root every workspace binding mounts under. */
const MOUNT_ROOT = "/mnt";

/** The result schema's bounds, applied to engine text before return. */
const MAX_EXCEPTION_MESSAGE = 8192;
const MAX_TRACEBACK = 65536;

/**
 * One function the embedding application offers to sandbox programs.
 *
 * Positional arguments arrive in order; Python keyword arguments
 * arrive as a trailing object. A returned promise is awaited. A
 * thrown error crosses into the sandbox as a Python exception.
 */
export type MontyHostFunction = (...args: unknown[]) => unknown;

/** Options of one Monty Python adapter. */
export interface MontyPythonAdapterOptions {
  /** Host functions a call may bind by name (SPEC.md section 14.2). */
  hostFunctions?: Record<string, MontyHostFunction>;
  /**
   * The authorized working copy bindings resolve against. Without
   * one, workspace bindings refuse: the host authorized no copy.
   */
  workspaceRoot?: string;
  /** Limit overrides of the defaults; a provider may only narrow. */
  limits?: Partial<PythonAttributeDeclarations["limits"]>;
  /** Import list that overrides the verified default. */
  imports?: string[];
  /** Lease lifetime of one acquisition. */
  leaseTtlMs?: number;
  /** Worker memory bound in bytes. */
  workerMemoryBytes?: number;
  /** Worker pool cap. */
  maxProcesses?: number;
  /** Backstop deadline of one pool turn, in seconds. */
  requestTimeoutSecs?: number;
}

/** In-memory record of one acquisition identity. */
interface AcquisitionRecord {
  acquisitionId: string;
  environmentId: string;
  createdAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export class MontyPythonAdapter implements EnvironmentAdapter {
  readonly id = MONTY_PYTHON_PROVIDER_ID;
  private readonly hostFunctions: Record<string, MontyHostFunction>;
  private readonly workspaceRoot: string | undefined;
  private readonly declared: PythonAttributeDeclarations;
  private readonly leaseTtlMs: number;
  private readonly workerMemoryBytes: number;
  private readonly maxProcesses: number;
  private readonly requestTimeoutSecs: number;
  private readonly acquisitions = new Map<string, AcquisitionRecord>();
  private readonly byEnvironment = new Map<string, string>();
  private readonly operations = new Map<string, AdapterOperationStatus>();
  private poolPromise: Promise<Monty> | undefined;
  private closed = false;

  constructor(options: MontyPythonAdapterOptions = {}) {
    this.hostFunctions = { ...(options.hostFunctions ?? {}) };
    this.workspaceRoot = options.workspaceRoot;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.workerMemoryBytes = options.workerMemoryBytes ?? DEFAULT_WORKER_MEMORY_BYTES;
    this.maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.requestTimeoutSecs = options.requestTimeoutSecs ?? DEFAULT_REQUEST_TIMEOUT_SECS;
    this.declared = {
      engine: "monty",
      subset: "lite",
      imports: [...(options.imports ?? MONTY_VERIFIED_IMPORTS)],
      persistentState: "call-isolated",
      hostFunctions: Object.keys(this.hostFunctions),
      limits: {
        maxSourceBytes: options.limits?.maxSourceBytes ?? 262144,
        maxDurationMs: options.limits?.maxDurationMs ?? 30000,
        maxOutputBytes: options.limits?.maxOutputBytes ?? 262144,
      },
    };
  }

  // -- EnvironmentAdapter ------------------------------------------------------

  async describe(): Promise<EnvironmentOffer[]> {
    return [this.offer()];
  }

  async acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease> {
    checkValid(() => assertValid(authorizedAcquireRequestSchema, request));
    this.requireOpen();
    const existing = this.acquisitions.get(request.acquisitionId);
    if (existing !== undefined) {
      // One acquisition identity owns at most one environment; a
      // repeated acquire returns the same lease (SPEC.md section 5.2).
      return new MontyPythonLease(this, existing.environmentId);
    }
    const environmentId = `env-monty-${randomUUID()}`;
    // Requirements this engine cannot satisfy are rejected here,
    // before any allocation exists (SPEC.md section 7).
    const unsatisfied = checkTargetSatisfies(
      request.request,
      manifestTarget(this.manifestOf(environmentId)),
    );
    if (unsatisfied !== null) {
      throw unsatisfied;
    }
    const ttlMs = this.admissibleLeaseMs(request.limits);
    const now = new Date().toISOString();
    const record: AcquisitionRecord = {
      acquisitionId: request.acquisitionId,
      environmentId,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    this.acquisitions.set(record.acquisitionId, record);
    this.byEnvironment.set(record.environmentId, record.acquisitionId);
    return new MontyPythonLease(this, environmentId);
  }

  async reconcile(acquisitionId: string): Promise<AcquisitionStatus> {
    const record = this.acquisitions.get(acquisitionId);
    if (record === undefined) {
      // Environments of this adapter are in-memory interpreter
      // workers; a process that restarts finds none of them. The
      // honest answer is unknown, never a guess (SPEC.md section 8).
      return { acquisitionId, state: "unknown" };
    }
    return {
      acquisitionId,
      state: record.releasedAt !== undefined ? "released" : "allocated",
      environmentId: record.environmentId,
      manifest: this.manifestOf(record.environmentId),
      expiresAt: record.expiresAt,
    };
  }

  /** Stop the worker pool. Later calls refuse. */
  async close(): Promise<void> {
    this.closed = true;
    const pool = this.poolPromise;
    this.poolPromise = undefined;
    if (pool !== undefined) {
      await pool.then(
        (running) => running.close(),
        () => undefined,
      );
    }
  }

  // -- Adapter surface ------------------------------------------------------------

  /**
   * The lease span the effective limits admit, or a refusal.
   *
   * The engine workers run locally; a policy that allows no local
   * execution is refused before any worker exists. The engine has no
   * network and no host filesystem, so stricter egress and host
   * access policies are satisfied, and the lease span is constrained
   * to the lifetime ceiling.
   */
  private admissibleLeaseMs(limits: AuthorizedAcquireRequest["limits"]): number {
    if (!limits.executionLocations.includes("local")) {
      throw policyDeniedError(
        "The Monty engine executes locally; the policy allows no local execution.",
        { dimension: "locations", allowed: limits.executionLocations },
      );
    }
    if (limits.maxEnvironmentLifetimeMs <= 0) {
      throw policyDeniedError(
        "The policy grants no environment lifetime.",
        { dimension: "maxEnvironmentLifetimeMs", allowedMs: limits.maxEnvironmentLifetimeMs },
      );
    }
    return Math.min(this.leaseTtlMs, limits.maxEnvironmentLifetimeMs);
  }

  /** The declarations every environment of this adapter carries. */
  attributes(): PythonAttributeDeclarations {
    return {
      engine: this.declared.engine,
      subset: this.declared.subset,
      imports: [...this.declared.imports],
      persistentState: this.declared.persistentState,
      hostFunctions: [...this.declared.hostFunctions],
      limits: { ...this.declared.limits },
    };
  }

  /** The discovery offer of this adapter. */
  offer(): EnvironmentOffer {
    return {
      providerId: MONTY_PYTHON_PROVIDER_ID,
      adapterId: MONTY_PYTHON_PROVIDER_ID,
      platform: { os: process.platform, arch: process.arch },
      capabilities: [{ id: PYTHON_CAPABILITY_ID, attributes: { ...this.attributes() } }],
      enforcement: this.enforcement(),
      enforcementFacts: { ...ENFORCEMENT_FACTS },
    };
  }

  /** The manifest of one environment. */
  manifestOf(environmentId: string): EnvironmentManifest {
    return {
      environmentId,
      providerId: MONTY_PYTHON_PROVIDER_ID,
      platform: { os: process.platform, arch: process.arch },
      capabilities: [pythonCapabilityDescriptor(this.attributes())],
      enforcement: this.enforcement(),
      enforcementFacts: { ...ENFORCEMENT_FACTS },
      adapterVersion: VERSION,
    };
  }

  /** Enforcement this engine can honestly declare. */
  private enforcement(): Record<string, unknown> {
    return {
      isolation: "sandboxed-interpreter-worker",
      hostFilesystem: "authorized-copy-mounts-only",
      networkEgress: "none-engine-has-no-network",
      engine: "monty",
      engineVersion: montyEngineVersion(),
    };
  }

  /** Record one operation answer for later inspection. */
  recordOperation(status: AdapterOperationStatus): void {
    this.operations.set(status.operationId, status);
  }

  /** One recorded operation, or null. */
  operationOf(operationId: string): AdapterOperationStatus | null {
    return this.operations.get(operationId) ?? null;
  }

  /** The acquisition record that owns one environment. */
  acquisitionOfEnvironment(environmentId: string): AcquisitionRecord | null {
    const id = this.byEnvironment.get(environmentId);
    return id === undefined ? null : (this.acquisitions.get(id) ?? null);
  }

  /** Mark the acquisition of one environment released. */
  markReleased(environmentId: string): void {
    const record = this.acquisitionOfEnvironment(environmentId);
    if (record === null || record.releasedAt !== undefined) {
      return;
    }
    record.releasedAt = new Date().toISOString();
  }

  /** Whether the acquisition of one environment is released. */
  isReleased(environmentId: string): boolean {
    return this.acquisitionOfEnvironment(environmentId)?.releasedAt !== undefined;
  }

  /** The expiry the acquisition of one environment recorded. */
  expiryOf(environmentId: string): string {
    return this.acquisitionOfEnvironment(environmentId)?.expiresAt ?? new Date(0).toISOString();
  }

  /** Extend the lease of one environment to an absolute time. */
  extendLease(environmentId: string, expiresAt: string): void {
    const record = this.acquisitionOfEnvironment(environmentId);
    if (record !== null) {
      record.expiresAt = expiresAt;
    }
  }

  /** Refuse after close. */
  private requireOpen(): void {
    if (this.closed) {
      throw providerUnavailableError("The Monty adapter is closed.");
    }
  }

  /** Route one invocation from a lease. */
  async invokeOnLease(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<AdapterOperation> {
    checkValid(() => assertValid(adapterInvocationSchema, request));
    this.requireAuthorityOf(environmentId);
    if (request.capability !== PYTHON_CAPABILITY_ID) {
      throw unsupportedOperationError(request.capability, request.operation, {
        reason: "The Monty adapter offers only exec.python@1.",
      });
    }
    if (request.operation !== "evaluate") {
      throw unsupportedOperationError(request.capability, request.operation, {
        reason: "The Monty adapter offers only evaluate.",
      });
    }
    const operation = await this.evaluate(
      request,
      validatePythonEvaluateInput(request.input),
    );
    this.recordOperation({
      operationId: request.operationId,
      status: operation.status,
      result: operation.result,
    });
    return operation;
  }

  /** Evaluate one program in one isolated session (SPEC.md 14.2). */
  private async evaluate(
    request: AdapterInvocation,
    input: PythonEvaluateInput,
  ): Promise<AdapterOperation> {
    const startedAt = new Date().toISOString();
    const overLimit = checkEvaluateWithinLimits(input, this.declared.limits);
    if (overLimit !== null) {
      throw overLimit;
    }
    const bindings = this.bindingsOf(input.bindings ?? []);
    const pool = await this.ensurePool();
    const session = await pool.checkout({
      limits: {
        maxDurationSecs: (input.timeoutMs ?? this.declared.limits.maxDurationMs) / 1000,
        maxMemory: this.workerMemoryBytes,
      },
    });
    const capture = new OutputCapture(input.maxOutputBytes ?? this.declared.limits.maxOutputBytes);
    let result: PythonEvaluateResult;
    try {
      const value = await session.feedRun(input.source, {
        ...(input.variables !== undefined ? { inputs: input.variables } : {}),
        ...(bindings.host.size > 0
          ? { externalLookup: Object.fromEntries(bindings.host.entries()) }
          : {}),
        printCallback: (stream, text) => capture.absorb(stream, text),
        ...(bindings.mounts.length > 0 ? { mount: bindings.mounts } : {}),
      });
      result = valueResult(value, capture.finish(), startedAt);
    } catch (error) {
      // A provider fault rethrows; a program failure answers with a
      // structured exception (SPEC.md section 14.2).
      result = exceptionResult(error, capture.finish(), startedAt);
    } finally {
      for (const mount of bindings.mounts) {
        mount.close();
      }
      await session.close().catch(() => undefined);
    }
    // The adapter answers only through the contract's result schema;
    // a hand-built result that fails it is a provider fault.
    return {
      operationId: request.operationId,
      status: "completed",
      result: validatePythonEvaluateResult(result),
    };
  }

  /** The worker pool, created once and shared by every environment. */
  private ensurePool(): Promise<Monty> {
    this.poolPromise ??= Monty.create({
      minProcesses: 0,
      maxProcesses: this.maxProcesses,
      requestTimeout: this.requestTimeoutSecs,
    });
    return this.poolPromise;
  }

  /** Resolve one call's bindings into host functions and mounts. */
  private bindingsOf(bindings: PythonBinding[]): {
    host: Map<string, MontyHostFunction>;
    mounts: MountDir[];
  } {
    const host = new Map<string, MontyHostFunction>();
    const mounts: MountDir[] = [];
    for (const binding of bindings) {
      if (binding.kind === "host-function") {
        const fn = this.hostFunctions[binding.name];
        if (fn === undefined) {
          throw invalidRequestError(
            `The host function ${binding.name} is not offered by this provider.`,
            { name: binding.name, offered: this.declared.hostFunctions },
          );
        }
        host.set(binding.name, fn);
        continue;
      }
      mounts.push(this.mountOf(binding));
    }
    return { host, mounts };
  }

  /** Mount one workspace binding's directory inside the sandbox. */
  private mountOf(binding: PythonBinding): MountDir {
    if (this.workspaceRoot === undefined) {
      throw invalidRequestError(
        `The provider authorized no working copy; the binding ${binding.name} cannot resolve.`,
        { name: binding.name },
      );
    }
    const absolute = resolvePythonBindingPath(binding, { copyRoot: this.workspaceRoot });
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw invalidRequestError(
        `The binding ${binding.name} names no directory of the authorized copy.`,
        { name: binding.name, path: binding.path },
      );
    }
    try {
      return new MountDir({
        hostPath: absolute,
        virtualPath: `${MOUNT_ROOT}/${binding.name}`,
        mode: binding.mode === "read-write" ? "read-write" : "read-only",
      });
    } catch (error) {
      throw invalidRequestError(
        `The binding ${binding.name} could not open ${binding.path}: ${errorMessage(error)}`,
        { name: binding.name, path: binding.path },
      );
    }
  }

  /** Refuse work after expiry or release (SPEC.md section 8). */
  private requireAuthorityOf(environmentId: string): void {
    this.requireOpen();
    const expiresAt = this.expiryOf(environmentId);
    if (this.isReleased(environmentId) || Date.parse(expiresAt) <= Date.now()) {
      throw leaseExpiredError(`environment ${environmentId}`, expiresAt);
    }
  }
}

/** Lease over one Monty environment (SPEC.md section 8). */
export class MontyPythonLease implements EnvironmentLease {
  constructor(
    private readonly provider: MontyPythonAdapter,
    readonly environmentId: string,
  ) {}

  /** When the acquisition record says the lease ends. */
  get expiresAt(): string {
    return this.provider.expiryOf(this.environmentId);
  }

  async manifest(): Promise<EnvironmentManifest> {
    return this.provider.manifestOf(this.environmentId);
  }

  async invoke(request: AdapterInvocation): Promise<AdapterOperation> {
    return this.provider.invokeOnLease(this.environmentId, request);
  }

  async inspect(operationId: string): Promise<AdapterOperationStatus> {
    const status = this.provider.operationOf(operationId);
    if (status === null) {
      throw invalidRequestError(
        `Operation ${operationId} is not known to this environment.`,
        { operationId },
      );
    }
    return status;
  }

  async cancel(operationId: string): Promise<CancellationResult> {
    void operationId;
    // The descriptor declares cancellation unsupported; an evaluation
    // ends at its limit or its end, never between.
    return {
      outcome: "unsupported",
      stopped: false,
      detail: "Monty evaluation accepts no cancellation between limits.",
    };
  }

  async bind(resource: ResourceRef, context: AuthorizedContext): Promise<BindingResult> {
    void resource;
    void context;
    return { status: "unsupported" };
  }

  async renew(expiresAt: string): Promise<LeaseStatus> {
    this.provider.extendLease(this.environmentId, expiresAt);
    return { status: "active", expiresAt, renewalSupported: true };
  }

  async release(): Promise<ReleaseResult> {
    // Idempotent: a released environment's sessions already went back
    // to the pool, and a second release finds nothing held.
    this.provider.markReleased(this.environmentId);
    return { status: "released", retryable: false };
  }
}

// -- Capture and conversion helpers -----------------------------------------------

/** Printed output under a byte cap. */
class OutputCapture {
  private text = "";
  private held = 0;
  private truncated = false;

  constructor(private readonly cap: number) {}

  absorb(stream: "stdout" | "stderr", text: string): void {
    void stream;
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.held + bytes <= this.cap) {
      this.text += text;
      this.held += bytes;
      return;
    }
    // Keep what fits; the rest drops with the truncation flag set.
    if (this.held < this.cap) {
      const room = this.cap - this.held;
      const kept = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
      this.text += kept;
      this.held += Buffer.byteLength(kept, "utf8");
    }
    this.truncated = true;
  }

  finish(): PythonEvaluateResult["output"] {
    return { text: this.text, byteLength: this.held, truncated: this.truncated };
  }
}

/** The JSON gate's answer for one engine value. */
type JsonGate = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Convert one engine value to a JSON-compatible value.
 *
 * Monty hands dicts and sets to the host as opaque objects, so a
 * program that ends in one fails the gate instead of reporting an
 * emptied value. The refusal carries the fix: convert with
 * `json.dumps`.
 */
function toJsonValue(value: unknown, depth = 0): JsonGate {
  if (value === null) {
    return { ok: true, value: null };
  }
  const kind = typeof value;
  if (kind === "boolean" || kind === "number" || kind === "string") {
    return { ok: true, value };
  }
  if (depth >= MAX_JSON_DEPTH) {
    return { ok: false, reason: "The result nests deeper than 128 levels." };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const converted = toJsonValue(item, depth + 1);
      if (!converted.ok) {
        return converted;
      }
      items.push(converted.value);
    }
    return { ok: true, value: items };
  }
  if (kind === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const converted = toJsonValue(item, depth + 1);
        if (!converted.ok) {
          return converted;
        }
        out[key] = converted.value;
      }
      return { ok: true, value: out };
    }
    if (value instanceof Map) {
      // Monty hands dicts over as Maps. A dict whose keys are all
      // strings is a JSON object; anything else — integer keys, None
      // keys — is not, and refuses instead of losing keys.
      const out: Record<string, unknown> = {};
      for (const [key, item] of value) {
        if (typeof key !== "string") {
          return {
            ok: false,
            reason:
              `The program ended in a dict keyed by ${typeof key}, which the result ` +
              "cannot carry. End it with a JSON-compatible value; convert other values with json.dumps.",
          };
        }
        const converted = toJsonValue(item, depth + 1);
        if (!converted.ok) {
          return converted;
        }
        out[key] = converted.value;
      }
      return { ok: true, value: out };
    }
    if (value instanceof Set) {
      return {
        ok: false,
        reason:
          "The program ended in a set, which the result cannot carry. " +
          "End it with a JSON-compatible value; convert other values with json.dumps.",
      };
    }
  }
  return {
    ok: false,
    reason: `The program ended in a ${kind} the result cannot carry. ` +
      "End it with a JSON-compatible value.",
  };
}

/** The result of one program that ended in a value. */
function valueResult(
  value: unknown,
  output: PythonEvaluateResult["output"],
  startedAt: string,
): PythonEvaluateResult {
  const gate = toJsonValue(value);
  if (gate.ok) {
    return {
      value: gate.value,
      output,
      timedOut: false,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  }
  return {
    exception: { type: "TypeError", message: gate.reason },
    output,
    timedOut: false,
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

/**
 * One Monty failure as the contract's structured exception result.
 *
 * A worker crash rethrows as a provider fault: the program's answer
 * is unknown, and an unknown answer is never a program exception.
 */
function exceptionResult(
  error: unknown,
  output: PythonEvaluateResult["output"],
  startedAt: string,
): PythonEvaluateResult {
  if (!(error instanceof MontyError)) {
    throw providerUnavailableError(`The Monty engine failed: ${errorMessage(error)}`, {});
  }
  if (error instanceof MontyCrashedError) {
    throw providerUnavailableError(
      `The Monty worker ended the call: ${error.message}`,
      { timedOut: error.timedOut, exitStatus: error.exitStatus },
    );
  }
  const info = error.exception;
  const timedOut = info.typeName === "TimeoutError" && /^time limit exceeded/.test(info.message);
  const exception: PythonException = {
    type: info.typeName.slice(0, 128),
    message: info.message.slice(0, MAX_EXCEPTION_MESSAGE),
  };
  if (error instanceof MontyRuntimeError) {
    exception.traceback = error.display("traceback").slice(0, MAX_TRACEBACK);
    const deepest = error.traceback().at(-1);
    if (deepest !== undefined) {
      exception.line = deepest.line;
      exception.column = deepest.column;
    }
  } else if (error instanceof MontySyntaxError) {
    exception.traceback = error.display("traceback").slice(0, MAX_TRACEBACK);
  }
  return {
    exception,
    output,
    timedOut,
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

/** The installed engine version, when resolvable. */
let engineVersionCache: string | undefined;
function montyEngineVersion(): string {
  engineVersionCache ??= resolveMontyVersion();
  return engineVersionCache;
}

function resolveMontyVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@pydantic/monty");
    const manifest = require(entry.replace(/\/dist\/[^/]+$/, "/package.json")) as {
      version?: string;
    };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** One-line message of an unknown error. */
function errorMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Run one validation, mapping failures to Portable errors. */
function checkValid(run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
}
