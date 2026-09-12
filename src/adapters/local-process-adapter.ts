import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  invalidRequestError,
  invalidRequestFromValidation,
  leaseExpiredError,
  policyDeniedError,
  providerUnavailableError,
  unsupportedOperationError,
} from "../core/errors.js";
import { ValidationError, assertValid } from "../schema/validate.js";
import {
  adapterInvocationSchema,
  authorizedAcquireRequestSchema,
} from "../schema/adapter.js";
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
} from "../schema/adapter.js";
import type { AuthorizedContext } from "../schema/adapter.js";
import type {
  EnforcementFacts,
  EnvironmentManifest,
  EnvironmentOffer,
} from "../schema/capability.js";
import type { ResourceRef } from "../schema/resource.js";
import { checkTargetSatisfies, manifestTarget } from "../core/matching.js";
import {
  PROCESS_CAPABILITY_ID,
  decodeProcessStdin,
  mergeProcessEnvironment,
  processCapabilityDescriptor,
  resolveProcessCwd,
  validateProcessInspectInput,
  validateProcessRunInput,
  validateProcessStartInput,
  validateProcessTerminateInput,
} from "../runtime/process-capability.js";
import type {
  ProcessInspectResult,
  ProcessLaunchInput,
  ProcessRunResult,
  ProcessState,
  ProcessStreamCapture,
  ProcessTerminateResult,
} from "../runtime/process-capability.js";
import { VERSION } from "../version.js";

/**
 * Local process adapter (SPEC.md sections 7, 8, and 14.1).
 *
 * The adapter executes the `exec.process@1` contract on the local host
 * under the caller's own account, and it declares exactly that truth:
 * full host filesystem access, inherited host networking, and no
 * sandbox. Isolation requirements this host cannot enforce are
 * rejected at acquisition, never accepted and ignored (SPEC.md 7).
 *
 * Background processes outlive the adapter process through the
 * supervisor state directory: every started process runs detached as
 * its own process-group leader, and its identity, captured streams,
 * and outcome live in files under `supervisorDir`. A later process —
 * a new CLI invocation — that opens the same directory inspects and
 * terminates the same handles. A child's exit code is known only to
 * the process that spawned it; across a restart, inspection reports
 * the state without inventing an exit code.
 *
 * Termination claims are measured, not assumed: a stop counts as
 * confirmed only when the process group is gone, and
 * `descendantsStopped` comes from the same group check.
 *
 * Release holds the same measure whatever became of the leader: an
 * orphaned descendant holds the group exactly like its parent did,
 * so release stops it with the same grace and escalation. A group
 * that will not confirm ends the lease but reports the release as
 * failed, so the unfinished stop stays visible as cleanup work.
 * Each record carries its leader's kernel start time where Linux
 * exposes it, and a termination verifies that evidence before it
 * signals: a recycled process identifier never draws a signal onto
 * a process this environment never owned. Records older than the
 * evidence field — and platforms without `/proc` — trust the signal
 * probe alone; that limit is the platform's and the adapter states
 * it, never hides it.
 */

/** Provider identity of this adapter. */
export const LOCAL_PROCESS_PROVIDER_ID = "local-process";

/** Enforcement the local host can honestly declare (SPEC.md 7). */
const ENFORCEMENT = {
  isolation: "none",
  hostFilesystem: "full",
  networkEgress: "unrestricted-inherited",
  supervision: "state-directory",
} as const;

/**
 * Typed enforcement facts of this host (SPEC.md 7).
 *
 * Local processes run on the caller's own account: they inherit host
 * networking and reach the whole host filesystem. The adapter can
 * enforce nothing stricter, so a policy that withholds either one
 * refuses acquisition here instead of being accepted and ignored.
 */
const ENFORCEMENT_FACTS: EnforcementFacts = {
  executionLocation: "local",
  networkEgress: "unrestricted",
  hostFilesystemAccess: true,
};

