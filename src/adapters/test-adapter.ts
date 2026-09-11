import {
  leaseExpiredError,
  invalidRequestError,
  invalidRequestFromValidation,
  providerUnavailableError,
} from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
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
import type { EnvironmentManifest, EnvironmentOffer } from "../schema/capability.js";
import type { AuthorizedContext } from "../schema/adapter.js";
import type { ResourceRef } from "../schema/resource.js";
import type { UtcTimestamp } from "../schema/defs.js";

/**
 * Deterministic test adapter (SPEC.md sections 8 and 21).
 *
 * The adapter runs entirely in process: no external accounts, no paid
 * allocations, no clocks, and no randomness. Every channel answers from a
 * scripted queue and falls back to a documented default, so tests
 * reproduce lost responses, delayed completion, expiration, and release
 * failure by queuing directives rather than by timing races.
 *
 * Server-side truth lives in maps the test inspects directly: an
 * invocation whose response is lost still records its effect, which is
 * exactly the evidence reconciliation needs.
 */

/** Scripted outcome of one `acquire` call. */
export type AcquireDirective =
  | { kind: "allocate"; environmentId?: string; expiresAt?: UtcTimestamp }
  | { kind: "fail"; error?: PortableError }
  | { kind: "lost"; allocateAnyway?: boolean };

/** Scripted outcome of one `invoke` call. */
export type InvokeDirective =
  | { kind: "complete"; result?: unknown }
  | { kind: "fail"; error?: PortableError }
  | { kind: "running" }
  | { kind: "lost"; effects?: "none" | "happened" | "unknown" };

/** Scripted outcome of one `cancel` call. */
export type CancelDirective =
  | { kind: "confirmed" }
  | { kind: "best-effort" }
  | { kind: "unsupported" }
  | { kind: "timeout-only" };

/** Scripted outcome of one `bind` call. */
export type BindDirective =
  | { kind: "bound"; binding?: ResourceRef }
  | { kind: "unsupported" }
  | { kind: "failed"; error?: PortableError };

/** Scripted outcome of one `renew` call. */
export type RenewDirective =
  | { kind: "extend" }
  | { kind: "refuse" }
  | { kind: "unsupported" };

/** Scripted outcome of one `release` call. */
export type ReleaseDirective =
  | { kind: "succeed" }
  | { kind: "fail-retryable" }
  | { kind: "fail-permanent" };

/** Server-side state of one acquisition. */
interface Allocation {
  state: "allocated" | "failed" | "unknown";
  environmentId?: string;
  expiresAt: UtcTimestamp;
}

/** Server-side state of one operation. */
interface RecordedOperation {
  operationId: string;
  status: AdapterOperation["status"];
  result?: unknown;
  error?: PortableError | undefined;
  effects: boolean;
}

/**
 * The server-side state the adapter and its leases share.
 *
 * These members are internal to the fake. Tests use the adapter's
 * inspection methods instead.
 */
interface FakeInternals {
  queues: {
    invoke: InvokeDirective[];
    cancel: CancelDirective[];
    bind: BindDirective[];
    renew: RenewDirective[];
    release: ReleaseDirective[];
  };
  operations: Map<string, RecordedOperation>;
  record(operationId: string, operation: RecordedOperation): void;
  trackPending(invocation: AdapterInvocation): void;
  setOperationStatus(operationId: string, status: RecordedOperation["status"]): void;
  setExpiry(environmentId: string, expiresAt: UtcTimestamp): void;
  expiryOf(environmentId: string): UtcTimestamp | undefined;
  isReleased(environmentId: string): boolean;
  markReleased(environmentId: string): void;
}

/** A promise the adapter never settles, kept for inspection. */
interface PendingInvocation {
  operationId: string;
  invocation: AdapterInvocation;
}

const FAR_FUTURE = "2999-01-01T00:00:00Z";

/** The default offer: a local process environment with a lite engine. */
function defaultOffers(): EnvironmentOffer[] {
  return [
    {
      providerId: "fake-local",
      platform: { os: "linux", arch: "x64" },
      capabilities: [
        {
          id: "exec.process@1",
          attributes: { engine: "fake-process", maxProcesses: 4 },
        },
        {
          id: "python.lite@1",
          attributes: { interpreter: "fake-monty", subset: "lite" },
        },
      ],
      resources: { memoryBytes: 1 << 30, storageBytes: 1 << 30 },
      enforcement: { "network.egress": "none", "host.filesystem": true },
    },
  ];
}

/**
 * The controllable fake provider.
 *
 * Queues are consumed one directive per call. An empty queue uses the
 * documented default of each channel: acquire allocates, invoke
 * completes, cancel is confirmed, bind is unsupported, renew extends,
 * and release succeeds.
 */
