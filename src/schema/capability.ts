import {
  DEFS,
  type CapabilityId,
  type Extensions,
  type Identifier,
} from "./defs.js";

/** Side-effect classification for one operation (SPEC.md section 6.2). */
export type EffectKind = "none" | "workspace" | "external" | "mixed";

/** Retry semantics for one operation (SPEC.md section 6.2). */
export type RetryClass = "safe" | "deduplicated" | "unsafe";

/** Cancellation support for one operation (SPEC.md section 6.2). */
export type CancellationSupport = "unsupported" | "best-effort" | "confirmed";

/** Descriptor for one operation of a capability (SPEC.md section 6.2). */
export interface OperationDescriptor {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  stateful: boolean;
  effects: EffectKind;
  retry: RetryClass;
  cancellation: CancellationSupport;
  streaming: boolean;
  createsResource?: string;
  extensions?: Extensions;
}

export const operationDescriptorSchema = {
  $id: "https://portable.dev/schema/operation-descriptor.json",
  $defs: DEFS,
  type: "object",
  required: [
    "inputSchema",
    "outputSchema",
    "stateful",
    "effects",
    "retry",
    "cancellation",
    "streaming",
  ],
  additionalProperties: false,
  properties: {
    inputSchema: { $ref: "#/$defs/jsonSchema" },
    outputSchema: { $ref: "#/$defs/jsonSchema" },
    stateful: { type: "boolean" },
    effects: { enum: ["none", "workspace", "external", "mixed"] },
    retry: { enum: ["safe", "deduplicated", "unsafe"] },
    cancellation: { enum: ["unsupported", "best-effort", "confirmed"] },
    streaming: { type: "boolean" },
    createsResource: { type: "string", minLength: 1 },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Versioned semantic contract for a set of operations (SPEC.md section 6.2). */
export interface CapabilityDescriptor {
  id: CapabilityId;
  operations: Record<string, OperationDescriptor>;
  attributes: Record<string, unknown>;
  extensions?: Extensions;
}

export const capabilityDescriptorSchema = {
  $id: "https://portable.dev/schema/capability-descriptor.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "operations", "attributes"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/capabilityId" },
    operations: {
      type: "object",
      propertyNames: { pattern: "^[a-z][a-zA-Z0-9_-]{0,63}$" },
      additionalProperties: { $ref: "https://portable.dev/schema/operation-descriptor.json" },
    },
    attributes: { $ref: "#/$defs/jsonObject" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Resource quantities reported by an environment (SPEC.md section 6.3). */
export interface ResourceSummary {
  cpuCount?: number;
  memoryBytes?: number;
  storageBytes?: number;
  gpuMemoryBytes?: number;
}

export const resourceSummarySchema = {
  $id: "https://portable.dev/schema/resource-summary.json",
  $defs: DEFS,
  type: "object",
  additionalProperties: false,
  properties: {
    cpuCount: { type: "integer", minimum: 1 },
    memoryBytes: { $ref: "#/$defs/byteSize" },
    storageBytes: { $ref: "#/$defs/byteSize" },
    gpuMemoryBytes: { $ref: "#/$defs/byteSize" },
  },
} as const;

/**
 * Manifest of an acquired environment (SPEC.md section 6.3).
 *
 * The runtime validates the manifest against the request. Offers are
 * discovery hints; the manifest describes the acquired allocation.
 */
export interface EnvironmentManifest {
  environmentId: Identifier;
  providerId: Identifier;
  platform: { os: string; arch: string };
  capabilities: CapabilityDescriptor[];
  resources?: ResourceSummary;
  enforcement: Record<string, unknown>;
  adapterVersion: string;
  providerRuntimeVersion?: string;
  extensions?: Extensions;
}

export const environmentManifestSchema = {
  $id: "https://portable.dev/schema/environment-manifest.json",
  $defs: DEFS,
  type: "object",
  required: [
    "environmentId",
    "providerId",
    "platform",
    "capabilities",
    "enforcement",
    "adapterVersion",
  ],
  additionalProperties: false,
  properties: {
    environmentId: { $ref: "#/$defs/identifier" },
    providerId: { $ref: "#/$defs/identifier" },
    platform: {
      type: "object",
      required: ["os", "arch"],
      additionalProperties: false,
      properties: {
        os: { type: "string", minLength: 1, maxLength: 64 },
        arch: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    capabilities: {
      type: "array",
      items: { $ref: "https://portable.dev/schema/capability-descriptor.json" },
    },
    resources: { $ref: "https://portable.dev/schema/resource-summary.json" },
    enforcement: { $ref: "#/$defs/jsonObject" },
    adapterVersion: { type: "string", minLength: 1, maxLength: 64 },
    providerRuntimeVersion: { type: "string", minLength: 1, maxLength: 128 },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Minimum quantity for one resource dimension (SPEC.md section 6.4). */
export interface ResourceQuantifier {
  min: number;
}

/** Mandatory resource minima (SPEC.md section 6.4). */
export interface ResourceRequirements {
  memoryBytes?: ResourceQuantifier;
  storageBytes?: ResourceQuantifier;
  gpuMemoryBytes?: ResourceQuantifier;
}

export const resourceRequirementsSchema = {
  $id: "https://portable.dev/schema/resource-requirements.json",
  $defs: DEFS,
  type: "object",
  additionalProperties: false,
  properties: {
    memoryBytes: { type: "object", required: ["min"], additionalProperties: false, properties: { min: { $ref: "#/$defs/byteSize" } } },
    storageBytes: { type: "object", required: ["min"], additionalProperties: false, properties: { min: { $ref: "#/$defs/byteSize" } } },
    gpuMemoryBytes: { type: "object", required: ["min"], additionalProperties: false, properties: { min: { $ref: "#/$defs/byteSize" } } },
  },
} as const;

/** Workspace binding requested with an environment (SPEC.md section 6.4). */
export interface WorkspaceBindingRequest {
  revisionId: Identifier;
  mode: "read-only" | "proposal";
}

/** Request for a new environment attachment (SPEC.md section 6.4). */
export interface EnvironmentRequest {
  name: string;
  providerId?: Identifier;
  requires: Record<string, Record<string, unknown>>;
  platform?: { os?: string; arch?: string };
  resources?: ResourceRequirements;
  constraints?: Record<string, unknown>;
  preferences?: { locality?: "local-first" | "remote-first" };
  workspace?: WorkspaceBindingRequest;
  extensions?: Extensions;
}

export const environmentRequestSchema = {
  $id: "https://portable.dev/schema/environment-request.json",
  $defs: DEFS,
  type: "object",
  required: ["name", "requires"],
  additionalProperties: false,
  properties: {
    name: { $ref: "#/$defs/attachmentName" },
    providerId: { $ref: "#/$defs/identifier" },
    requires: {
      type: "object",
      // Requirement keys are capability identifiers or namespaced attribute
      // names. Values are capability-contract matchers.
      additionalProperties: { $ref: "#/$defs/jsonObject" },
    },
    platform: {
      type: "object",
      additionalProperties: false,
      properties: {
        os: { type: "string", minLength: 1, maxLength: 64 },
        arch: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    resources: { $ref: "https://portable.dev/schema/resource-requirements.json" },
    constraints: { $ref: "#/$defs/jsonObject" },
    preferences: {
      type: "object",
      additionalProperties: false,
      properties: {
        locality: { enum: ["local-first", "remote-first"] },
      },
    },
    workspace: {
      type: "object",
      required: ["revisionId", "mode"],
      additionalProperties: false,
      properties: {
        revisionId: { $ref: "#/$defs/identifier" },
        mode: { enum: ["read-only", "proposal"] },
      },
    },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Discovery offer from an adapter (SPEC.md section 8).
 *
 * Offers are hints for matching. They are not proof of the properties of an
 * acquired environment. The shape follows the environment request so a
 * caller can compare requirements against offers before acquisition.
 */
export interface EnvironmentOffer {
  providerId: Identifier;
  adapterId?: Identifier;
  platform?: { os?: string; arch?: string };
  capabilities: Array<{
    id: CapabilityId;
    attributes: Record<string, unknown>;
  }>;
  resources?: ResourceSummary;
  enforcement?: Record<string, unknown>;
  extensions?: Extensions;
}

export const environmentOfferSchema = {
  $id: "https://portable.dev/schema/environment-offer.json",
  $defs: DEFS,
  type: "object",
  required: ["providerId", "capabilities"],
  additionalProperties: false,
  properties: {
    providerId: { $ref: "#/$defs/identifier" },
    adapterId: { $ref: "#/$defs/identifier" },
    platform: {
      type: "object",
      additionalProperties: false,
      properties: {
        os: { type: "string", minLength: 1, maxLength: 64 },
        arch: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    capabilities: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "attributes"],
        additionalProperties: false,
        properties: {
          id: { $ref: "#/$defs/capabilityId" },
          attributes: { $ref: "#/$defs/jsonObject" },
        },
      },
    },
    resources: { $ref: "https://portable.dev/schema/resource-summary.json" },
    enforcement: { $ref: "#/$defs/jsonObject" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
