import { DEFS } from "./defs.js";
import type { Extensions, Identifier, UtcTimestamp } from "./defs.js";

/**
 * Approved policy document (SPEC.md section 7).
 *
 * The embedding application supplies this document from its own
 * authenticated context. Model-controlled invocation input never supplies
 * it. Every field is a limit: an omitted field grants nothing at the root
 * and inherits the configured value inside a narrowing (see
 * `PolicyAuthority.derive`).
 */
export interface PortablePolicy {
  schemaVersion: 1;
  /** Provider identifiers allowed for acquisition. */
  providers?: string[];
  /**
   * Allowed capability operations. An entry of `name@major` grants every
   * operation of that capability; `name@major/operation` grants one.
   */
  operations?: string[];
  /** Allowed execution locations. */
  locations?: ExecutionLocation[];
  /** Allowed workspace transfer destinations. */
  transferDestinations?: ExecutionLocation[];
  /** Network egress mode of the whole environment, subprocesses included. */
  networkEgress?: EgressMode;
  /** Host entries allowed when the mode is `allowlist`. */
  egressAllowlist?: string[];
  /** Whether environment processes may reach the host filesystem. */
  hostFilesystemAccess?: boolean;
  /** Maximum environment lifetime in whole milliseconds. */
  maxEnvironmentLifetimeMs?: number;
  /** Maximum resource allocation per environment. */
  maxResources?: PolicyResourceLimits;
  /** Secret references the authority resolves at execution time. */
  secrets?: string[];
  /** Service audiences that may be exposed or connected. */
  serviceAudiences?: string[];
  extensions?: Extensions;
}

/** Network egress mode (SPEC.md section 7). */
export type EgressMode = "none" | "allowlist" | "unrestricted";

/** Execution location of an environment or transfer destination. */
export type ExecutionLocation = "local" | "remote";

/** Resource ceilings of one policy. */
export interface PolicyResourceLimits {
  memoryBytes?: number;
  storageBytes?: number;
  gpuMemoryBytes?: number;
}

/**
 * Effective acquisition limits sent with one authorized acquire
 * (SPEC.md sections 7 and 8).
 *
 * `PolicyAuthority` constructs this record from the approved policy;
 * request constraints and extensions never widen it. Adapters enforce
 * these limits or refuse the allocation: an adapter that cannot
 * enforce a restriction must reject the acquire before allocating.
 */
export interface AcquisitionLimits {
  /** Execution locations this acquisition may use. */
  executionLocations: ExecutionLocation[];
  /** The egress mode the environment may not exceed, subprocesses included. */
  networkEgress: EgressMode;
  /** Host entries allowed under the `allowlist` mode. */
  egressAllowlist: string[];
  /** Whether environment processes may reach the host filesystem. */
  hostFilesystemAccess: boolean;
  /** Maximum lease span from the acquire, in whole milliseconds. */
  maxEnvironmentLifetimeMs: number;
  /** Resource ceilings of the allocation. */
  maxResources: PolicyResourceLimits;
}

/** Allow list entry: a host, an optional `*.` prefix, an optional port. */
export const EGRESS_HOST_PATTERN =
  "^(?:\\*\\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$";

export const acquisitionLimitsSchema = {
  $id: "https://portable.dev/schema/acquisition-limits.json",
  $defs: DEFS,
  type: "object",
  required: [
    "executionLocations",
    "networkEgress",
    "egressAllowlist",
    "hostFilesystemAccess",
    "maxEnvironmentLifetimeMs",
    "maxResources",
  ],
  additionalProperties: false,
  properties: {
    executionLocations: {
      type: "array",
      uniqueItems: true,
      items: { enum: ["local", "remote"] },
    },
    networkEgress: { enum: ["none", "allowlist", "unrestricted"] },
    egressAllowlist: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: EGRESS_HOST_PATTERN },
    },
    hostFilesystemAccess: { type: "boolean" },
    maxEnvironmentLifetimeMs: { type: "integer", minimum: 0 },
    maxResources: {
      type: "object",
      additionalProperties: false,
      properties: {
        memoryBytes: { $ref: "#/$defs/byteSize" },
        storageBytes: { $ref: "#/$defs/byteSize" },
        gpuMemoryBytes: { $ref: "#/$defs/byteSize" },
      },
    },
  },
} as const;

