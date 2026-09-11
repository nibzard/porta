import {
  DEFS,
  type CapabilityId,
  type Extensions,
  type Identifier,
  type UtcTimestamp,
} from "./defs.js";
import type { PortableError } from "./error.js";
import type {
  EnvironmentManifest,
  EnvironmentOffer,
  EnvironmentRequest,
} from "./capability.js";
import type { ResourceRef } from "./resource.js";

/**
 * Serializable half of the authenticated authority for one adapter call.
 *
 * The full `AuthorizedContext` also carries a secret resolver handle, which
 * is a function and never part of a serializable public input
 * (SPEC.md section 8).
 */
export interface AuthorityEnvelope {
  /** Authenticated principal supplied by the embedding application. */
  principal: string;
  /** Reference to the approved policy in force. */
  policyRef: string;
}

/**
 * Acquire request enriched with durable identity and authority
 * (SPEC.md sections 5.2 and 8).
 *
 * `acquisitionId` is the durable request identifier. An adapter either
 * supports idempotent acquisition or reconciles allocations by it.
 */
export interface AuthorizedAcquireRequest {
  acquisitionId: Identifier;
  request: EnvironmentRequest;
  authority: AuthorityEnvelope;
  deadline?: UtcTimestamp;
  extensions?: Extensions;
}