export class FakeEnvironmentAdapter implements EnvironmentAdapter, FakeInternals {
  readonly id = "adapter.fake";

  private readonly offers: EnvironmentOffer[];
  private readonly allocations = new Map<string, Allocation>();
  private readonly environments = new Map<string, EnvironmentManifest>();
  private readonly releasedEnvironments = new Set<string>();
  private readonly pending: PendingInvocation[] = [];
  private readonly acquireQueue: AcquireDirective[] = [];
  private counter = 0;

  // Internal shared state (FakeInternals).
  readonly queues: FakeInternals["queues"] = {
    invoke: [],
    cancel: [],
    bind: [],
    renew: [],
    release: [],
  };
  readonly operations = new Map<string, RecordedOperation>();

  constructor(options: { offers?: readonly EnvironmentOffer[] } = {}) {
    this.offers = [...(options.offers ?? defaultOffers())];
  }

  // -- Scripting -------------------------------------------------------------

  /** Queue the outcome of the next `acquire` call. */
  queueAcquire(directive: AcquireDirective): void {
    this.acquireQueue.push(directive);
  }

  /** Queue the outcome of the next `invoke` call. */
  queueInvoke(directive: InvokeDirective): void {
    this.queues.invoke.push(directive);
  }

  /** Queue the outcome of the next `cancel` call. */
  queueCancel(directive: CancelDirective): void {
    this.queues.cancel.push(directive);
  }

  /** Queue the outcome of the next `bind` call. */
  queueBind(directive: BindDirective): void {
    this.queues.bind.push(directive);
  }

  /** Queue the outcome of the next `renew` call. */
  queueRenew(directive: RenewDirective): void {
    this.queues.renew.push(directive);
  }

  /** Queue the outcome of the next `release` call. */
  queueRelease(directive: ReleaseDirective): void {
    this.queues.release.push(directive);
  }

  /** Complete or fail a running operation server-side. */
  settleOperation(
    operationId: string,
    outcome: { status: "completed" | "failed"; result?: unknown; error?: PortableError },
  ): void {
    const recorded = this.operations.get(operationId);
    if (recorded === undefined) {
      throw invalidRequestError(`Operation ${operationId} is not recorded.`);
    }
    recorded.status = outcome.status;
    recorded.result = outcome.result;
    recorded.error = outcome.error;
    recorded.effects = outcome.status === "completed" || recorded.effects;
  }

  /** Move one environment past its expiry, as a provider timeout would. */
  expireLease(environmentId: string): void {
    if (!this.environments.has(environmentId)) {
      throw invalidRequestError(`Environment ${environmentId} is not allocated.`);
    }
    this.setExpiry(environmentId, "2000-01-01T00:00:00Z");
  }

  /** Invocations whose response the adapter never delivered. */
  pendingInvocations(): Array<{ operationId: string; invocation: AdapterInvocation }> {
    return this.pending.map((entry) => ({ ...entry }));
  }

  /** Server-side operations, for reconciliation tests. */
  recordedOperations(): Array<{ operationId: string; status: string; effects: boolean }> {
    return [...this.operations.values()].map((operation) => ({
      operationId: operation.operationId,
      status: operation.status,
      effects: operation.effects,
    }));
  }

  // -- EnvironmentAdapter ----------------------------------------------------

  async describe(): Promise<EnvironmentOffer[]> {
    return structuredClone(this.offers);
  }

  async acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease> {
    check(() => assertValid(authorizedAcquireRequestSchema, request));
    const existing = this.allocations.get(request.acquisitionId);
    if (existing?.state === "allocated") {
      // A repeated acquisition identity returns the same environment.
      return this.lease(existing.environmentId!);
    }
    const directive = this.acquireQueue.shift() ?? { kind: "allocate" as const };
    if (directive.kind === "fail") {
      this.allocations.set(request.acquisitionId, {
        state: "failed",
        expiresAt: FAR_FUTURE,
      });
      throw (
        directive.error ??
        providerUnavailableError("The fake provider refused the acquisition.")
      );
    }
    if (directive.kind === "lost") {
      if (directive.allocateAnyway === true) {
        this.allocate(request.acquisitionId);
      } else {
        this.allocations.set(request.acquisitionId, {
          state: "unknown",
          expiresAt: FAR_FUTURE,
        });
      }
      // The response never arrives. The caller reconciles by identity.
      return new Promise<EnvironmentLease>(() => {});
    }
    this.allocate(request.acquisitionId, directive.environmentId, directive.expiresAt);
    return this.lease(this.allocations.get(request.acquisitionId)!.environmentId!);
  }