/** Options of one local process adapter. */
export interface LocalProcessAdapterOptions {
  /**
   * Durable supervisor state. Started processes, their streams, and
   * acquisition identities live here, so any process that opens the
   * same directory sees the same handles.
   */
  supervisorDir: string;
  /** Lease lifetime of one acquisition. Invocations after expiry
   * refuse; renewal extends (SPEC.md section 8). */
  leaseTtlMs?: number;
  /** Hard cap on captured bytes per stream. A request that asks for
   * more still gets this cap. */
  maxOutputBytesPerStream?: number;
  /** Base environment every launch merges its additions over. */
  baseEnvironment?: Record<string, string>;
  /** Root that working directories resolve against without host
   * access. Defaults to `<supervisorDir>/workspace`. */
  workingCopyRoot?: string;
  /**
   * Provider identity this adapter declares. Defaults to
   * `local-process`; a second independent instance that must stay
   * distinguishable in durable records names its own id.
   */
  providerId?: string;
}

/** Durable record of one started background process. */
export interface ProcessRecord {
  resourceId: string;
  operationId: string;
  environmentId: string;
  pid: number;
  command: string;
  args: string[];
  startedAt: string;
  /**
   * Kernel start time of the recorded leader, in `/proc` clock ticks
   * (Linux only). It tells the recorded leader apart from a later
   * process the operating system lands on the same identifier.
   */
  leaderStartTicks?: number;
  /** Written by the process that spawned it, when it saw the exit. */
  exitedAt?: string;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  /** Why the process never started, when spawning failed. */
  spawnError?: string;
  terminate?: {
    confirmed: boolean;
    descendantsStopped: boolean;
    signal: string;
    at: string;
  };
}

/** Durable record of one acquisition identity. */
export interface AcquisitionRecord {
  acquisitionId: string;
  environmentId: string;
  createdAt: string;
  expiresAt: string;
  releasedAt?: string;
}

/** Default lease lifetime: fifteen minutes. */
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/** Default capture cap per stream: eight MiB. */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Grace between SIGTERM and SIGKILL inside a termination, in ms. */
const TERMINATE_GRACE_MS = 300;

/** How long a termination waits for the group to die, in ms. */
const TERMINATE_WAIT_MS = 2000;

export class LocalProcessAdapter implements EnvironmentAdapter {
  get id(): string {
    return this.providerId;
  }
  private readonly supervisorDirPath: string;
  private readonly processesDir: string;
  private readonly acquisitionsDir: string;
  private readonly workspaceRoot: string;
  private readonly leaseTtlMs: number;
  private readonly maxOutputBytes: number;
  private readonly baseEnvironment: Record<string, string>;
  private readonly providerId: string;

  constructor(options: LocalProcessAdapterOptions) {
    const dir = options.supervisorDir;
    this.supervisorDirPath = dir;
    this.processesDir = join(dir, "processes");
    this.acquisitionsDir = join(dir, "acquisitions");
    this.workspaceRoot = options.workingCopyRoot ?? join(dir, "workspace");
    mkdirSync(this.processesDir, { recursive: true });
    mkdirSync(this.acquisitionsDir, { recursive: true });
    mkdirSync(this.workspaceRoot, { recursive: true });
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.maxOutputBytes = options.maxOutputBytesPerStream ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.baseEnvironment =
      options.baseEnvironment ?? ({ ...process.env } as Record<string, string>);
    this.providerId = options.providerId ?? LOCAL_PROCESS_PROVIDER_ID;
  }

  // -- EnvironmentAdapter ------------------------------------------------------

  async describe(): Promise<EnvironmentOffer[]> {
    return [this.offer()];
  }

  async acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease> {
    checkValid(() => assertValid(authorizedAcquireRequestSchema, request));
    const existing = this.readAcquisition(request.acquisitionId);
    if (existing !== null) {
      // One acquisition identity owns at most one environment; a
      // repeated acquire returns the same lease (SPEC.md section 5.2).
      return this.lease(existing.environmentId);
    }
    const environmentId = `env-local-${randomUUID()}`;
    // Requirements this host cannot enforce are rejected here, before
    // any allocation exists (SPEC.md section 7).
    const unsatisfied = checkTargetSatisfies(
      request.request,
      manifestTarget(this.manifestOf(environmentId)),
    );
    if (unsatisfied !== null) {
      throw unsatisfied;
    }
    const ttlMs = this.admissibleLeaseMs(request.limits);
    const now = new Date().toISOString();
    this.writeAcquisition({
      acquisitionId: request.acquisitionId,
      environmentId,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    });
    return this.lease(environmentId);
  }