export const authorizedAcquireRequestSchema = {
  $id: "https://portable.dev/schema/authorized-acquire-request.json",
  $defs: DEFS,
  type: "object",
  required: ["acquisitionId", "request", "authority"],
  additionalProperties: false,
  properties: {
    acquisitionId: { $ref: "#/$defs/identifier" },
    request: { $ref: "https://portable.dev/schema/environment-request.json" },
    authority: {
      type: "object",
      required: ["principal", "policyRef"],
      additionalProperties: false,
      properties: {
        principal: { type: "string", minLength: 1, maxLength: 512 },
        policyRef: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    deadline: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Lifecycle state of one durable acquisition. */
export type AcquisitionState =
  | "pending"
  | "allocated"
  | "failed"
  | "unknown"
  | "released";

/**
 * Reconciliation answer for one acquisition identity
 * (SPEC.md sections 5.2 and 8).
 *
 * `unknown` means the allocation cannot be identified. The runtime reports
 * an unresolved allocation instead of retrying blindly.
 */
export interface AcquisitionStatus {
  acquisitionId: Identifier;
  state: AcquisitionState;
  environmentId?: Identifier;
  manifest?: EnvironmentManifest;
  expiresAt?: UtcTimestamp;
  error?: PortableError;
  extensions?: Extensions;
}

export const acquisitionStatusSchema = {
  $id: "https://portable.dev/schema/acquisition-status.json",
  $defs: DEFS,
  type: "object",
  required: ["acquisitionId", "state"],
  additionalProperties: false,
  properties: {
    acquisitionId: { $ref: "#/$defs/identifier" },
    state: { enum: ["pending", "allocated", "failed", "unknown", "released"] },
    environmentId: { $ref: "#/$defs/identifier" },
    manifest: { $ref: "https://portable.dev/schema/environment-manifest.json" },
    expiresAt: { $ref: "#/$defs/timestamp" },
    error: { $ref: "https://portable.dev/schema/error.json" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Known adapter-side operation states. */
export type AdapterOperationState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

/**
 * Invocation context for an adapter (SPEC.md section 8).
 *
 * Includes the operation identifier, deadline, authorized limits, and
 * allocation identity. Credentials stay outside this record.
 */
export interface AdapterInvocation {
  operationId: Identifier;
  capability: CapabilityId;
  operation: string;
  input: unknown;
  environmentId: Identifier;
  deadline?: UtcTimestamp;
  limits: Record<string, unknown>;
  requestKey?: string;
  extensions?: Extensions;
}

export const adapterInvocationSchema = {
  $id: "https://portable.dev/schema/adapter-invocation.json",
  $defs: DEFS,
  type: "object",
  required: ["operationId", "capability", "operation", "input", "environmentId", "limits"],
  additionalProperties: false,
  properties: {
    operationId: { $ref: "#/$defs/identifier" },
    capability: { $ref: "#/$defs/capabilityId" },
    operation: { $ref: "#/$defs/operationName" },
    input: { $ref: "#/$defs/jsonValue" },
    environmentId: { $ref: "#/$defs/identifier" },
    deadline: { $ref: "#/$defs/timestamp" },
    limits: { $ref: "#/$defs/jsonObject" },
    requestKey: { $ref: "#/$defs/requestKey" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Adapter answer to `invoke` (SPEC.md section 8). */
export interface AdapterOperation {
  operationId: Identifier;
  status: AdapterOperationState;
  result?: unknown;
  error?: PortableError;
  extensions?: Extensions;
}

/** Adapter answer to `inspect` (SPEC.md section 8). */
export interface AdapterOperationStatus {
  operationId: Identifier;
  status: AdapterOperationState;
  result?: unknown;
  error?: PortableError;
  extensions?: Extensions;
}

const adapterOperationRecordSchema = {
  $id: "https://portable.dev/schema/adapter-operation.json",
  $defs: DEFS,
  type: "object",
  required: ["operationId", "status"],
  additionalProperties: false,
  properties: {
    operationId: { $ref: "#/$defs/identifier" },
    status: { enum: ["running", "completed", "failed", "cancelled", "unknown"] },
    result: { $ref: "#/$defs/jsonValue" },
    error: { $ref: "https://portable.dev/schema/error.json" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

export { adapterOperationRecordSchema as adapterOperationSchema };
export const adapterOperationStatusSchema = adapterOperationRecordSchema;

/**
 * Result of a cancellation attempt (SPEC.md sections 8 and 14.1).
 *
 * `outcome` states whether termination is confirmed, best-effort, or
 * unsupported. `descendantsStopped` reports descendant processes when the
 * adapter tracks them.
 */
export interface CancellationResult {
  outcome: "confirmed" | "best-effort" | "unsupported";
  stopped: boolean;
  descendantsStopped?: boolean;
  detail?: string;
  extensions?: Extensions;
}

export const cancellationResultSchema = {
  $id: "https://portable.dev/schema/cancellation-result.json",
  $defs: DEFS,
  type: "object",
  required: ["outcome", "stopped"],
  additionalProperties: false,
  properties: {
    outcome: { enum: ["confirmed", "best-effort", "unsupported"] },
    stopped: { type: "boolean" },
    descendantsStopped: { type: "boolean" },
    detail: { type: "string", maxLength: 2048 },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Lease state after `renew` (SPEC.md section 8). */
export interface LeaseStatus {
  status: "active" | "expired";
  expiresAt?: UtcTimestamp;
  renewalSupported: boolean;
  extensions?: Extensions;
}

export const leaseStatusSchema = {
  $id: "https://portable.dev/schema/lease-status.json",
  $defs: DEFS,
  type: "object",
  required: ["status", "renewalSupported"],
  additionalProperties: false,
  properties: {
    status: { enum: ["active", "expired"] },
    expiresAt: { $ref: "#/$defs/timestamp" },
    renewalSupported: { type: "boolean" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Result of `release` (SPEC.md section 8).
 *
 * Release is idempotent. A failed release becomes a cleanup obligation that
 * survives restart, reported through `retryable`.
 */
export interface ReleaseResult {
  status: "released" | "failed";
  retryable: boolean;
  detail?: string;
  extensions?: Extensions;
}

export const releaseResultSchema = {
  $id: "https://portable.dev/schema/release-result.json",
  $defs: DEFS,
  type: "object",
  required: ["status", "retryable"],
  additionalProperties: false,
  properties: {
    status: { enum: ["released", "failed"] },
    retryable: { type: "boolean" },
    detail: { type: "string", maxLength: 2048 },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Result of binding a resource to a consumer (SPEC.md sections 8 and 10). */
export interface BindingResult {
  status: "bound" | "unsupported" | "failed";
  binding?: ResourceRef;
  error?: PortableError;
  extensions?: Extensions;
}

export const bindingResultSchema = {
  $id: "https://portable.dev/schema/binding-result.json",
  $defs: DEFS,
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { enum: ["bound", "unsupported", "failed"] },
    binding: { $ref: "https://portable.dev/schema/resource-ref.json" },
    error: { $ref: "https://portable.dev/schema/error.json" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Authenticated authority passed to the adapter at use time
 * (SPEC.md sections 7 and 8).
 *
 * The secret resolver is a function handle. It never serializes into public
 * records, events, or bundles.
 */
export interface AuthorizedContext {
  authority: AuthorityEnvelope;
  resolveSecret(secretRef: string): Promise<string>;
}

/**
 * Adapter contract (SPEC.md section 8).
 *
 * Interfaces state responsibilities. The deterministic test adapter and the
 * concrete providers implement them.
 */
export interface EnvironmentAdapter {
  readonly id: string;
  describe(): Promise<EnvironmentOffer[]>;
  acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease>;
  reconcile(acquisitionId: string): Promise<AcquisitionStatus>;
}

/** Lease over one acquired environment (SPEC.md section 8). */
export interface EnvironmentLease {
  readonly environmentId: string;
  manifest(): Promise<EnvironmentManifest>;
  invoke(request: AdapterInvocation): Promise<AdapterOperation>;
  inspect(operationId: string): Promise<AdapterOperationStatus>;
  cancel(operationId: string): Promise<CancellationResult>;
  bind(resource: ResourceRef, context: AuthorizedContext): Promise<BindingResult>;
  renew(expiresAt: string): Promise<LeaseStatus>;
  release(): Promise<ReleaseResult>;
}