  async reconcile(acquisitionId: string): Promise<AcquisitionStatus> {
    const allocation = this.allocations.get(acquisitionId);
    if (allocation === undefined) {
      return { acquisitionId, state: "unknown" };
    }
    if (allocation.state === "allocated" && allocation.environmentId !== undefined) {
      const manifest = this.environments.get(allocation.environmentId);
      return {
        acquisitionId,
        state: "allocated",
        environmentId: allocation.environmentId,
        ...(manifest !== undefined ? { manifest: structuredClone(manifest) } : {}),
        expiresAt: allocation.expiresAt,
      };
    }
    return { acquisitionId, state: allocation.state };
  }

  /** The lease of one allocated environment. */
  lease(environmentId: string): FakeEnvironmentLease {
    const manifest = this.environments.get(environmentId);
    if (manifest === undefined) {
      throw invalidRequestError(`Environment ${environmentId} is not allocated.`);
    }
    return new FakeEnvironmentLease(this, environmentId, manifest);
  }

  /** Allocation truth, for tests and the future runtime. */
  allocationOf(acquisitionId: string): Allocation | undefined {
    const allocation = this.allocations.get(acquisitionId);
    return allocation === undefined ? undefined : { ...allocation };
  }

  // -- FakeInternals -----------------------------------------------------------

  record(operationId: string, operation: RecordedOperation): void {
    this.operations.set(operationId, operation);
  }

  trackPending(invocation: AdapterInvocation): void {
    this.pending.push({ operationId: invocation.operationId, invocation });
  }

  setOperationStatus(operationId: string, status: RecordedOperation["status"]): void {
    const recorded = this.operations.get(operationId);
    if (recorded !== undefined) {
      recorded.status = status;
    }
  }

  setExpiry(environmentId: string, expiresAt: UtcTimestamp): void {
    for (const allocation of this.allocations.values()) {
      if (allocation.environmentId === environmentId) {
        allocation.expiresAt = expiresAt;
      }
    }
  }

  expiryOf(environmentId: string): UtcTimestamp | undefined {
    for (const allocation of this.allocations.values()) {
      if (allocation.environmentId === environmentId) {
        return allocation.expiresAt;
      }
    }
    return undefined;
  }

  isReleased(environmentId: string): boolean {
    return this.releasedEnvironments.has(environmentId);
  }

  markReleased(environmentId: string): void {
    this.releasedEnvironments.add(environmentId);
  }

  private allocate(
    acquisitionId: string,
    environmentId?: string,
    expiresAt?: UtcTimestamp,
  ): string {
    const id = environmentId ?? `env-fake-${(this.counter += 1)}`;
    const offer = this.offers[0]!;
    const manifest: EnvironmentManifest = {
      environmentId: id,
      providerId: offer.providerId,
      platform: { os: offer.platform?.os ?? "linux", arch: offer.platform?.arch ?? "x64" },
      capabilities: [
        {
          id: "exec.process@1",
          operations: {
            run: {
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              stateful: false,
              effects: "external",
              retry: "unsafe",
              cancellation: "best-effort",
              streaming: true,
            },
          },
          attributes: { engine: "fake-process", maxProcesses: 4 },
        },
      ],
      ...(offer.resources !== undefined ? { resources: offer.resources } : {}),
      enforcement: offer.enforcement ?? {},
      adapterVersion: "1.0.0-fake",
    };
    this.environments.set(id, manifest);
    this.allocations.set(acquisitionId, {
      state: "allocated",
      environmentId: id,
      expiresAt: expiresAt ?? FAR_FUTURE,
    });
    return id;
  }
}

/** Lease over one fake environment. */
export class FakeEnvironmentLease implements EnvironmentLease {
  readonly environmentId: string;

  private readonly provider: FakeInternals;
  private readonly recordedManifest: EnvironmentManifest;

  constructor(
    provider: FakeInternals,
    environmentId: string,
    manifest: EnvironmentManifest,
  ) {
    this.provider = provider;
    this.environmentId = environmentId;
    this.recordedManifest = manifest;
  }

  async manifest(): Promise<EnvironmentManifest> {
    return structuredClone(this.recordedManifest);
  }