  async reconcile(acquisitionId: string): Promise<AcquisitionStatus> {
    const record = this.readAcquisition(acquisitionId);
    if (record === null) {
      return { acquisitionId, state: "unknown" };
    }
    return {
      acquisitionId,
      state: "allocated",
      environmentId: record.environmentId,
      manifest: this.manifestOf(record.environmentId),
      expiresAt: record.expiresAt,
    };
  }

  // -- Supervisor surface --------------------------------------------------------

  /**
   * The lease span the effective limits admit, or a refusal.
   *
   * This host cannot restrict network egress or withhold host
   * filesystem access: a policy that demands either is refused before
   * any allocation exists. The lease span is constrained to the
   * lifetime ceiling where a longer configured default exists.
   */
  private admissibleLeaseMs(limits: AuthorizedAcquireRequest["limits"]): number {
    if (!limits.executionLocations.includes("local")) {
      throw policyDeniedError(
        "The local process adapter executes locally; the policy allows no local execution.",
        { dimension: "locations", allowed: limits.executionLocations },
      );
    }
    if (limits.networkEgress !== "unrestricted") {
      throw policyDeniedError(
        "The local process adapter inherits host networking; it cannot enforce restricted egress.",
        { dimension: "networkEgress", allowed: limits.networkEgress },
      );
    }
    if (!limits.hostFilesystemAccess) {
      throw policyDeniedError(
        "Local processes run under the caller's account; host filesystem access cannot be withheld.",
        { dimension: "hostFilesystemAccess" },
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

  /** The lease of one allocated environment. */
  lease(environmentId: string): LocalProcessLease {
    const record = this.acquisitionOfEnvironment(environmentId);
    if (record === null) {
      throw invalidRequestError(`Environment ${environmentId} is not allocated.`);
    }
    return new LocalProcessLease(this, environmentId);
  }

  /** The acquisition record that owns one environment. */
  acquisitionOfEnvironment(environmentId: string): AcquisitionRecord | null {
    for (const name of readdirSync(this.acquisitionsDir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const record = this.readAcquisition(name.slice(0, -".json".length));
      if (record?.environmentId === environmentId) {
        return record;
      }
    }
    return null;
  }

  /** One process record by its resource identifier. */
  processRecord(resourceId: string): ProcessRecord | null {
    return this.readJson<ProcessRecord>(join(this.processesDir, `${resourceId}.json`));
  }

  /** Every process record of one environment. */
  processRecordsOf(environmentId: string): ProcessRecord[] {
    return this.listRecords<ProcessRecord>(this.processesDir).filter(
      (record) => record.environmentId === environmentId,
    );
  }

  /** Persist one process record durably. */
  saveProcessRecord(record: ProcessRecord): void {
    this.writeJson(join(this.processesDir, `${record.resourceId}.json`), record);
  }

  /** Mark the acquisition of one environment released. */
  markReleased(environmentId: string): void {
    const record = this.acquisitionOfEnvironment(environmentId);
    if (record === null || record.releasedAt !== undefined) {
      return;
    }
    this.writeAcquisition({ ...record, releasedAt: new Date().toISOString() });
  }

  /** Whether the acquisition of one environment is released. */
  isReleased(environmentId: string): boolean {
    return this.acquisitionOfEnvironment(environmentId)?.releasedAt !== undefined;
  }

  /** The expiry the acquisition of one environment recorded. */
  expiryOf(environmentId: string): string {
    return (
      this.acquisitionOfEnvironment(environmentId)?.expiresAt ??
      new Date(0).toISOString()
    );
  }

  /** Extend the lease of one environment to an absolute time. */
  extendLease(environmentId: string, expiresAt: string): void {
    const record = this.acquisitionOfEnvironment(environmentId);
    if (record === null) {
      return;
    }
    this.writeAcquisition({ ...record, expiresAt });
  }

  /** Paths of one resource's durable stream captures. */
  streamFiles(resourceId: string): { stdoutPath: string; stderrPath: string } {
    return {
      stdoutPath: join(this.processesDir, `${resourceId}.out`),
      stderrPath: join(this.processesDir, `${resourceId}.err`),
    };
  }

  /** The adapter's capture cap per stream. */
  get captureCap(): number {
    return this.maxOutputBytes;
  }

  /** The base environment launches merge over. */
  get environmentBase(): Record<string, string> {
    return this.baseEnvironment;
  }

  /** The root working directories resolve against without host access. */
  get copyRoot(): string {
    return this.workspaceRoot;
  }

  /** The discovery offer of this adapter. */
  offer(): EnvironmentOffer {
    return {
      providerId: this.providerId,
      adapterId: this.providerId,
      platform: { os: process.platform, arch: process.arch },
      capabilities: [
        { id: PROCESS_CAPABILITY_ID, attributes: processCapabilityDescriptor().attributes },
      ],
      enforcement: { ...ENFORCEMENT, supervisorDir: this.supervisorDirPath },
      enforcementFacts: { ...ENFORCEMENT_FACTS },
    };
  }

  /** The manifest of one local environment. */
  manifestOf(environmentId: string): EnvironmentManifest {
    return {
      environmentId,
      providerId: this.providerId,
      platform: { os: process.platform, arch: process.arch },
      capabilities: [processCapabilityDescriptor()],
      enforcement: { ...ENFORCEMENT, supervisorDir: this.supervisorDirPath },
      enforcementFacts: { ...ENFORCEMENT_FACTS },
      adapterVersion: VERSION,
    };
  }

  private readAcquisition(acquisitionId: string): AcquisitionRecord | null {
    return this.readJson<AcquisitionRecord>(
      join(this.acquisitionsDir, `${acquisitionId}.json`),
    );
  }

  private writeAcquisition(record: AcquisitionRecord): void {
    this.writeJson(join(this.acquisitionsDir, `${record.acquisitionId}.json`), record);
  }

  private readJson<T>(path: string): T | null {
    if (!existsSync(path)) {
      return null;
    }
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  private listRecords<T>(dir: string): T[] {
    const records: T[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const record = this.readJson<T>(join(dir, name));
      if (record !== null) {
        records.push(record);
      }
    }
    return records;
  }

  private writeJson(path: string, value: unknown): void {
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value, undefined, 2));
    renameSync(temp, path);
  }
}

/** Lease over one local environment (SPEC.md section 8). */
export class LocalProcessLease implements EnvironmentLease {
  private released = false;

  constructor(
    private readonly provider: LocalProcessAdapter,
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
    checkValid(() => assertValid(adapterInvocationSchema, request));
    this.requireAuthority();
    if (request.capability !== PROCESS_CAPABILITY_ID) {
      throw unsupportedOperationError(request.capability, request.operation, {
        reason: "The local adapter offers only exec.process@1.",
      });
    }
    switch (request.operation) {
      case "run":
        return this.run(request, validateProcessRunInput(request.input));
      case "start":
        return this.start(request, validateProcessStartInput(request.input));
      case "inspect":
        return this.inspectResource(request, validateProcessInspectInput(request.input));
      case "terminate":
        return this.terminate(request, validateProcessTerminateInput(request.input));
      default:
        throw unsupportedOperationError(request.capability, request.operation);
    }
  }

  async inspect(operationId: string): Promise<AdapterOperationStatus> {
    const record = this.recordByOperation(operationId);
    if (record === null) {
      throw invalidRequestError(
        `Operation ${operationId} is not known to this environment.`,
        { operationId },
      );
    }
    return {
      operationId,
      status: this.stateOf(record) === "running" ? "running" : "completed",
    };
  }

  async cancel(operationId: string): Promise<CancellationResult> {
    const record = this.recordByOperation(operationId);
    if (record === null) {
      // An operation this environment never held cannot be stopped
      // here; the honest answer says so instead of claiming a stop.
      return {
        outcome: "best-effort",
        stopped: false,
        detail: `Operation ${operationId} is not known to this environment.`,
      };
    }
    const outcome = await this.terminateGroup(record, "SIGTERM");
    return {
      outcome: outcome.confirmed ? "confirmed" : "best-effort",
      stopped: outcome.confirmed,
      descendantsStopped: outcome.descendantsStopped,
    };
  }

  async bind(resource: ResourceRef, context: AuthorizedContext): Promise<BindingResult> {
    // Local processes share the host; there is no consumer side to
    // bind. The refusal is explicit, not a failure (SPEC.md section 8).
    void resource;
    void context;
    return { status: "unsupported" };
  }

  async renew(expiresAt: string): Promise<LeaseStatus> {
    this.requireAuthority();
    this.provider.extendLease(this.environmentId, expiresAt);
    return { status: "active", expiresAt, renewalSupported: true };
  }

  async release(): Promise<ReleaseResult> {
    // Every owned group stops, whatever became of its leader: an
    // orphaned descendant holds the group exactly like its parent
    // did. A group that will not confirm ends the lease but reports
    // the release as failed, so the stop stays cleanup work instead
    // of a released claim (SPEC.md sections 8, 8.1).
    const unresolved: string[] = [];
    for (const record of this.provider.processRecordsOf(this.environmentId)) {
      if (!leaderAlive(record) && !groupAlive(record.pid)) {
        continue;
      }
      const outcome = await this.terminateGroup(record, "SIGTERM");
      if (!outcome.confirmed || !outcome.descendantsStopped) {
        unresolved.push(record.resourceId);
      }
    }
    this.provider.markReleased(this.environmentId);
    this.released = true;
    if (unresolved.length > 0) {
      return {
        status: "failed",
        retryable: true,
        detail:
          `The process group of ${unresolved.join(", ")} stayed alive after release; ` +
          "the unfinished termination stays visible in its record.",
      };
    }
    return { status: "released", retryable: false };
  }

  // -- Operations ------------------------------------------------------------------

  private async run(
    request: AdapterInvocation,
    input: ProcessLaunchInput,
  ): Promise<AdapterOperation> {
    const startedAt = new Date().toISOString();
    const child = this.spawn(input, "pipe");
    const cap = this.effectiveCap(input);
    const stdout = new Capture(cap);
    const stderr = new Capture(cap);

    if (child.stdin !== null) {
      const bytes = decodeProcessStdin(input);
      child.stdin.end(bytes.byteLength > 0 ? bytes : undefined);
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.absorb(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.absorb(chunk));

    const timedOut = { value: false };
    let timer: NodeJS.Timeout | undefined;
    if (input.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut.value = true;
        // The timeout ends the whole group, not just the leader:
        // descendants are the run's responsibility while it waits.
        killGroup(child.pid ?? 0, "SIGTERM");
        setTimeout(() => killGroup(child.pid ?? 0, "SIGKILL"), TERMINATE_GRACE_MS).unref();
      }, input.timeoutMs);
    }
    let exit: { code: number | null; signal: string | null };
    try {
      exit = await closeOf(child);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      // No descendant of a completed run outlives it. The group check
      // guards the signal: a reaped identifier is free for reuse, and
      // a fresh group under it would be a stranger's.
      if (groupAlive(child.pid ?? 0)) {
        killGroup(child.pid ?? 0, "SIGKILL");
      }
    }
    const result: ProcessRunResult = {
      ...(exit.signal !== null
        ? { signal: exit.signal }
        : timedOut.value
          ? { signal: "SIGTERM" }
          : { exitCode: exit.code ?? 0 }),
      timedOut: timedOut.value,
      stdout: stdout.finish(),
      stderr: stderr.finish(),
      startedAt,
      endedAt: new Date().toISOString(),
    };
    return { operationId: request.operationId, status: "completed", result };
  }

  private start(
    request: AdapterInvocation,
    input: ProcessLaunchInput,
  ): AdapterOperation {
    const startedAt = new Date().toISOString();
    const resourceId = `proc-${randomUUID()}`;
    const files = this.provider.streamFiles(resourceId);
    const child = this.spawn(input, { stdoutPath: files.stdoutPath, stderrPath: files.stderrPath });
    // Detached children keep running after this process exits; the
    // record is the durable handle the next process reads.
    child.unref();
    // Record the leader's kernel identity while it is fresh, so a
    // later termination never mistakes a recycled identifier for it.
    const leaderStartTicks = procStartTicks(child.pid ?? 0);
    const record: ProcessRecord = {
      resourceId,
      operationId: request.operationId,
      environmentId: this.environmentId,
      pid: child.pid ?? 0,
      command: input.command,
      args: input.args ?? [],
      startedAt,
      ...(leaderStartTicks !== null ? { leaderStartTicks } : {}),
    };
    this.provider.saveProcessRecord(record);
    // Observe the exit while this process lives; if it dies first,
    // the next inspection reads liveness from the group and reports
    // no exit code rather than a guess.
    observeExit(child, (outcome, spawnError) => {
      const current = this.provider.processRecord(resourceId);
      if (current === null) {
        return;
      }
      this.provider.saveProcessRecord({
        ...current,
        exitedAt: new Date().toISOString(),
        ...(outcome?.code !== null && outcome?.code !== undefined
          ? { exitCode: outcome.code }
          : {}),
        ...(outcome?.signal !== null && outcome?.signal !== undefined
          ? { signal: outcome.signal }
          : {}),
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    });
    return {
      operationId: request.operationId,
      status: "completed",
      // The portable ResourceRef is the runtime's to compose through
      // the binding flow; this result carries the provider identity.
      result: {
        resourceId,
        providerProcessId: String(child.pid ?? 0),
        startedAt,
      },
    };
  }

  private inspectResource(
    request: AdapterInvocation,
    input: { resourceId: string },
  ): AdapterOperation {
    const record = this.requireRecord(input.resourceId);
    const result: ProcessInspectResult = {
      resourceId: record.resourceId,
      state: this.stateOf(record),
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.signal !== undefined ? { signal: record.signal } : {}),
      ...(record.timedOut !== undefined ? { timedOut: record.timedOut } : {}),
      startedAt: record.startedAt,
      ...(record.exitedAt !== undefined ? { endedAt: record.exitedAt } : {}),
    };
    return { operationId: request.operationId, status: "completed", result };
  }

  private async terminate(
    request: AdapterInvocation,
    input: { resourceId: string; signal?: string },
  ): Promise<AdapterOperation> {
    const record = this.requireRecord(input.resourceId);
    const signal = input.signal ?? "SIGTERM";
    const outcome = await this.terminateGroup(record, signal);
    const state: ProcessState = outcome.confirmed
      ? outcome.alreadyExited && record.terminate === undefined
        ? "exited"
        : "terminated"
      : "running";
    const result: ProcessTerminateResult = {
      resourceId: record.resourceId,
      confirmed: outcome.confirmed,
      descendantsStopped: outcome.descendantsStopped,
      signal,
      state,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    };
    return { operationId: request.operationId, status: "completed", result };
  }

  // -- Shared process plumbing -------------------------------------------------------

  /** Signal one record's process group and measure what stopped. */
  private async terminateGroup(
    record: ProcessRecord,
    signal: string,
  ): Promise<{ confirmed: boolean; descendantsStopped: boolean; alreadyExited: boolean }> {
    const alreadyExited = !leaderAlive(record);
    // Group liveness decides, not leader liveness: descendants that
    // outlived an exited leader hold the group, and they receive the
    // same grace and escalation a live leader's group receives.
    if (groupAlive(record.pid) && maySignalGroup(record)) {
      killGroup(record.pid, signal as NodeJS.Signals);
      if (!(await waitUntilGroupDead(record.pid, TERMINATE_WAIT_MS))) {
        killGroup(record.pid, "SIGKILL");
        await waitUntilGroupDead(record.pid, TERMINATE_WAIT_MS);
      }
    }
    const confirmed = !leaderAlive(record) && !groupAlive(record.pid);
    const descendantsStopped = !groupAlive(record.pid);
    const current = this.provider.processRecord(record.resourceId) ?? record;
    this.provider.saveProcessRecord({
      ...current,
      ...(current.exitedAt === undefined && confirmed
        ? { exitedAt: new Date().toISOString() }
        : {}),
      terminate: {
        confirmed,
        descendantsStopped,
        signal,
        at: new Date().toISOString(),
      },
    });
    return { confirmed, descendantsStopped, alreadyExited };
  }

  /** Spawn one launch as a detached process-group leader. */
  private spawn(
    input: ProcessLaunchInput,
    output: "pipe" | { stdoutPath: string; stderrPath: string },
  ): ChildProcess {
    const cwd = resolveProcessCwd(input.cwd, {
      copyRoot: this.provider.copyRoot,
      hostAccess: input.hostAccess === true,
    });
    if (output === "pipe") {
      return spawn(input.command, input.args ?? [], {
        cwd,
        env: mergeProcessEnvironment(this.provider.environmentBase, input.env),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    // Background captures append to durable files, so any process
    // that opens the supervisor directory can read the same streams.
    const stdoutFd = openSync(output.stdoutPath, "a");
    const stderrFd = openSync(output.stderrPath, "a");
    try {
      return spawn(input.command, input.args ?? [], {
        cwd,
        env: mergeProcessEnvironment(this.provider.environmentBase, input.env),
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
    } finally {
      // The child duplicated the descriptors at spawn.
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  }

  /** The capture cap a run asked for, capped by the adapter's own. */
  private effectiveCap(input: ProcessLaunchInput): number {
    const asked = input.outputLimits?.maxBytesPerStream;
    return asked === undefined
      ? this.provider.captureCap
      : Math.min(asked, this.provider.captureCap);
  }

  /** The observed state of one record, from durable truth only. */
  private stateOf(record: ProcessRecord): ProcessState {
    if (record.spawnError !== undefined) {
      return "exited";
    }
    if (record.exitedAt !== undefined || record.exitCode !== undefined) {
      return record.terminate?.confirmed === true ||
        record.signal !== undefined ||
        record.timedOut === true
        ? "terminated"
        : "exited";
    }
    if (leaderAlive(record)) {
      return "running";
    }
    // The leader is gone but no observer saw the exit; the outcome is
    // unknown, not guessed (SPEC.md section 9.2).
    return "unknown";
  }

  private requireRecord(resourceId: string): ProcessRecord {
    const record = this.provider.processRecord(resourceId);
    if (record === null || record.environmentId !== this.environmentId) {
      throw invalidRequestError(
        `Resource ${resourceId} is not known to this environment.`,
        { resourceId },
      );
    }
    return record;
  }

  private recordByOperation(operationId: string): ProcessRecord | null {
    for (const record of this.provider.processRecordsOf(this.environmentId)) {
      if (record.operationId === operationId) {
        return record;
      }
    }
    return null;
  }

  /** Refuse work after expiry or release (SPEC.md section 8). */
  private requireAuthority(): void {
    const expiresAt = this.provider.expiryOf(this.environmentId);
    if (this.released || this.provider.isReleased(this.environmentId)) {
      throw leaseExpiredError(`environment ${this.environmentId}`, expiresAt);
    }
    if (Date.parse(expiresAt) <= Date.now()) {
      throw leaseExpiredError(`environment ${this.environmentId}`, expiresAt);
    }
  }
}

// -- Capture and liveness helpers ----------------------------------------------------

/** One output stream under a byte cap. */
class Capture {
  private readonly chunks: Buffer[] = [];
  private held = 0;
  private total = 0;

  constructor(private readonly cap: number) {}

  absorb(chunk: Buffer): void {
    this.total += chunk.byteLength;
    if (this.held < this.cap) {
      const keep = chunk.subarray(0, this.cap - this.held);
      this.chunks.push(keep);
      this.held += keep.byteLength;
    }
  }

  finish(): ProcessStreamCapture {
    const buffer = Buffer.concat(this.chunks);
    const omitted = this.total - buffer.byteLength;
    return {
      ...(buffer.byteLength > 0 ? { dataBase64: buffer.toString("base64") } : {}),
      byteLength: buffer.byteLength,
      truncated: omitted > 0,
      ...(omitted > 0 ? { omittedBytes: omitted } : {}),
    };
  }
}

/**
 * Resolve one child's close, rejecting when it never spawned.
 *
 * A spawn failure (for example a missing executable) rejects with a
 * provider error instead of a fake exit code; a real exit resolves
 * with the code and signal the platform reported.
 */
function closeOf(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        providerUnavailableError(`The local process failed to start: ${error.message}`, {
          code: error.code ?? undefined,
        }),
      );
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

/** Watch one detached child and report its exit exactly once. */
function observeExit(
  child: ChildProcess,
  onDone: (
    outcome: { code: number | null; signal: string | null } | null,
    spawnError?: string,
  ) => void,
): void {
  child.once("error", (error: NodeJS.ErrnoException) => {
    onDone(null, error.code ?? error.message);
  });
  child.once("close", (code, signal) => onDone({ code, signal }));
}

/** Whether one pid is alive. */
function alive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A signal probe also answers for a zombie: dead, waiting for a
  // parent that may be another blocked process. A zombie holds no
  // resources and runs nothing, so it does not count as alive.
  return !isZombie(pid);
}

/**
 * The kernel start time of one pid, in `/proc` clock ticks, or null.
 *
 * Linux only: the value is the 22nd field of `/proc/<pid>/stat`.
 * Nowhere else does the adapter read it.
 */
function procStartTicks(pid: number): number | null {
  const fields = procStatFields(pid);
  if (fields === null) {
    return null;
  }
  const ticks = Number(fields[19]);
  return Number.isFinite(ticks) ? ticks : null;
}

/**
 * Whether one record's leader is verifiably alive.
 *
 * A signal probe alone cannot tell a recycled identifier from the
 * recorded leader. Where Linux exposed it at start time, the kernel
 * start time decides: a different start time means the number now
 * names a process this environment never owned.
 */
function leaderAlive(record: ProcessRecord): boolean {
  if (!alive(record.pid)) {
    return false;
  }
  if (record.leaderStartTicks === undefined) {
    // No recorded evidence; the probe alone decides. This is the
    // documented limit of records and platforms without it.
    return true;
  }
  return procStartTicks(record.pid) === record.leaderStartTicks;
}

/**
 * Whether one record still proves the group at its identifier is
 * ours to signal.
 *
 * Linux pins a process-group identifier while any member lives, so
 * when no process holds the identifier, a live group under it can
 * only be held by this record's own descendants. When a process
 * holds it, the recorded start time decides: a different start time
 * means the identifier was reused, and the group under it belongs
 * to a process this environment never owned. A record without
 * evidence trusts the signal probe alone — the platform's limit,
 * stated in the module doc.
 */
function maySignalGroup(record: ProcessRecord): boolean {
  if (record.leaderStartTicks === undefined) {
    return true;
  }
  const current = procStartTicks(record.pid);
  return current === null || current === record.leaderStartTicks;
}

/**
 * Whether one process is a zombie.
 *
 * Reads the kernel state on Linux; elsewhere the answer is no and the
 * signal probe alone decides.
 */
function isZombie(pid: number): boolean {
  const fields = procStatFields(pid);
  return fields !== null && fields[0] === "Z";
}

/** The `/proc` stat fields after the command name, or null. */
function procStatFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat.lastIndexOf(")");
    if (afterName === -1) {
      return null;
    }
    return stat.slice(afterName + 1).trim().split(/\s+/);
  } catch {
    return null;
  }
}

/**
 * Whether any member of one process group is alive.
 *
 * On Linux this scans the process table for non-zombie members of the
 * group, because a group signal probe also answers for zombies of
 * members whose parents live in other processes.
 */
function groupAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  if (process.platform === "linux") {
    let members = 0;
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^[0-9]+$/.test(entry)) {
          continue;
        }
        const fields = procStatFields(Number(entry));
        if (fields === null) {
          // The process ended between listing and reading.
          continue;
        }
        if (Number(fields[2]) === pid) {
          members += 1;
          if (fields[0] !== "Z" && fields[0] !== "X") {
            return true;
          }
        }
      }
    } catch {
      // The table read failed; fall through to the signal probe.
    }
    if (members > 0) {
      // Every member is a zombie or a corpse; the group runs nothing.
      return false;
    }
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal one whole process group. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Poll until one process group is gone, or the budget runs out. */
function waitUntilGroupDead(pid: number, totalMs: number): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (!groupAlive(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
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
