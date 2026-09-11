import {
  DEFS,
  type CapabilityId,
  type Extensions,
  type Identifier,
  type UtcTimestamp,
} from "./defs.js";
import type { PortableError } from "./error.js";
import type { AttachmentRef } from "./session.js";
import type { EnvironmentRequest } from "./capability.js";

/** State classes across a handoff (SPEC.md section 12). */
export type StateClass = "portable" | "reconstructable" | "reattachable" | "native";

/** Planned treatment of one piece of state across a handoff. */
export interface StateDisposition {
  /** What this entry describes: a resource, a path, or a named state item. */
  subject: string;
  class: StateClass;
  action: "transfer" | "reconstruct" | "reattach" | "invalidate";
  resourceId?: Identifier;
  detail?: string;
  extensions?: Extensions;
}

export const stateDispositionSchema = {
  $id: "https://portable.dev/schema/state-disposition.json",
  $defs: DEFS,
  type: "object",
  required: ["subject", "class", "action"],
  additionalProperties: false,
  properties: {
    subject: { type: "string", minLength: 1, maxLength: 512 },
    class: { enum: ["portable", "reconstructable", "reattachable", "native"] },
    action: { enum: ["transfer", "reconstruct", "reattach", "invalidate"] },
    resourceId: { $ref: "#/$defs/identifier" },
    detail: { type: "string", maxLength: 2048 },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** One declared operation inside a reconstruction recipe. */
export interface RecipeStep {
  capability: string;
  operation: string;
  input: unknown;
}

/**
 * Declared reconstruction of state (SPEC.md section 12).
 *
 * Recipes declare input revision, required capabilities, operations,
 * outputs, and failure conditions. Parsing a recipe never executes it.
 */
export interface ReconstructionRecipe {
  id: Identifier;
  inputRevisionId: Identifier;
  requiredCapabilities: CapabilityId[];
  steps: RecipeStep[];
  outputs: string[];
  failureConditions: string[];
  extensions?: Extensions;
}

export const reconstructionRecipeSchema = {
  $id: "https://portable.dev/schema/reconstruction-recipe.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "inputRevisionId", "requiredCapabilities", "steps", "outputs", "failureConditions"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    inputRevisionId: { $ref: "#/$defs/identifier" },
    requiredCapabilities: { type: "array", items: { $ref: "#/$defs/capabilityId" } },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["capability", "operation", "input"],
        additionalProperties: false,
        properties: {
          capability: { $ref: "#/$defs/capabilityId" },
          operation: { $ref: "#/$defs/operationName" },
          input: { $ref: "#/$defs/jsonValue" },
        },
      },
    },
    outputs: { type: "array", items: { type: "string", minLength: 1, maxLength: 512 } },
    failureConditions: { type: "array", items: { type: "string", minLength: 1, maxLength: 2048 } },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Policy for active operations during replacement preparation (SPEC.md 13.1). */
export type ActiveOperationsPolicy = "wait" | "cancel" | "reject";

/** Destination request without the attachment name (SPEC.md section 13.1). */
export type DestinationRequest = Omit<EnvironmentRequest, "name">;

/**
 * Replacement request (SPEC.md section 13.1).
 *
 * The source generation is a precondition. A mismatch returns `StaleHandle`
 * before provisioning.
 */
export interface ReplaceRequest {
  source: AttachmentRef;
  destination: DestinationRequest;
  workspaceRevisionId: Identifier;
  requiredResources: string[];
  reconstruct: ReconstructionRecipe[];
  activeOperations: ActiveOperationsPolicy;
  requestKey: string;
  extensions?: Extensions;
}

/**
 * Destination request schema: an environment request without the attachment
 * name (SPEC.md section 13.1). The source attachment keeps its name across
 * the generation switch, so `name` is absent and rejected here.
 */
export const destinationRequestSchema = {
  $id: "https://portable.dev/schema/destination-request.json",
  $defs: DEFS,
  type: "object",
  required: ["requires"],
  additionalProperties: false,
  properties: {
    providerId: { $ref: "#/$defs/identifier" },
    requires: {
      type: "object",
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

export const replaceRequestSchema = {
  $id: "https://portable.dev/schema/replace-request.json",
  $defs: DEFS,
  type: "object",
  required: ["source", "destination", "workspaceRevisionId", "requiredResources", "reconstruct", "activeOperations", "requestKey"],
  additionalProperties: false,
  properties: {
    source: { $ref: "https://portable.dev/schema/attachment-ref.json" },
    destination: { $ref: "https://portable.dev/schema/destination-request.json" },
    workspaceRevisionId: { $ref: "#/$defs/identifier" },
    requiredResources: { type: "array", items: { $ref: "#/$defs/identifier" } },
    reconstruct: {
      type: "array",
      items: { $ref: "https://portable.dev/schema/reconstruction-recipe.json" },
    },
    activeOperations: { enum: ["wait", "cancel", "reject"] },
    requestKey: { $ref: "#/$defs/requestKey" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Side-effect-free replacement plan (SPEC.md section 13.1).
 *
 * Planning allocates nothing and does not change the workspace head.
 */
export interface HandoffPlan {
  sessionId: Identifier;
  attachmentId: Identifier;
  sourceGeneration: number;
  workspaceRevisionId: Identifier;
  preserved: StateDisposition[];
  reconstructed: StateDisposition[];
  reattached: StateDisposition[];
  invalidated: StateDisposition[];
  blockers: PortableError[];
  extensions?: Extensions;
}

export const handoffPlanSchema = {
  $id: "https://portable.dev/schema/handoff-plan.json",
  $defs: DEFS,
  type: "object",
  required: [
    "sessionId",
    "attachmentId",
    "sourceGeneration",
    "workspaceRevisionId",
    "preserved",
    "reconstructed",
    "reattached",
    "invalidated",
    "blockers",
  ],
  additionalProperties: false,
  properties: {
    sessionId: { $ref: "#/$defs/identifier" },
    attachmentId: { $ref: "#/$defs/identifier" },
    sourceGeneration: { $ref: "#/$defs/generation" },
    workspaceRevisionId: { $ref: "#/$defs/identifier" },
    preserved: { type: "array", items: { $ref: "https://portable.dev/schema/state-disposition.json" } },
    reconstructed: { type: "array", items: { $ref: "https://portable.dev/schema/state-disposition.json" } },
    reattached: { type: "array", items: { $ref: "https://portable.dev/schema/state-disposition.json" } },
    invalidated: { type: "array", items: { $ref: "https://portable.dev/schema/state-disposition.json" } },
    blockers: { type: "array", items: { $ref: "https://portable.dev/schema/error.json" } },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Outcome of a completed replacement transition. */
export type HandoffOutcome = "completed" | "failed" | "aborted";

/** Durable cleanup obligation (SPEC.md sections 8 and 13.4). */
export interface CleanupObligation {
  id: Identifier;
  kind: "release" | "unresolved-allocation" | "other";
  targetId: Identifier;
  detail?: string;
  createdAt: UtcTimestamp;
  extensions?: Extensions;
}

export const cleanupObligationSchema = {
  $id: "https://portable.dev/schema/cleanup-obligation.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "kind", "targetId", "createdAt"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    kind: { enum: ["release", "unresolved-allocation", "other"] },
    targetId: { $ref: "#/$defs/identifier" },
    detail: { type: "string", maxLength: 2048 },
    createdAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Result of `Session.replace()` (SPEC.md sections 13.3 and 13.4).
 *
 * Reports old and new generations and environments. Cleanup failures after
 * a committed switch never reverse authority; they stay obligations.
 */
export interface HandoffResult {
  transitionId: Identifier;
  sessionId: Identifier;
  attachmentId: Identifier;
  outcome: HandoffOutcome;
  oldGeneration?: number;
  newGeneration?: number;
  oldEnvironmentId?: Identifier;
  newEnvironmentId?: Identifier;
  workspaceRevisionId: Identifier;
  preserved: StateDisposition[];
  reconstructed: StateDisposition[];
  reattached: StateDisposition[];
  invalidated: StateDisposition[];
  cleanup: CleanupObligation[];
  error?: PortableError;
  extensions?: Extensions;
}

export const handoffResultSchema = {
  $id: "https://portable.dev/schema/handoff-result.json",
  $defs: DEFS,
  type: "object",
  required: [
    "transitionId",
    "sessionId",
    "attachmentId",
    "outcome",
    "workspaceRevisionId",
    "preserved",
    "reconstructed",
    "reattached",
    "invalidated",
    "cleanup",
  ],
  additionalProperties: false,
  properties: {
    transitionId: { $ref: "#/$defs/identifier" },
    sessionId: { $ref: "#/$defs/identifier" },
    attachmentId: { $ref: "#/$defs/identifier" },
    outcome: { enum: ["completed", "failed", "aborted"] },
    oldGeneration: { $ref: "#/$defs/generation" },
    newGeneration: { $ref: "#/$defs/generation" },
    oldEnvironmentId: { $ref: "#/$defs/identifier" },
    newEnvironmentId: { $ref: "#/$defs/identifier" },
    workspaceRevisionId: { $ref: "#/$defs/identifier" },
    preserved: { type: "array", items: { $ref: "https://portable.dev/schema/state-disposition.json" } },
    reconstructed: { type: "array", items: { $ref: "https://portable.dev/schema/state-disposition.json" } },
    reattached: { type: "array", items: { $ref: "https://portable.dev/schema/state-disposition.json" } },
    invalidated: { type: "array", items: { $ref: "https://portable.dev/schema/state-disposition.json" } },
    cleanup: { type: "array", items: { $ref: "https://portable.dev/schema/cleanup-obligation.json" } },
    error: { $ref: "https://portable.dev/schema/error.json" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
