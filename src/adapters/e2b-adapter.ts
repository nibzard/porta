import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, posix } from "node:path";
import {
  CommandExitError,
  FileType,
  NotFoundError,
  Sandbox,
  TimeoutError,
} from "@e2b/sdk";
import type { SandboxInfo } from "@e2b/sdk";
import {
  cleanupPendingError,
  integrityFailureError,
  invalidRequestError,
  invalidRequestFromValidation,
  isPortableError,
  leaseExpiredError,
  policyDeniedError,
  providerUnavailableError,
  staleHandleError,
  unsupportedOperationError,
} from "../core/errors.js";
import type { PolicyAuthority } from "../core/policy.js";
import { ValidationError, assertValid } from "../schema/validate.js";
import {
  adapterInvocationSchema,
  authorizedAcquireRequestSchema,
} from "../schema/adapter.js";
import type {
  AdapterInvocation,
  AdapterOperation,
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
import type { Identifier } from "../schema/defs.js";
import type {
  EnforcementFacts,
  EnvironmentManifest,
  EnvironmentOffer,
} from "../schema/capability.js";
import type { ResourceRef } from "../schema/resource.js";
import { checkTargetSatisfies, manifestTarget } from "../core/matching.js";
import {
  PROCESS_CAPABILITY_ID,
  PROCESS_OPERATIONS,
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
  ProcessAttributeDeclarations,
  ProcessInspectInput,
  ProcessInspectResult,
  ProcessLaunchInput,
  ProcessRunResult,
  ProcessState,
  ProcessStreamCapture,
  ProcessTerminateInput,
  ProcessTerminateResult,
} from "../runtime/process-capability.js";
import {
  buildTreeFromDirectory,
  compareTreePaths,
  scanTreeFromDirectory,
  treeRootHash,
} from "../store/workspace-tree.js";
import type { ImportedTree, TreeEntry } from "../store/workspace-tree.js";
import type { BlobStore } from "../store/blob-store.js";
import { VERSION } from "../version.js";

/**
 * E2B remote Linux adapter (SPEC.md sections 8, 11.6, 14.1, and 22;
 * provider selection recorded in docs/providers/selection.md).
 *
 * The adapter owns one Firecracker microVM per acquisition — discovery,
 * acquisition, reconciliation, renewal, release — and, inside a held
 * lease, the `exec.process@1` operations and the working-copy transfers
 * of one remote Linux environment.
 *
 * Processes cross through the envd command transport, which takes one
 * shell-parsed string. The adapter quotes every argument itself, so an
 * argument array stays an argument array: no re-splitting, no
 * interpolation, no globbing. The declared profile is honest about what
 * the transport does not carry: `SIGKILL` only, no descendant
 * termination, UTF-8 text output, processes that die with the sandbox.
 *
 * Working copies live under one portable root inside the sandbox.
 * A push validates policy, hashes, and limits before any byte leaves;
 * a pull walks the remote tree and rebuilds it through the
 * content-addressed store, and the caller proposes the change — a pull
 * never overwrites a source it did not stage.
 *
 * Every acquisition follows the durable-identity protocol:
 *
 * 1. The intent record — acquisition identity, environment identity,
 *    provider metadata tags — is written to `stateDir` before any
 *    provider call.
 * 2. The sandbox is created with the acquisition identity in its
 *    provider metadata.
 * 3. The provider sandbox identifier is confirmed back into the record.
 *
 * A response lost at any step recovers by identity: a record with no
 * sandbox identifier re-attaches through a provider listing filtered by
 * the metadata tag. A release the provider does not confirm stays in the
 * record as a cleanup obligation and keeps showing as held.
 *
 * The API key is resolved at use time from the options or
 * `E2B_API_KEY`. It never enters a record, a manifest, or a log line.
 */

/** Provider identity of this adapter. */
export const E2B_LINUX_PROVIDER_ID = "e2b-linux";

/** Metadata tag carrying the durable acquisition identity. */
const METADATA_ACQUISITION = "portable.acquisitionId";

/** Metadata tag carrying the environment identity. */
const METADATA_ENVIRONMENT = "portable.environmentId";

/** Default E2B sandbox template. */
const DEFAULT_TEMPLATE = "base";

/** Default provider timeout of one sandbox at creation: fifteen minutes. */
const DEFAULT_SANDBOX_TIMEOUT_MS = 15 * 60_000;

/** Default lease lifetime of one acquisition. */
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/**
 * Typed enforcement facts of this provider (SPEC.md 7).
 *
 * Sandboxes run remotely in Firecracker microVMs without host
 * filesystem access. Until sandbox creation carries the network
 * option through (R3), every sandbox this adapter creates has
 * internet access, so the honest fact is `unrestricted` and a policy
 * that restricts egress refuses acquisition here.
 */
const ENFORCEMENT_FACTS: EnforcementFacts = {
  executionLocation: "remote",
  networkEgress: "unrestricted",
  hostFilesystemAccess: false,
};

/** Provider hard cap of one timeout: twenty-four hours. */
const PROVIDER_MAX_TIMEOUT_MS = 86_400_000;

/** Default renewal cap: the Hobby-tier cap of one hour. */
const DEFAULT_MAX_TIMEOUT_MS = 3_600_000;

/**
 * The portable root of every working copy inside a sandbox. All pushes
 * write under it and all pulls walk it, so the boundary of transferred
 * content is one directory.
 */
const REMOTE_COPY_ROOT = "/home/user/portable";

/**
 * Default timeout of one foreground run. The provider default of sixty
 * seconds would kill honest work silently, so the adapter states one
 * hour and every request may tighten it.
 */
const DEFAULT_RUN_TIMEOUT_MS = 3_600_000;

/** Default bytes one output stream may hold inline: 256 KiB. */
const DEFAULT_CAPTURE_BYTES = 256 * 1024;

/**
 * The process profile this transport honestly supports (SPEC.md 14.1).
 * Each value states what the provider call can do, never more: kill
 * sends SIGKILL, it reaches no descendants, output crosses as UTF-8
 * text, and processes end with the sandbox.
 */
const PROCESS_ATTRIBUTES: ProcessAttributeDeclarations = {
  signals: ["SIGKILL"],
  descendantTermination: "none",
  binaryOutput: false,
  processLifetime: "attachment",
};

/** One sandbox as the adapter sees it. Dates are UTC strings. */
export interface E2BSandboxInfo {
  sandboxId: string;
  templateId: string;
  state: "running" | "paused";
  cpuCount: number;
  memoryMB: number;
  envdVersion: string;
  startedAt: string;
  endAt: string;
}

/**
 * The provider calls this adapter makes. The production client wraps
 * the E2B SDK; tests inject a fake. `getInfo` answers `null` when the
 * provider holds no sandbox under the identifier.
 */
export interface E2BClient {
  create(input: {
    template: string;
    timeoutMs: number;
    metadata: Record<string, string>;
    apiKey: string;
  }): Promise<{ sandboxId: string }>;
  getInfo(sandboxId: string, apiKey: string): Promise<E2BSandboxInfo | null>;
  listByMetadata(
    metadata: Record<string, string>,
    apiKey: string,
  ): Promise<E2BSandboxInfo[]>;
  setTimeout(
    sandboxId: string,
    timeoutMs: number,
    apiKey: string,
  ): Promise<void>;
  kill(sandboxId: string, apiKey: string): Promise<boolean>;
  connect(sandboxId: string, apiKey: string): Promise<E2BSandboxSession>;
}

/** One foreground command crossing the transport. */
export interface E2BSessionCommand {
  /** Shell-quoted argv string; the adapter builds it, never the caller. */
  command: string;
  cwd: string;
  envs: Record<string, string>;
  timeoutMs: number;
  /** Standard input text; the transport carries UTF-8 text only. */
  stdin?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** One background command start. */
export interface E2BStartCommand {
  command: string;
  cwd: string;
  envs: Record<string, string>;
  timeoutMs: number;
}

/** Outcome of one foreground command: an exit code, or a kill. */
export interface E2BCommandOutcome {
  /** Provider exit code; `null` when a signal or timeout ended it. */
  exitCode: number | null;
  timedOut: boolean;
}

/** One directory entry as the adapter models it. */
export interface E2BListedEntry {
  name: string;
  type: "file" | "directory";
}

/**
 * The per-sandbox surface the adapter uses once connected: commands,
 * running-process listing, and file exchange under the portable root.
 */
export interface E2BSandboxSession {
  /** Run to completion and return the outcome; a non-zero exit is data. */
  runCommand(input: E2BSessionCommand): Promise<E2BCommandOutcome>;
  /** Start detached and return the provider process identity. */
  startCommand(input: E2BStartCommand): Promise<{ pid: number }>;
  killCommand(pid: number): Promise<boolean>;
  runningCommandPids(): Promise<number[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** `null` when the directory does not exist. */
  listDir(path: string): Promise<E2BListedEntry[] | null>;
  makeDir(path: string): Promise<void>;
}

/** Production client over the E2B SDK statics. */
export class SdkE2BClient implements E2BClient {
  async create(input: {
    template: string;
    timeoutMs: number;
    metadata: Record<string, string>;
    apiKey: string;
  }): Promise<{ sandboxId: string }> {
    const sandbox = await Sandbox.create(input.template, {
      timeoutMs: input.timeoutMs,
      metadata: input.metadata,
      apiKey: input.apiKey,
    });
    return { sandboxId: sandbox.sandboxId };
  }

  async getInfo(sandboxId: string, apiKey: string): Promise<E2BSandboxInfo | null> {
    try {
      return toSandboxInfo(await Sandbox.getInfo(sandboxId, { apiKey }));
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async listByMetadata(
    metadata: Record<string, string>,
    apiKey: string,
  ): Promise<E2BSandboxInfo[]> {
    const paginator = Sandbox.list({ query: { metadata }, apiKey });
    const found: E2BSandboxInfo[] = [];
    while (paginator.hasNext) {
      found.push(...(await paginator.nextItems()).map(toSandboxInfo));
    }
    return found;
  }

  async setTimeout(
    sandboxId: string,
    timeoutMs: number,
    apiKey: string,
  ): Promise<void> {
    await Sandbox.setTimeout(sandboxId, timeoutMs, { apiKey });
  }

  async kill(sandboxId: string, apiKey: string): Promise<boolean> {
    return Sandbox.kill(sandboxId, { apiKey });
  }

  async connect(sandboxId: string, apiKey: string): Promise<E2BSandboxSession> {
    // Connect auto-resumes a paused sandbox, so a held allocation stays
    // usable without a separate resume operation.
    const sandbox = await Sandbox.connect(sandboxId, { apiKey });
    return new SdkE2BSession(sandbox);
  }
}

/** Production session over one connected sandbox. */
class SdkE2BSession implements E2BSandboxSession {
  constructor(private readonly sandbox: Sandbox) {}

  async runCommand(input: E2BSessionCommand): Promise<E2BCommandOutcome> {
    const opts = {
      cwd: input.cwd,
      envs: input.envs,
      timeoutMs: input.timeoutMs,
      ...(input.onStdout !== undefined ? { onStdout: input.onStdout } : {}),
      ...(input.onStderr !== undefined ? { onStderr: input.onStderr } : {}),
    };
    if (input.stdin === undefined) {
      try {
        const result = await this.sandbox.commands.run(input.command, opts);
        return { exitCode: result.exitCode, timedOut: false };
      } catch (error) {
        return commandOutcome(error);
      }
    }
    // Standard input needs the background handle: the transport keeps
    // the pipe open for sendStdin and wait() still returns the outcome.
    const handle = await this.sandbox.commands.run(input.command, {
      ...opts,
      background: true,
      stdin: true,
    });
    await this.sandbox.commands.sendStdin(handle.pid, input.stdin);
    try {
      const result = await handle.wait();
      return { exitCode: result.exitCode, timedOut: false };
    } catch (error) {
      return commandOutcome(error);
    }
  }

  async startCommand(input: E2BStartCommand): Promise<{ pid: number }> {
    const handle = await this.sandbox.commands.run(input.command, {
      cwd: input.cwd,
      envs: input.envs,
      timeoutMs: input.timeoutMs,
      background: true,
    });
    return { pid: handle.pid };
  }

  async killCommand(pid: number): Promise<boolean> {
    return this.sandbox.commands.kill(pid);
  }

  async runningCommandPids(): Promise<number[]> {
    const processes = await this.sandbox.commands.list();
    return processes.map((process) => process.pid);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.sandbox.files.read(path, { format: "bytes" });
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    // A private buffer slice, because the write API takes an ArrayBuffer.
    const copy = bytes.slice();
    await this.sandbox.files.write(path, copy.buffer as ArrayBuffer);
  }

  async listDir(path: string): Promise<E2BListedEntry[] | null> {
    try {
      const entries = await this.sandbox.files.list(path);
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.type === FileType.FILE ? ("file" as const) : ("directory" as const),
      }));
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async makeDir(path: string): Promise<void> {
    await this.sandbox.files.makeDir(path);
  }
}

/**
 * Map one thrown command fault to an honest outcome, or rethrow it. A
 * timeout and a negative exit code both mean the transport killed the
 * command, so both report a kill instead of a code.
 */
function commandOutcome(error: unknown): E2BCommandOutcome {
  if (error instanceof TimeoutError) {
    return { exitCode: null, timedOut: true };
  }
  if (error instanceof CommandExitError) {
    if (error.exitCode < 0) {
      return { exitCode: null, timedOut: true };
    }
    return { exitCode: error.exitCode, timedOut: false };
  }
  throw error;
}

function toSandboxInfo(info: SandboxInfo): E2BSandboxInfo {
  return {
    sandboxId: info.sandboxId,
    templateId: info.templateId,
    state: info.state,
    cpuCount: info.cpuCount,
    memoryMB: info.memoryMB,
    envdVersion: info.envdVersion,
    startedAt: info.startedAt.toISOString(),
    endAt: info.endAt.toISOString(),
  };
}

/** Durable record of one acquisition. One JSON file per identity. */
export interface E2BAcquisitionRecord {
  acquisitionId: string;
  environmentId: string;
  /** Provider sandbox identifier; `null` until the create response lands. */
  sandboxId: string | null;
  template: string;
  createdAt: string;
  expiresAt: string;
  /** Resources read from the provider after the sandbox existed. */
  resources?: { cpuCount: number; memoryBytes: number; envdVersion: string };
  releasedAt?: string;
  /** Whether the provider confirmed the sandbox is gone. */
  releaseConfirmed?: boolean;
  /** Why an unconfirmed release stayed open. */
  releaseDetail?: string;
  /** Provenance of the last working-copy push into the sandbox. */
  lastPush?: {
    rootHash: string;
    filesSent: number;
    bytesSent: number;
    at: string;
  };
}

/** Durable record of one started background process. One JSON file each. */
export interface E2BProcessRecord {
  resourceId: string;
  operationId: string;
  environmentId: string;
  sandboxId: string;
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  /** Written by a later observation, when one lands. */
  exitedAt?: string;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  /** Last termination attempt against this process. */
  terminate?: { confirmed: boolean; signal: string; at: string };
}

/** Authorized ceilings of one working-copy transfer. */
export interface E2BTransferLimits {
  maxFileCount?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/** Input of one push: stage one copy's bytes under the portable root. */
export interface E2BPushCopyInput {
  environmentId: string;
  /** Local directory holding the authorized copy to send. */
  copyRoot: string;
  /** The tree the copy claims to be; the bytes must hash to it. */
  entries: readonly TreeEntry[];
  /** Policy authority deciding whether bytes may reach the sandbox. */
  authority: PolicyAuthority;
  limits?: E2BTransferLimits;
}

/** Report of one completed push. */
export interface E2BPushReport {
  environmentId: string;
  remoteRoot: string;
  filesSent: number;
  bytesSent: number;
  /** Root hash of the tree that crossed, as re-hashed from the bytes. */
  rootHash: string;
}

/** Input of one pull: harvest the remote tree into one local staging root. */
export interface E2BPullCopyInput {
  environmentId: string;
  /** Local directory that receives the remote state; it is replaced. */
  destRoot: string;
  /** Store that receives the content-addressed blobs of the harvest. */
  blobs: BlobStore;
  authority: PolicyAuthority;
  /** Refuse instead of returning a tree that hashes differently. */
  expectedRootHash?: string;
  limits?: E2BTransferLimits;
}

/** Options of one E2B Linux adapter. */
export interface E2BLinuxAdapterOptions {
  /** Directory holding the durable acquisition records. */
  stateDir: string;
  /** Client override; tests inject a fake here. */
  client?: E2BClient;
  /** API key. Resolved at use time; defaults to `E2B_API_KEY`. */
  apiKey?: string;
  /** E2B template to launch. Defaults to `base`. */
  template?: string;
  /** Provider timeout set at creation, in milliseconds. */
  sandboxTimeoutMs?: number;
  /** Lease lifetime of one acquisition, in milliseconds. */
  leaseTtlMs?: number;
  /**
   * Renewal cap in milliseconds. Defaults to the Hobby-tier cap of one
   * hour; raise it to the provider cap of twenty-four hours on Pro.
   */
  maxTimeoutMs?: number;
  /** Whether sandboxes may reach the internet. Defaults to `true`. */
  allowInternetAccess?: boolean;
}

export class E2BLinuxAdapter implements EnvironmentAdapter {
  readonly id = E2B_LINUX_PROVIDER_ID;
  private readonly client: E2BClient;
  private readonly apiKeyOption: string | undefined;
  private readonly template: string;
  private readonly sandboxTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxTimeoutMs: number;
  private readonly allowInternetAccess: boolean;
  private readonly acquisitionsDir: string;
  private readonly processesDir: string;
  /** Operation outcomes answered by this process, by operation identity. */
  private readonly operations = new Map<Identifier, AdapterOperation>();

  constructor(options: E2BLinuxAdapterOptions) {
    this.client = options.client ?? new SdkE2BClient();
    this.apiKeyOption = options.apiKey;
    this.template = options.template ?? DEFAULT_TEMPLATE;
    this.sandboxTimeoutMs = options.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.maxTimeoutMs = Math.min(
      options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
      PROVIDER_MAX_TIMEOUT_MS,
    );
    this.allowInternetAccess = options.allowInternetAccess ?? true;
    this.acquisitionsDir = join(options.stateDir, "acquisitions");
    mkdirSync(this.acquisitionsDir, { recursive: true });
    this.processesDir = join(options.stateDir, "processes");
    mkdirSync(this.processesDir, { recursive: true });
  }

  // -- EnvironmentAdapter ------------------------------------------------------

  /**
   * Discovery offers the process contract with the attributes this
   * transport honestly provides (SPEC.md section 14.1). Every declared
   * value mirrors a provider limit, never an aspiration.
   */
  async describe(): Promise<EnvironmentOffer[]> {
    return [this.offer()];
  }

  /** The published offer of this provider. */
  offer(): EnvironmentOffer {
    return {
      providerId: E2B_LINUX_PROVIDER_ID,
      adapterId: E2B_LINUX_PROVIDER_ID,
      platform: { os: "linux", arch: "x86_64" },
      capabilities: [
        { id: PROCESS_CAPABILITY_ID, attributes: processCapabilityDescriptor(PROCESS_ATTRIBUTES).attributes },
      ],
      enforcement: {
        isolation: "firecracker-microvm",
        networkEgress: this.allowInternetAccess ? "internet-allowed" : "blocked",
        releaseSemantics: "kill-discards-state",
      },
      enforcementFacts: { ...ENFORCEMENT_FACTS },
    };
  }

  async acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease> {
    checkValid(() => assertValid(authorizedAcquireRequestSchema, request));
    const apiKey = this.apiKey();
    const existing = this.readRecord(request.acquisitionId);
    if (existing !== null) {
      // One acquisition identity owns at most one environment; a
      // repeated acquire returns the same lease (SPEC.md section 5.2).
      if (existing.sandboxId !== null) {
        const info = await this.guarded(() =>
          this.client.getInfo(existing.sandboxId!, apiKey),
        );
        if (info === null) {
          // The provider no longer holds the sandbox behind this
          // identity. The acquisition is over, not repeatable.
          throw staleHandleError(
            { kind: "acquisition", value: "allocated" },
            { kind: "acquisition", value: "ended-by-provider" },
          );
        }
        this.captureResources(existing.acquisitionId, info);
        return this.lease(existing.environmentId);
      }
      // The create response never landed. Recover by durable identity.
      const recovered = await this.guarded(() =>
        this.recoverUnconfirmed(existing, apiKey),
      );
      if (recovered === null) {
        // No sandbox carries this identity: the create never started,
        // or its sandbox already ended. Creating under the same
        // identity cannot duplicate a live sandbox.
        await this.guarded(() => this.createSandbox(existing, apiKey));
      }
      return this.lease(existing.environmentId);
    }
    // Requirements this provider cannot satisfy are rejected here,
    // before any spend exists (SPEC.md section 7). Resources cannot be
    // proven before the sandbox exists, so resource minima reject
    // unless the template's quantities are known truth.
    const environmentId = `env-e2b-${randomUUID()}`;
    const now = new Date().toISOString();
    const unsatisfied = checkTargetSatisfies(
      request.request,
      manifestTarget(this.buildManifest(environmentId, null)),
    );
    if (unsatisfied !== null) {
      throw unsatisfied;
    }
    const ttlMs = this.admissibleLeaseMs(request.limits);
    // The intent record exists before any provider call: a crash past
    // this point recovers by identity (SPEC.md section 8).
    const record: E2BAcquisitionRecord = {
      acquisitionId: request.acquisitionId,
      environmentId,
      sandboxId: null,
      template: this.template,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    this.writeRecord(record);
    await this.guarded(() => this.createSandbox(record, apiKey));
    return this.lease(environmentId);
  }

  async reconcile(acquisitionId: string): Promise<AcquisitionStatus> {
    let record = this.readRecord(acquisitionId);
    if (record === null) {
      return { acquisitionId, state: "unknown" };
    }
    const apiKey = this.apiKey();
    if (record.sandboxId === null) {
      try {
        const recovered = await this.recoverUnconfirmed(record, apiKey);
        if (recovered === null) {
          // The intent exists; no sandbox answers for it. Whether the
          // create never started or its sandbox already ended cannot be
          // told apart, so the honest answer stays unknown.
          return { acquisitionId, state: "unknown" };
        }
        record = recovered;
      } catch (error) {
        return { acquisitionId, state: "unknown", error: providerError(error) };
      }
    }
    let info: E2BSandboxInfo | null;
    try {
      info = await this.client.getInfo(record.sandboxId!, apiKey);
    } catch (error) {
      // Uncertainty is never release. The allocation stays visible as
      // unknown until the provider answers (SPEC.md section 8).
      return { acquisitionId, state: "unknown", error: providerError(error) };
    }
    if (info === null) {
      // The provider confirms the sandbox is gone. That confirmation
      // ends the allocation, whichever side ended it.
      if (record.releasedAt === undefined || record.releaseConfirmed !== true) {
        this.writeRecord({
          ...record,
          releasedAt: record.releasedAt ?? new Date().toISOString(),
          releaseConfirmed: true,
          ...(record.releaseDetail !== undefined
            ? { releaseDetail: record.releaseDetail }
            : {}),
        });
      }
      return {
        acquisitionId,
        state: "released",
        environmentId: record.environmentId,
        expiresAt: record.expiresAt,
      };
    }
    this.captureResources(record.acquisitionId, info);
    if (record.releasedAt !== undefined) {
      // A release is recorded but the provider still holds the sandbox:
      // the resources stand, and the release stays a cleanup obligation.
      return {
        acquisitionId,
        state: "allocated",
        environmentId: record.environmentId,
        manifest: this.buildManifest(record.environmentId, record),
        expiresAt: record.expiresAt,
        error: cleanupPendingError(
          record.sandboxId!,
          `Release of sandbox ${record.sandboxId} is not confirmed; the provider still holds it.`,
        ),
      };
    }
    // Running or paused: both hold the allocation.
    return {
      acquisitionId,
      state: "allocated",
      environmentId: record.environmentId,
      manifest: this.buildManifest(record.environmentId, record),
      expiresAt: record.expiresAt,
    };
  }

  // -- Supervisor surface --------------------------------------------------------

  /** The lease of one allocated environment. */
  lease(environmentId: string): E2BLinuxLease {
    this.recordOfEnvironment(environmentId);
    return new E2BLinuxLease(this, environmentId);
  }

  /** The record of one environment, by its environment identity. */
  recordOfEnvironment(environmentId: string): E2BAcquisitionRecord {
    for (const record of this.allocations()) {
      if (record.environmentId === environmentId) {
        return record;
      }
    }
    throw invalidRequestError(
      `Environment ${environmentId} is not allocated by this adapter.`,
      { environmentId },
    );
  }

  /**
   * Every acquisition record, oldest first — including unconfirmed
   * releases and unconfirmed creates. Leaked or uncertain allocations
   * stay visible here and through `reconcile` (SPEC.md section 8).
   */
  allocations(): E2BAcquisitionRecord[] {
    const records: E2BAcquisitionRecord[] = [];
    for (const name of readdirSync(this.acquisitionsDir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const record = this.readRecord(name.slice(0, -".json".length));
      if (record !== null) {
        records.push(record);
      }
    }
    records.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return records;
  }

  /** The manifest of one environment, from its record. */
  manifestOf(environmentId: string): EnvironmentManifest {
    const record = this.recordOfEnvironment(environmentId);
    return this.buildManifest(environmentId, record);
  }

  /**
   * The lease span the effective limits admit, or a refusal.
   *
   * Sandboxes run remotely. Until creation carries the network option
   * through (R3), this adapter cannot enforce a restricted egress
   * policy, so anything below `unrestricted` refuses before any
   * spend exists. The lease span is constrained to the lifetime
   * ceiling.
   */
  private admissibleLeaseMs(limits: AuthorizedAcquireRequest["limits"]): number {
    if (!limits.executionLocations.includes("remote")) {
      throw policyDeniedError(
        "The E2B provider executes remotely; the policy allows no remote execution.",
        { dimension: "locations", allowed: limits.executionLocations },
      );
    }
    if (limits.networkEgress !== "unrestricted") {
      throw policyDeniedError(
        "The E2B adapter cannot yet enforce restricted network egress at creation; " +
          "restricted policies refuse instead of being accepted and ignored.",
        { dimension: "networkEgress", allowed: limits.networkEgress },
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

  /** Extend one environment's lease to an absolute time. */
  async renewEnvironment(environmentId: string, expiresAt: string): Promise<LeaseStatus> {
    const record = this.recordOfEnvironment(environmentId);
    if (record.releasedAt !== undefined) {
      throw leaseExpiredError(`environment ${environmentId}`, record.releasedAt);
    }
    const desired = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(desired) || desired <= 0) {
      throw invalidRequestError(
        `The renewal time for environment ${environmentId} is not in the future.`,
        { environmentId, expiresAt },
      );
    }
    if (record.sandboxId === null) {
      throw staleHandleError(
        { kind: "sandbox", value: "confirmed" },
        { kind: "sandbox", value: "unconfirmed" },
      );
    }
    // The provider caps one timeout; the effective answer reports the
    // cap, never a pretend extension (SPEC.md section 8).
    const capped = Math.min(desired, this.maxTimeoutMs);
    await this.guarded(() => this.client.setTimeout(record.sandboxId!, capped, this.apiKey()));
    const effective = new Date(Date.now() + capped).toISOString();
    this.writeRecord({ ...this.recordOfEnvironment(environmentId), expiresAt: effective });
    return { status: "active", expiresAt: effective, renewalSupported: true };
  }

  /** Release one environment. Idempotent; failures stay obligations. */
  async releaseEnvironment(environmentId: string): Promise<ReleaseResult> {
    let record = this.recordOfEnvironment(environmentId);
    if (record.releasedAt !== undefined && record.releaseConfirmed === true) {
      return { status: "released", retryable: false };
    }
    const apiKey = this.apiKey();
    if (record.sandboxId === null) {
      const recovered = await this.guarded(() => this.recoverUnconfirmed(record, apiKey));
      if (recovered === null) {
        // No sandbox ever answered for this identity; nothing to free.
        this.writeRecord({
          ...record,
          releasedAt: record.releasedAt ?? new Date().toISOString(),
          releaseConfirmed: true,
        });
        return {
          status: "released",
          retryable: false,
          detail: "No sandbox was ever confirmed behind this acquisition.",
        };
      }
      record = recovered;
    }
    try {
      // `true` killed it; `false` names a sandbox already gone. Both
      // confirm the provider no longer holds resources.
      await this.client.kill(record.sandboxId!, apiKey);
      this.writeRecord({
        ...record,
        releasedAt: record.releasedAt ?? new Date().toISOString(),
        releaseConfirmed: true,
      });
      return { status: "released", retryable: false };
    } catch (error) {
      // The kill is unconfirmed. The record keeps the obligation so a
      // later process still sees it (SPEC.md section 8).
      const detail = providerError(error).message;
      this.writeRecord({
        ...record,
        releasedAt: record.releasedAt ?? new Date().toISOString(),
        releaseConfirmed: false,
        releaseDetail: detail,
      });
      return { status: "failed", retryable: true, detail };
    }
  }

  /** Refuse invocations after release or expiry (SPEC.md section 8). */
  requireLive(environmentId: string): void {
    const record = this.recordOfEnvironment(environmentId);
    if (record.releasedAt !== undefined) {
      throw leaseExpiredError(`environment ${environmentId}`, record.releasedAt);
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw leaseExpiredError(`environment ${environmentId}`, record.expiresAt);
    }
  }

  /** Route one invocation from a lease (SPEC.md section 14.1). */
  async invokeOnLease(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<AdapterOperation> {
    checkValid(() => assertValid(adapterInvocationSchema, request));
    this.requireLive(environmentId);
    if (request.capability !== PROCESS_CAPABILITY_ID) {
      throw unsupportedOperationError(request.capability, request.operation, {
        reason: "The e2b-linux adapter offers exec.process@1 operations only.",
      });
    }
    const outcome = await this.dispatchProcess(environmentId, request);
    this.operations.set(request.operationId, outcome);
    return outcome;
  }

  /** The status of one operation this environment answered. */
  operationStatus(operationId: string): AdapterOperation | null {
    const remembered = this.operations.get(operationId);
    if (remembered !== undefined) {
      return remembered;
    }
    // A started process is durable: a record exists only after the
    // start succeeded, so a restarted adapter still answers the
    // operation with its recorded outcome.
    for (const record of this.processRecords()) {
      if (record.operationId === operationId) {
        return {
          operationId,
          status: "completed",
          result: {
            resourceId: record.resourceId,
            providerProcessId: String(record.pid),
            startedAt: record.startedAt,
          },
        };
      }
    }
    return null;
  }

  /** Try to stop what one operation started. Explicit about the reach. */
  async cancelOperation(
    environmentId: string,
    operationId: string,
  ): Promise<CancellationResult> {
    const record = this.processRecords().find(
      (candidate) =>
        candidate.operationId === operationId &&
        candidate.environmentId === environmentId,
    );
    if (record === undefined) {
      return {
        outcome: "unsupported",
        stopped: false,
        detail: `Operation ${operationId} started no process on this environment.`,
      };
    }
    if (record.terminate?.confirmed === true) {
      return { outcome: "confirmed", stopped: true, descendantsStopped: false };
    }
    try {
      const { session } = await this.sessionOf(environmentId);
      const listed = await this.guarded(() => session.runningCommandPids());
      if (!listed.includes(record.pid)) {
        return {
          outcome: "confirmed",
          stopped: false,
          descendantsStopped: false,
          detail: "The process already ended.",
        };
      }
      await this.guarded(() => session.killCommand(record.pid));
      const after = await this.guarded(() => session.runningCommandPids());
      const stopped = !after.includes(record.pid);
      this.writeProcessRecord({
        ...record,
        terminate: { confirmed: stopped, signal: "SIGKILL", at: new Date().toISOString() },
      });
      return {
        outcome: stopped ? "confirmed" : "best-effort",
        stopped,
        // SIGKILL reaches one process; the transport offers no group.
        descendantsStopped: false,
      };
    } catch (error) {
      return {
        outcome: "best-effort",
        stopped: false,
        descendantsStopped: false,
        detail: providerError(error).message,
      };
    }
  }

  // -- Process operations --------------------------------------------------------

  private async dispatchProcess(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<AdapterOperation> {
    switch (request.operation) {
      case "run":
        return this.runProcess(
          request,
          environmentId,
          validateProcessRunInput(request.input),
        );
      case "start":
        return this.startProcess(
          request,
          environmentId,
          validateProcessStartInput(request.input),
        );
      case "inspect":
        return this.inspectProcess(
          request,
          environmentId,
          validateProcessInspectInput(request.input),
        );
      case "terminate":
        return this.terminateProcess(
          request,
          environmentId,
          validateProcessTerminateInput(request.input),
        );
      default:
        throw unsupportedOperationError(request.capability, request.operation, {
          reason: `exec.process@1 supports ${PROCESS_OPERATIONS.join(", ")} here.`,
        });
    }
  }

  /** Run one command to completion and return its outcome as data. */
  private async runProcess(
    request: AdapterInvocation,
    environmentId: string,
    input: ProcessLaunchInput,
  ): Promise<AdapterOperation> {
    const { session } = await this.sessionOf(environmentId);
    const startedAt = new Date().toISOString();
    const cwd = resolveProcessCwd(input.cwd, {
      copyRoot: REMOTE_COPY_ROOT,
      hostAccess: input.hostAccess === true,
    });
    const command = shellCommandOf(input.command, input.args ?? []);
    const stdin = stdinTextOf(input);
    const perStream = input.outputLimits?.maxBytesPerStream ?? DEFAULT_CAPTURE_BYTES;
    const shared =
      input.outputLimits?.maxTotalBytes !== undefined
        ? { remaining: input.outputLimits.maxTotalBytes }
        : undefined;
    const stdout = new StreamCapture(perStream, shared);
    const stderr = new StreamCapture(perStream, shared);
    await this.guarded(() => session.makeDir(REMOTE_COPY_ROOT));
    const outcome = await this.guarded(() =>
      session.runCommand({
        command,
        cwd,
        envs: mergeProcessEnvironment({}, input.env),
        // The provider default of sixty seconds would kill honest work
        // silently; the adapter states its own bound.
        timeoutMs: input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        ...(stdin !== undefined ? { stdin } : {}),
        onStdout: (chunk) => stdout.absorb(chunk),
        onStderr: (chunk) => stderr.absorb(chunk),
      }),
    );
    const result: ProcessRunResult = {
      ...(outcome.timedOut
        ? { signal: "SIGKILL" }
        : { exitCode: outcome.exitCode ?? 0 }),
      timedOut: outcome.timedOut,
      stdout: stdout.finish(),
      stderr: stderr.finish(),
      startedAt,
      endedAt: new Date().toISOString(),
    };
    return { operationId: request.operationId, status: "completed", result };
  }

  /** Start one detached process and record it as a durable resource. */
  private async startProcess(
    request: AdapterInvocation,
    environmentId: string,
    input: ProcessLaunchInput,
  ): Promise<AdapterOperation> {
    const { record, session } = await this.sessionOf(environmentId);
    const startedAt = new Date().toISOString();
    const cwd = resolveProcessCwd(input.cwd, {
      copyRoot: REMOTE_COPY_ROOT,
      hostAccess: input.hostAccess === true,
    });
    const command = shellCommandOf(input.command, input.args ?? []);
    // A background command outlives the request. Its provider timeout is
    // bounded by the lease, and the process dies with the sandbox either
    // way — the declared lifetime is attachment.
    const leaseRemaining = Math.max(
      Date.parse(record.expiresAt) - Date.now(),
      60_000,
    );
    const started = await this.guarded(() =>
      session.startCommand({
        command,
        cwd,
        envs: mergeProcessEnvironment({}, input.env),
        timeoutMs: Math.min(leaseRemaining, PROVIDER_MAX_TIMEOUT_MS),
      }),
    );
    const processRecord: E2BProcessRecord = {
      resourceId: `proc-${randomUUID()}`,
      operationId: request.operationId,
      environmentId,
      sandboxId: record.sandboxId!,
      pid: started.pid,
      command: input.command,
      args: input.args ?? [],
      cwd,
      startedAt,
    };
    this.writeProcessRecord(processRecord);
    return {
      operationId: request.operationId,
      status: "completed",
      // The portable ResourceRef is the runtime's to compose through
      // the binding flow; this result carries the provider identity.
      result: {
        resourceId: processRecord.resourceId,
        providerProcessId: String(started.pid),
        startedAt,
      },
    };
  }

  /** Observe one started process from provider liveness. */
  private async inspectProcess(
    request: AdapterInvocation,
    environmentId: string,
    input: ProcessInspectInput,
  ): Promise<AdapterOperation> {
    const record = this.requireProcessRecord(input.resourceId, environmentId);
    let state: ProcessState;
    try {
      const { session } = await this.sessionOf(environmentId);
      const running = (await this.guarded(() => session.runningCommandPids())).includes(
        record.pid,
      );
      state = running
        ? "running"
        : record.terminate?.confirmed === true ||
            record.signal !== undefined ||
            record.timedOut === true
          ? "terminated"
          : "exited";
    } catch {
      // The provider cannot answer; liveness is unknown, never guessed.
      state = "unknown";
    }
    const result: ProcessInspectResult = {
      resourceId: record.resourceId,
      state,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.signal !== undefined ? { signal: record.signal } : {}),
      ...(record.timedOut !== undefined ? { timedOut: record.timedOut } : {}),
      startedAt: record.startedAt,
      ...(record.exitedAt !== undefined ? { endedAt: record.exitedAt } : {}),
    };
    return { operationId: request.operationId, status: "completed", result };
  }

  /** Stop one started process with a declared signal, confirmed. */
  private async terminateProcess(
    request: AdapterInvocation,
    environmentId: string,
    input: ProcessTerminateInput,
  ): Promise<AdapterOperation> {
    const record = this.requireProcessRecord(input.resourceId, environmentId);
    const signal = input.signal ?? PROCESS_ATTRIBUTES.signals[0]!;
    if (!PROCESS_ATTRIBUTES.signals.includes(signal)) {
      throw invalidRequestError(
        `Signal ${signal} is not declared by this environment; it offers ` +
          `${PROCESS_ATTRIBUTES.signals.join(", ")} only.`,
        { resourceId: input.resourceId, signal, declared: PROCESS_ATTRIBUTES.signals },
      );
    }
    const { session } = await this.sessionOf(environmentId);
    const listed = await this.guarded(() => session.runningCommandPids());
    let confirmed: boolean;
    let state: ProcessState;
    if (!listed.includes(record.pid)) {
      // The provider already stopped listing it: not running is a fact.
      confirmed = true;
      state = record.terminate?.confirmed === true ? "terminated" : "exited";
    } else {
      await this.guarded(() => session.killCommand(record.pid));
      const after = await this.guarded(() => session.runningCommandPids());
      confirmed = !after.includes(record.pid);
      state = confirmed ? "terminated" : "running";
    }
    this.writeProcessRecord({
      ...record,
      terminate: { confirmed, signal, at: new Date().toISOString() },
    });
    const result: ProcessTerminateResult = {
      resourceId: record.resourceId,
      confirmed,
      // The transport kills one process; it reaches no descendants.
      descendantsStopped: false,
      signal,
      state,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    };
    return { operationId: request.operationId, status: "completed", result };
  }

  // -- Working-copy transfers ----------------------------------------------------

  /**
   * Push one authorized copy under the portable root. Policy, hashes,
   * and limits are all checked before the first byte leaves, so a
   * refused push spends nothing (SPEC.md section 11.6).
   */
  async pushCopy(input: E2BPushCopyInput): Promise<E2BPushReport> {
    const record = this.recordOfEnvironment(input.environmentId);
    this.requireLive(input.environmentId);
    const denied = input.authority.checkTransferDestination("remote");
    if (denied !== null) {
      throw denied;
    }
    if (record.sandboxId === null) {
      throw staleHandleError(
        { kind: "sandbox", value: "confirmed" },
        { kind: "sandbox", value: "unconfirmed" },
      );
    }
    const sandboxId = record.sandboxId;
    // The bytes on disk must hash to the tree they claim. A copy that
    // changed after authorization never crosses as trusted content.
    const scanned = scanTreeFromDirectory(input.copyRoot);
    const expectedRoot = treeRootHash(input.entries);
    if (expectedRoot !== scanned.rootHash) {
      throw integrityFailureError(
        "the staged working copy",
        expectedRoot,
        scanned.rootHash,
      );
    }
    const files = scanned.entries.filter((entry) => entry.kind === "file");
    checkTransferLimits(
      files.map((entry) => statSync(join(input.copyRoot, entry.path)).size),
      input.limits,
    );
    const session = await this.guarded(() =>
      this.client.connect(sandboxId, this.apiKey()),
    );
    await this.guarded(() => session.makeDir(REMOTE_COPY_ROOT));
    let bytesSent = 0;
    const ordered = [...scanned.entries].sort((a, b) =>
      compareTreePaths(a.path, b.path),
    );
    for (const entry of ordered.filter((candidate) => candidate.kind === "directory")) {
      await this.guarded(() =>
        session.makeDir(posix.join(REMOTE_COPY_ROOT, entry.path)),
      );
    }
    for (const entry of ordered.filter((candidate) => candidate.kind === "file")) {
      const bytes = readFileSync(join(input.copyRoot, entry.path));
      await this.guarded(() =>
        session.writeFile(posix.join(REMOTE_COPY_ROOT, entry.path), bytes),
      );
      bytesSent += bytes.byteLength;
    }
    const report: E2BPushReport = {
      environmentId: input.environmentId,
      remoteRoot: REMOTE_COPY_ROOT,
      filesSent: files.length,
      bytesSent,
      rootHash: scanned.rootHash,
    };
    this.writeRecord({
      ...this.recordOfEnvironment(input.environmentId),
      lastPush: {
        rootHash: report.rootHash,
        filesSent: report.filesSent,
        bytesSent: report.bytesSent,
        at: new Date().toISOString(),
      },
    });
    return report;
  }

  /**
   * Pull the remote tree back into one local staging root and hash it
   * through the content-addressed store. The tree is built from bytes
   * that crossed, never from provider claims; a stated expected hash
   * refuses a mismatch instead of returning it.
   */
  async pullCopy(input: E2BPullCopyInput): Promise<ImportedTree> {
    const record = this.recordOfEnvironment(input.environmentId);
    this.requireLive(input.environmentId);
    const denied = input.authority.checkTransferDestination("local");
    if (denied !== null) {
      throw denied;
    }
    const sandboxId = record.sandboxId;
    if (sandboxId === null) {
      throw staleHandleError(
        { kind: "sandbox", value: "confirmed" },
        { kind: "sandbox", value: "unconfirmed" },
      );
    }
    const session = await this.guarded(() =>
      this.client.connect(sandboxId, this.apiKey()),
    );
    const walked = await this.guarded(() => this.walkRemote(session));
    if (walked === null) {
      throw invalidRequestError(
        "The environment holds no working copy under the portable root; push one first.",
        { environmentId: input.environmentId, remoteRoot: REMOTE_COPY_ROOT },
      );
    }
    checkTransferLimits(
      walked.files.map((file) => file.bytes.byteLength),
      input.limits,
    );
    // Replace the staging root with the remote state. The caller
    // decides what becomes of the harvest; a pull never writes past the
    // staging root it was given.
    rmSync(input.destRoot, { recursive: true, force: true });
    mkdirSync(input.destRoot, { recursive: true });
    for (const directory of walked.directories.sort()) {
      mkdirSync(join(input.destRoot, directory), { recursive: true });
    }
    for (const file of walked.files) {
      mkdirSync(dirname(join(input.destRoot, file.path)), { recursive: true });
      writeFileSync(join(input.destRoot, file.path), file.bytes);
    }
    const tree = buildTreeFromDirectory(input.destRoot, input.blobs);
    if (input.expectedRootHash !== undefined && input.expectedRootHash !== tree.rootHash) {
      throw integrityFailureError(
        "the pulled working copy",
        input.expectedRootHash,
        tree.rootHash,
      );
    }
    return tree;
  }

  /**
   * Walk the portable root of one sandbox. Returns `null` when the root
   * does not exist. Names that are not plain path segments refuse the
   * walk: a provider entry can never escape the staging root.
   */
  private async walkRemote(
    session: E2BSandboxSession,
  ): Promise<{
    directories: string[];
    files: Array<{ path: string; bytes: Uint8Array }>;
  } | null> {
    const root = await session.listDir(REMOTE_COPY_ROOT);
    if (root === null) {
      return null;
    }
    const directories: string[] = [];
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    const walk = async (relative: string): Promise<void> => {
      const absolute =
        relative === "" ? REMOTE_COPY_ROOT : posix.join(REMOTE_COPY_ROOT, relative);
      const entries = await session.listDir(absolute);
      if (entries === null) {
        // Vanished between listing and reading; the walk stays honest
        // about what still exists.
        return;
      }
      for (const entry of entries) {
        if (!/^[^/\0]+$/.test(entry.name) || entry.name === "." || entry.name === "..") {
          throw providerUnavailableError(
            "The remote tree returned a name that is not a plain path segment.",
            { name: entry.name },
          );
        }
        const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.type === "directory") {
          directories.push(child);
          await walk(child);
        } else {
          const bytes = await session.readFile(posix.join(REMOTE_COPY_ROOT, child));
          files.push({ path: child, bytes });
        }
      }
    };
    await walk("");
    return { directories, files };
  }

  // -- Process records ------------------------------------------------------------

  /** The record of one process of one environment, or a refusal. */
  private requireProcessRecord(
    resourceId: string,
    environmentId: string,
  ): E2BProcessRecord {
    const record = this.readProcessRecord(resourceId);
    if (record === null || record.environmentId !== environmentId) {
      throw invalidRequestError(
        `Resource ${resourceId} is not known to this environment.`,
        { resourceId },
      );
    }
    return record;
  }

  /** Every process record, oldest first. */
  private processRecords(): E2BProcessRecord[] {
    const records: E2BProcessRecord[] = [];
    for (const name of readdirSync(this.processesDir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const record = this.readProcessRecord(name.slice(0, -".json".length));
      if (record !== null) {
        records.push(record);
      }
    }
    records.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    return records;
  }

  private readProcessRecord(resourceId: string): E2BProcessRecord | null {
    const path = join(this.processesDir, `${resourceId}.json`);
    if (!existsSync(path)) {
      return null;
    }
    return JSON.parse(readFileSync(path, "utf8")) as E2BProcessRecord;
  }

  private writeProcessRecord(record: E2BProcessRecord): void {
    const path = join(this.processesDir, `${record.resourceId}.json`);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(record, undefined, 2));
    renameSync(temp, path);
  }

  /** Connect to the sandbox behind one environment. */
  private async sessionOf(
    environmentId: string,
  ): Promise<{ record: E2BAcquisitionRecord; session: E2BSandboxSession }> {
    const record = this.recordOfEnvironment(environmentId);
    const sandboxId = record.sandboxId;
    if (sandboxId === null) {
      throw staleHandleError(
        { kind: "sandbox", value: "confirmed" },
        { kind: "sandbox", value: "unconfirmed" },
      );
    }
    const session = await this.guarded(() => this.client.connect(sandboxId, this.apiKey()));
    return { record, session };
  }

  // -- Record and provider plumbing -----------------------------------------------

  /** The metadata tags carrying one record's durable identity. */
  private metadataOf(record: E2BAcquisitionRecord): Record<string, string> {
    return {
      [METADATA_ACQUISITION]: record.acquisitionId,
      [METADATA_ENVIRONMENT]: record.environmentId,
    };
  }

  /**
   * Create the sandbox of one intent record and confirm its identifier
   * back. A crash before the write leaves the record recoverable
   * through the metadata listing.
   */
  private async createSandbox(
    record: E2BAcquisitionRecord,
    apiKey: string,
  ): Promise<void> {
    // The provider timeout must cover the lease, capped by what the
    // account tier allows; the cap never widens past the provider max.
    const timeoutMs = Math.min(
      Math.max(Date.parse(record.expiresAt) - Date.now(), this.sandboxTimeoutMs),
      this.maxTimeoutMs,
    );
    const created = await this.client.create({
      template: record.template,
      timeoutMs,
      metadata: this.metadataOf(record),
      apiKey,
    });
    this.writeRecord({ ...record, sandboxId: created.sandboxId });
    // Read the actual resources once; a failure here is not an
    // acquisition failure — the next reconcile refreshes them.
    try {
      const info = await this.client.getInfo(created.sandboxId, apiKey);
      if (info !== null) {
        this.captureResources(record.acquisitionId, info);
      }
    } catch {
      // The acquired truth arrives with the next reconciliation.
    }
  }

  /**
   * Find the sandbox carrying one unconfirmed record's metadata tag.
   * Adopts the newest when several carry the tag — a race that created
   * twice — and leaves the others visible to `allocations()` and the
   * provider listing.
   */
  private async recoverUnconfirmed(
    record: E2BAcquisitionRecord,
    apiKey: string,
  ): Promise<E2BAcquisitionRecord | null> {
    const found = await this.client.listByMetadata(this.metadataOf(record), apiKey);
    if (found.length === 0) {
      return null;
    }
    const newest = [...found].sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
    )[0]!;
    const updated = { ...record, sandboxId: newest.sandboxId };
    this.writeRecord(updated);
    this.captureResources(record.acquisitionId, newest);
    return updated;
  }

  /** Persist the provider's actual resources into one record. */
  private captureResources(acquisitionId: string, info: E2BSandboxInfo): void {
    const record = this.readRecord(acquisitionId);
    if (record === null || record.sandboxId !== info.sandboxId) {
      return;
    }
    this.writeRecord({
      ...record,
      resources: {
        cpuCount: info.cpuCount,
        memoryBytes: info.memoryMB * 1024 * 1024,
        envdVersion: info.envdVersion,
      },
    });
  }

  /** One manifest from one record; `null` describes a prospective one. */
  private buildManifest(
    environmentId: string,
    record: E2BAcquisitionRecord | null,
  ): EnvironmentManifest {
    return {
      environmentId,
      providerId: E2B_LINUX_PROVIDER_ID,
      platform: { os: "linux", arch: "x86_64" },
      capabilities: [processCapabilityDescriptor(PROCESS_ATTRIBUTES)],
      ...(record?.resources !== undefined
        ? {
            resources: {
              cpuCount: record.resources.cpuCount,
              memoryBytes: record.resources.memoryBytes,
            },
          }
        : {}),
      enforcement: {
        provider: "e2b",
        ...(record?.sandboxId !== undefined && record.sandboxId !== null
          ? { sandboxId: record.sandboxId }
          : {}),
        ...(record !== null ? { sandboxTemplate: record.template } : {}),
        isolation: "firecracker-microvm",
        networkEgress: this.allowInternetAccess ? "internet-allowed" : "blocked",
        ingress: "public-url-per-exposed-port",
        timeoutBehavior: "killed-when-timeout-expires",
        releaseSemantics: "kill-discards-state",
        renewal: "provider-settimeout",
      },
      enforcementFacts: { ...ENFORCEMENT_FACTS },
      adapterVersion: VERSION,
      ...(record?.resources !== undefined
        ? { providerRuntimeVersion: record.resources.envdVersion }
        : {}),
    };
  }

  private readRecord(acquisitionId: string): E2BAcquisitionRecord | null {
    const path = join(this.acquisitionsDir, `${acquisitionId}.json`);
    if (!existsSync(path)) {
      return null;
    }
    return JSON.parse(readFileSync(path, "utf8")) as E2BAcquisitionRecord;
  }

  private writeRecord(record: E2BAcquisitionRecord): void {
    const path = join(this.acquisitionsDir, `${record.acquisitionId}.json`);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(record, undefined, 2));
    renameSync(temp, path);
  }

  /**
   * The API key, resolved at use time. Credentials never persist in a
   * record, manifest, or error detail (SPEC.md sections 8 and 14.6).
   */
  private apiKey(): string {
    const key = this.apiKeyOption ?? process.env.E2B_API_KEY;
    if (key === undefined || key.length === 0) {
      throw providerUnavailableError(
        "The E2B adapter requires credentials: pass apiKey or set E2B_API_KEY. " +
          "Credentials are resolved at use time and never persisted.",
      );
    }
    return key;
  }

  /** Run one provider call, mapping faults to Portable errors. */
  private async guarded<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isPortableError(error)) {
        throw error;
      }
      throw providerUnavailableError(
        `The E2B provider call failed: ${providerError(error).message}`,
      );
    }
  }
}

/** Lease over one E2B Linux environment (SPEC.md section 8). */
export class E2BLinuxLease implements EnvironmentLease {
  constructor(
    private readonly provider: E2BLinuxAdapter,
    readonly environmentId: string,
  ) {}

  /** When the acquisition record says the lease ends. */
  get expiresAt(): string {
    return this.provider.recordOfEnvironment(this.environmentId).expiresAt;
  }

  async manifest(): Promise<EnvironmentManifest> {
    return this.provider.manifestOf(this.environmentId);
  }

  async invoke(request: AdapterInvocation): Promise<AdapterOperation> {
    return this.provider.invokeOnLease(this.environmentId, request);
  }

  async inspect(operationId: string): Promise<AdapterOperation> {
    const status = this.provider.operationStatus(operationId);
    if (status !== null) {
      return status;
    }
    throw invalidRequestError(
      `Operation ${operationId} is not known to this environment.`,
      { operationId },
    );
  }

  async cancel(operationId: string): Promise<CancellationResult> {
    return this.provider.cancelOperation(this.environmentId, operationId);
  }

  async bind(resource: ResourceRef, context: AuthorizedContext): Promise<BindingResult> {
    void resource;
    void context;
    return { status: "unsupported" };
  }

  async renew(expiresAt: string): Promise<LeaseStatus> {
    return this.provider.renewEnvironment(this.environmentId, expiresAt);
  }

  async release(): Promise<ReleaseResult> {
    return this.provider.releaseEnvironment(this.environmentId);
  }
}

/** One unknown fault as a Portable provider error. */
function providerError(error: unknown) {
  if (isPortableError(error)) {
    return error;
  }
  return providerUnavailableError(
    `The E2B provider call failed: ${String(
      error instanceof Error ? error.message : error,
    )}`,
  );
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

/**
 * Quote one argument for the shell-parsed transport. Single quotes
 * carry every byte verbatim; an embedded quote closes, escapes itself,
 * and reopens. Nothing inside is ever interpolated or split.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Build the transport command from one argument array. */
function shellCommandOf(command: string, args: readonly string[]): string {
  const argv = [command, ...args];
  for (const value of argv) {
    if (value.includes("\0")) {
      throw invalidRequestError(
        "An argument carries a NUL byte; the transport cannot pass it.",
        { reason: "nul-in-argument" },
      );
    }
  }
  return argv.map(shellQuote).join(" ");
}

/**
 * Decode one launch's standard input to text. The transport carries
 * UTF-8 text only, so bytes that are not valid UTF-8 refuse instead of
 * crossing corrupted.
 */
function stdinTextOf(input: ProcessLaunchInput): string | undefined {
  const bytes = decodeProcessStdin(input);
  if (bytes.length === 0) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidRequestError(
      "The standard input is not valid UTF-8 text; this transport carries text only.",
      { reason: "stdin-encoding" },
    );
  }
}

/**
 * One bounded output capture. Chunks arrive as UTF-8 text; bytes are
 * counted as encoded. Bytes past the cap drop with a flag and a count,
 * never silently.
 */
class StreamCapture {
  private readonly chunks: Uint8Array[] = [];
  private held = 0;
  private truncated = false;
  private omitted = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly shared?: { remaining: number },
  ) {}

  absorb(chunk: string): void {
    const bytes = Buffer.from(chunk, "utf8");
    if (bytes.length === 0) {
      return;
    }
    let room = this.maxBytes - this.held;
    if (this.shared !== undefined) {
      room = Math.min(room, Math.max(this.shared.remaining, 0));
    }
    const take = Math.min(room, bytes.length);
    if (take > 0) {
      this.chunks.push(bytes.slice(0, take));
      this.held += take;
      if (this.shared !== undefined) {
        this.shared.remaining -= take;
      }
    }
    if (take < bytes.length) {
      this.truncated = true;
      this.omitted += bytes.length - take;
    }
  }

  finish(): ProcessStreamCapture {
    return {
      ...(this.held > 0
        ? { dataBase64: Buffer.concat(this.chunks).toString("base64") }
        : {}),
      byteLength: this.held,
      truncated: this.truncated,
      ...(this.omitted > 0 ? { omittedBytes: this.omitted } : {}),
    };
  }
}

/** Enforce transfer ceilings before any byte crosses or lands. */
function checkTransferLimits(
  byteSizes: readonly number[],
  limits: E2BTransferLimits | undefined,
): void {
  if (limits === undefined) {
    return;
  }
  if (limits.maxFileCount !== undefined && byteSizes.length > limits.maxFileCount) {
    throw invalidRequestError("The transfer exceeds the authorized file count.", {
      limit: "maxFileCount",
      max: limits.maxFileCount,
      actual: byteSizes.length,
    });
  }
  if (limits.maxFileBytes !== undefined) {
    const largest = byteSizes.reduce((a, b) => Math.max(a, b), 0);
    if (largest > limits.maxFileBytes) {
      throw invalidRequestError("The transfer exceeds the authorized per-file bytes.", {
        limit: "maxFileBytes",
        max: limits.maxFileBytes,
        actual: largest,
      });
    }
  }
  if (limits.maxTotalBytes !== undefined) {
    const total = byteSizes.reduce((a, b) => a + b, 0);
    if (total > limits.maxTotalBytes) {
      throw invalidRequestError("The transfer exceeds the authorized total bytes.", {
        limit: "maxTotalBytes",
        max: limits.maxTotalBytes,
        actual: total,
      });
    }
  }
}
