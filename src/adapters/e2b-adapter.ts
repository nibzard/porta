import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { NotFoundError, Sandbox } from "@e2b/sdk";
import type { SandboxInfo } from "@e2b/sdk";
import {
  cleanupPendingError,
  invalidRequestError,
  invalidRequestFromValidation,
  isPortableError,
  leaseExpiredError,
  providerUnavailableError,
  staleHandleError,
  unsupportedOperationError,
} from "../core/errors.js";
import { ValidationError, assertValid } from "../schema/validate.js";
import {
  adapterInvocationSchema,
  authorizedAcquireRequestSchema,
} from "../schema/adapter.js";
import type {
  AdapterInvocation,
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
import type { EnvironmentManifest } from "../schema/capability.js";
import type { ResourceRef } from "../schema/resource.js";
import { checkTargetSatisfies, manifestTarget } from "../core/matching.js";
import { VERSION } from "../version.js";

/**
 * E2B remote Linux adapter (SPEC.md sections 8 and 22; provider selection
 * recorded in docs/providers/selection.md).
 *
 * The adapter owns the machine lifecycle only: discovery, acquisition,
 * reconciliation, renewal, and release of one Firecracker microVM per
 * acquisition. Capability operations arrive with `exec.process@1`
 * support; until then `describe()` offers nothing and `invoke` refuses
 * everything — an adapter never claims work it does not do.
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

/** Provider hard cap of one timeout: twenty-four hours. */
const PROVIDER_MAX_TIMEOUT_MS = 86_400_000;

/** Default renewal cap: the Hobby-tier cap of one hour. */
const DEFAULT_MAX_TIMEOUT_MS = 3_600_000;

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
  }

  // -- EnvironmentAdapter ------------------------------------------------------

  /**
   * Discovery offers. Empty until `exec.process@1` operations land:
   * this adapter provides allocation and lease lifecycle only, and a
   * published offer must carry at least one real capability.
   */
  async describe(): Promise<[]> {
    return [];
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
    // The intent record exists before any provider call: a crash past
    // this point recovers by identity (SPEC.md section 8).
    const record: E2BAcquisitionRecord = {
      acquisitionId: request.acquisitionId,
      environmentId,
      sandboxId: null,
      template: this.template,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + this.leaseTtlMs).toISOString(),
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

  /** Route one invocation from a lease. */
  async invokeOnLease(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<never> {
    checkValid(() => assertValid(adapterInvocationSchema, request));
    this.requireLive(environmentId);
    // This adapter implements the machine lifecycle only. Capability
    // operations arrive with exec.process@1 support; until then every
    // invocation is refused, never silently accepted.
    throw unsupportedOperationError(request.capability, request.operation, {
      reason:
        "The e2b-linux adapter provides allocation and lease lifecycle; " +
        "capability operations are not implemented yet.",
    });
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
      capabilities: [],
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

  async manifest(): Promise<EnvironmentManifest> {
    return this.provider.manifestOf(this.environmentId);
  }

  async invoke(request: AdapterInvocation): Promise<never> {
    return this.provider.invokeOnLease(this.environmentId, request);
  }

  async inspect(operationId: string): Promise<never> {
    throw invalidRequestError(
      `Operation ${operationId} is not known to this environment.`,
      { operationId },
    );
  }

  async cancel(operationId: string): Promise<CancellationResult> {
    void operationId;
    // No operations exist on this adapter yet, so nothing can be
    // cancelled; the refusal is explicit, never a silent success.
    return {
      outcome: "unsupported",
      stopped: false,
      detail: "The e2b-linux adapter runs no capability operations yet.",
    };
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