/** Entry of an operations allow list. */
export const OPERATION_GRANT_PATTERN =
  "^[a-z0-9][a-z0-9._-]*@[0-9]+(?:/[a-z][a-zA-Z0-9_-]{0,63})?$";

export const policySchema = {
  $id: "https://portable.dev/schema/policy.json",
  $defs: DEFS,
  type: "object",
  required: ["schemaVersion"],
  additionalProperties: false,
  properties: {
    schemaVersion: { $ref: "#/$defs/schemaVersion" },
    providers: {
      type: "array",
      uniqueItems: true,
      items: { $ref: "#/$defs/identifier" },
    },
    operations: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: OPERATION_GRANT_PATTERN },
    },
    locations: {
      type: "array",
      uniqueItems: true,
      items: { enum: ["local", "remote"] },
    },
    transferDestinations: {
      type: "array",
      uniqueItems: true,
      items: { enum: ["local", "remote"] },
    },
    networkEgress: { enum: ["none", "allowlist", "unrestricted"] },
    egressAllowlist: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: EGRESS_HOST_PATTERN },
    },
    hostFilesystemAccess: { type: "boolean" },
    maxEnvironmentLifetimeMs: { type: "integer", minimum: 1 },
    maxResources: {
      type: "object",
      additionalProperties: false,
      properties: {
        memoryBytes: { $ref: "#/$defs/byteSize" },
        storageBytes: { $ref: "#/$defs/byteSize" },
        gpuMemoryBytes: { $ref: "#/$defs/byteSize" },
      },
    },
    secrets: {
      type: "array",
      uniqueItems: true,
      items: { $ref: "#/$defs/identifier" },
    },
    serviceAudiences: {
      type: "array",
      uniqueItems: true,
      items: { $ref: "#/$defs/identifier" },
    },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * One committed policy revocation (SPEC.md section 7).
 *
 * Revocation blocks new admissions immediately after the policy update
 * commits. Existing operations receive cancellation requests where a
 * transport can carry them; an unconfirmed stop stays visible on the
 * operation record instead of being reported as stopped.
 */
export interface PolicyRevocation {
  id: Identifier;
  sessionId: Identifier;
  /** Revoked operation grants: `name@major` or `name@major/operation`. */
  operations: string[];
  /** Revoked provider identifiers. */
  providers: string[];
  /** Why the authority was revoked, for the journal and reports. */
  reason: string;
  committedAt: UtcTimestamp;
}

export const policyRevocationSchema = {
  $id: "https://portable.dev/schema/policy-revocation.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "sessionId", "operations", "providers", "reason", "committedAt"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    sessionId: { $ref: "#/$defs/identifier" },
    operations: {
      type: "array",
      uniqueItems: true,
      maxItems: 4096,
      items: { type: "string", pattern: OPERATION_GRANT_PATTERN },
    },
    providers: {
      type: "array",
      uniqueItems: true,
      maxItems: 4096,
      items: { $ref: "#/$defs/identifier" },
    },
    reason: { type: "string", minLength: 1, maxLength: 2048 },
    committedAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Input of one revocation commit. */
export interface PolicyRevocationInput {
  /** Durable identity; a repeated identifier returns the committed record. */
  revocationId?: Identifier;
  /** Revoked operation grants: `name@major` or `name@major/operation`. */
  operations?: string[];
  /** Revoked provider identifiers. */
  providers?: string[];
  reason: string;
}

export const policyRevocationInputSchema = {
  $id: "https://portable.dev/schema/policy-revocation-input.json",
  $defs: DEFS,
  type: "object",
  required: ["reason"],
  additionalProperties: false,
  properties: {
    revocationId: { $ref: "#/$defs/identifier" },
    operations: {
      type: "array",
      uniqueItems: true,
      minItems: 1,
      maxItems: 4096,
      items: { type: "string", pattern: OPERATION_GRANT_PATTERN },
    },
    providers: {
      type: "array",
      uniqueItems: true,
      minItems: 1,
      maxItems: 4096,
      items: { $ref: "#/$defs/identifier" },
    },
    reason: { type: "string", minLength: 1, maxLength: 2048 },
  },
  anyOf: [{ required: ["operations"] }, { required: ["providers"] }],
} as const;