  async invoke(request: AdapterInvocation): Promise<AdapterOperation> {
    check(() => assertValid(adapterInvocationSchema, request));
    if (this.isExpired()) {
      throw leaseExpiredError(`environment ${this.environmentId}`, this.currentExpiry());
    }
    const directive = this.provider.queues.invoke.shift() ?? { kind: "complete" as const };
    if (directive.kind === "lost") {
      const effects = directive.effects ?? "none";
      this.provider.record(request.operationId, {
        operationId: request.operationId,
        status:
          effects === "happened" ? "completed" : effects === "unknown" ? "unknown" : "running",
        effects: effects === "happened",
        ...(effects === "happened" ? { result: request.input } : {}),
      });
      this.provider.trackPending(request);
      // The response never arrives; inspect reveals the server-side truth.
      return new Promise<AdapterOperation>(() => {});
    }
    const operation = this.applyDirective(request.operationId, directive);
    return {
      operationId: request.operationId,
      status: operation.status,
      ...(operation.result !== undefined ? { result: operation.result } : {}),
      ...(operation.error !== undefined ? { error: operation.error } : {}),
    };
  }

  async inspect(operationId: string): Promise<AdapterOperationStatus> {
    const recorded = this.provider.operations.get(operationId);
    if (recorded === undefined) {
      throw invalidRequestError(`Operation ${operationId} is not recorded.`);
    }
    return {
      operationId,
      status: recorded.status,
      ...(recorded.result !== undefined ? { result: recorded.result } : {}),
      ...(recorded.error !== undefined ? { error: recorded.error } : {}),
    };
  }

  async cancel(operationId: string): Promise<CancellationResult> {
    const directive = this.provider.queues.cancel.shift() ?? { kind: "confirmed" as const };
    switch (directive.kind) {
      case "confirmed":
        this.provider.setOperationStatus(operationId, "cancelled");
        return { outcome: "confirmed", stopped: true, descendantsStopped: true };
      case "best-effort":
        return { outcome: "best-effort", stopped: false, detail: "The fake provider tried." };
      case "unsupported":
        return { outcome: "unsupported", stopped: false };
      case "timeout-only":
        // A caller timeout alone proves nothing about termination.
        return { outcome: "best-effort", stopped: false, detail: "Only the caller timed out." };
    }
  }

  async bind(resource: ResourceRef, context: AuthorizedContext): Promise<BindingResult> {
    void context;
    const directive = this.provider.queues.bind.shift() ?? { kind: "unsupported" as const };
    switch (directive.kind) {
      case "bound":
        return {
          status: "bound",
          binding: directive.binding ?? resource,
        };
      case "unsupported":
        return { status: "unsupported" };
      case "failed":
        return {
          status: "failed",
          error: directive.error ?? providerUnavailableError("The fake binding failed."),
        };
    }
  }

  async renew(expiresAt: string): Promise<LeaseStatus> {
    const directive = this.provider.queues.renew.shift() ?? { kind: "extend" as const };
    if (directive.kind === "unsupported") {
      return { status: "active", renewalSupported: false };
    }
    if (directive.kind === "refuse" || this.isExpired()) {
      return {
        status: "expired",
        renewalSupported: true,
        expiresAt: this.currentExpiry(),
      };
    }
    this.provider.setExpiry(this.environmentId, expiresAt);
    return { status: "active", renewalSupported: true, expiresAt };
  }

  async release(): Promise<ReleaseResult> {
    if (this.provider.isReleased(this.environmentId)) {
      // Idempotent: a repeated release reports success again.
      return { status: "released", retryable: false };
    }
    const directive = this.provider.queues.release.shift() ?? { kind: "succeed" as const };
    if (directive.kind === "succeed") {
      this.provider.markReleased(this.environmentId);
      return { status: "released", retryable: false };
    }
    return {
      status: "failed",
      retryable: directive.kind === "fail-retryable",
      detail:
        directive.kind === "fail-retryable"
          ? "The fake provider is temporarily unable to release."
          : "The fake provider cannot release this environment.",
    };
  }

  // -- Internals ---------------------------------------------------------------

  private isExpired(): boolean {
    const expiry = this.currentExpiry();
    return Date.parse(expiry) <= Date.now();
  }

  private currentExpiry(): UtcTimestamp {
    return this.provider.expiryOf(this.environmentId) ?? FAR_FUTURE;
  }

  private applyDirective(operationId: string, directive: InvokeDirective): RecordedOperation {
    const operation: RecordedOperation =
      directive.kind === "complete"
        ? { operationId, status: "completed", effects: true, result: directive.result }
        : directive.kind === "fail"
          ? {
              operationId,
              status: "failed",
              effects: false,
              error: directive.error ?? providerUnavailableError("The fake operation failed."),
            }
          : { operationId, status: "running", effects: false };
    this.provider.record(operationId, operation);
    return operation;
  }
}

/** Run a validation body, converting failures to Portable errors. */
function check(body: () => void): void {
  try {
    body();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
}
