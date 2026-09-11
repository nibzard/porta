import { DEFS } from "./defs.js";
import { EVENT_TYPES } from "./event.js";
import type { EventTypeName } from "./event.js";
import { validateAgainstSchema } from "./validate.js";
import type { ValidationIssue } from "./validate.js";
import type { StateDisposition } from "./handoff.js";
import type { PortableError } from "./error.js";

/**
 * Payload contracts for the required event types (SPEC.md sections 9.3
 * and 18.1).
 *
 * The base event schema checks the envelope. These contracts check the
 * `data` payload of each required type, so every journal entry carries
 * the fields its consumers need. Extension event types (domain
 * namespaced) have no contract here; they pass the envelope check only.
 */

export interface AttachmentAttachedPayload {
  attachmentId: string;
  name: string;
  generation: number;
  environmentId?: string;
  providerId?: string;
  capabilityIds?: string[];
}

export interface AttachmentReplacedPayload {
  attachmentId: string;
  oldGeneration: number;
  newGeneration: number;
  oldEnvironmentId: string;
  newEnvironmentId: string;
  workspaceRevisionId: string;
  capabilityChanges: { added: string[]; removed: string[] };
  dispositions: StateDisposition[];
}

export interface AttachmentReleasedPayload {
  attachmentId: string;
  generation: number;
  reason?: string;
  cleanupIds?: string[];
}

export interface AttachmentUnavailablePayload {
  attachmentId: string;
  generation: number;
  reason: string;
  detail?: string;
  providerConfirmedTermination?: boolean;
}

export interface LeaseExpiredPayload {
  attachmentId: string;
  leaseKind: "environment" | "mutation";
  expiredAt: string;
  generation?: number;
  holder?: string;
  resourceId?: string;
}

export interface OperationUpdatedPayload {
  operationId: string;
  status: "accepted" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  requestKey?: string;
  resultRef?: string;
  error?: PortableError;
}

export interface OperationOutputPayload {
  operationId: string;
  stream: "stdout" | "stderr";
  chunkSequence: number;
  truncated: boolean;
  executionContinued: boolean;
  omittedBytes?: number;
  byteLength?: number;
  artifactDigest?: string;
}

export interface WorkspaceCheckpointedPayload {
  revisionId: string;
  requestKey: string;
  parentRevisionId?: string;
  fileCount?: number;
  totalBytes?: number;
  exclusions?: string[];
}

export interface WorkspaceProposedPayload {
  proposalId: string;
  baseRevisionId: string;
  candidateRevisionId: string;
  operationIds?: string[];
}

export interface WorkspaceAcceptedPayload {
  proposalId: string;
  revisionId: string;
  previousHeadRevisionId?: string;
}

export interface ResourceInvalidatedPayload {
  resourceId: string;
  reason: string;
  ownerGeneration?: number;
  attachmentId?: string;
}

export interface ResourceReboundPayload {
  resourceId: string;
  ownerAttachmentId: string;
  ownerGeneration: number;
  previousOwnerGeneration?: number;
}

export interface HandoffUpdatedPayload {
  transitionId: string;
  phase: string;
  outcome?: "completed" | "failed" | "aborted";
  oldGeneration?: number;
  newGeneration?: number;
  detail?: string;
}

export interface CleanupPendingPayload {
  cleanupId: string;
  kind: "release" | "unresolved-allocation" | "other";
  targetId: string;
  detail?: string;
  attempts?: number;
}

const capabilityChanges = {
  type: "object",
  required: ["added", "removed"],
  additionalProperties: false,
  properties: {
    added: { type: "array", items: { $ref: "#/$defs/capabilityId" } },
    removed: { type: "array", items: { $ref: "#/$defs/capabilityId" } },
  },
} as const;

/** Payload schema per required event type. */
export const EVENT_PAYLOAD_SCHEMAS: Record<EventTypeName, object> = {
  "attachment.attached": {
    $defs: DEFS,
    type: "object",
    required: ["attachmentId", "name", "generation"],
    additionalProperties: false,
    properties: {
      attachmentId: { $ref: "#/$defs/identifier" },
      name: { $ref: "#/$defs/attachmentName" },
      generation: { $ref: "#/$defs/generation" },
      environmentId: { $ref: "#/$defs/identifier" },
      providerId: { $ref: "#/$defs/identifier" },
      capabilityIds: { type: "array", items: { $ref: "#/$defs/capabilityId" } },
    },
  },
  "attachment.replaced": {
    $defs: DEFS,
    type: "object",
    required: [
      "attachmentId",
      "oldGeneration",
      "newGeneration",
      "oldEnvironmentId",
      "newEnvironmentId",
      "workspaceRevisionId",
      "capabilityChanges",
      "dispositions",
    ],
    additionalProperties: false,
    properties: {
      attachmentId: { $ref: "#/$defs/identifier" },
      oldGeneration: { $ref: "#/$defs/generation" },
      newGeneration: { $ref: "#/$defs/generation" },
      oldEnvironmentId: { $ref: "#/$defs/identifier" },
      newEnvironmentId: { $ref: "#/$defs/identifier" },
      workspaceRevisionId: { $ref: "#/$defs/identifier" },
      capabilityChanges,
      dispositions: {
        type: "array",
        items: { $ref: "https://portable.dev/schema/state-disposition.json" },
      },
    },
  },
  "attachment.released": {
    $defs: DEFS,
    type: "object",
    required: ["attachmentId", "generation"],
    additionalProperties: false,
    properties: {
      attachmentId: { $ref: "#/$defs/identifier" },
      generation: { $ref: "#/$defs/generation" },
      reason: { type: "string", maxLength: 512 },
      cleanupIds: { type: "array", items: { $ref: "#/$defs/identifier" } },
    },
  },
  "attachment.unavailable": {
    $defs: DEFS,
    type: "object",
    required: ["attachmentId", "generation", "reason"],
    additionalProperties: false,
    properties: {
      attachmentId: { $ref: "#/$defs/identifier" },
      generation: { $ref: "#/$defs/generation" },
      reason: { type: "string", minLength: 1, maxLength: 512 },
      detail: { type: "string", maxLength: 2048 },
      providerConfirmedTermination: { type: "boolean" },
    },
  },
  "lease.expired": {
    $defs: DEFS,
    type: "object",
    required: ["attachmentId", "leaseKind", "expiredAt"],
    additionalProperties: false,
    properties: {
      attachmentId: { $ref: "#/$defs/identifier" },
      leaseKind: { enum: ["environment", "mutation"] },
      expiredAt: { $ref: "#/$defs/timestamp" },
      generation: { $ref: "#/$defs/generation" },
      holder: { $ref: "#/$defs/identifier" },
      resourceId: { $ref: "#/$defs/identifier" },
    },
  },
  "operation.updated": {
    $defs: DEFS,
    type: "object",
    required: ["operationId", "status"],
    additionalProperties: false,
    properties: {
      operationId: { $ref: "#/$defs/identifier" },
      status: {
        enum: ["accepted", "running", "completed", "failed", "cancelled", "unknown"],
      },
      requestKey: { $ref: "#/$defs/requestKey" },
      resultRef: { type: "string", minLength: 1, maxLength: 512 },
      error: { $ref: "https://portable.dev/schema/error.json" },
    },
  },
  "operation.output": {
    $defs: DEFS,
    type: "object",
    required: ["operationId", "stream", "chunkSequence", "truncated", "executionContinued"],
    additionalProperties: false,
    properties: {
      operationId: { $ref: "#/$defs/identifier" },
      stream: { enum: ["stdout", "stderr"] },
      chunkSequence: { $ref: "#/$defs/sequence" },
      truncated: { type: "boolean" },
      executionContinued: { type: "boolean" },
      omittedBytes: { $ref: "#/$defs/byteSize" },
      byteLength: { $ref: "#/$defs/byteSize" },
      artifactDigest: { $ref: "#/$defs/digest" },
    },
  },
  "workspace.checkpointed": {
    $defs: DEFS,
    type: "object",
    required: ["revisionId", "requestKey"],
    additionalProperties: false,
    properties: {
      revisionId: { $ref: "#/$defs/identifier" },
      requestKey: { $ref: "#/$defs/requestKey" },
      parentRevisionId: { $ref: "#/$defs/identifier" },
      fileCount: { $ref: "#/$defs/byteSize" },
      totalBytes: { $ref: "#/$defs/byteSize" },
      exclusions: { type: "array", items: { type: "string", minLength: 1, maxLength: 512 } },
    },
  },
  "workspace.proposed": {
    $defs: DEFS,
    type: "object",
    required: ["proposalId", "baseRevisionId", "candidateRevisionId"],
    additionalProperties: false,
    properties: {
      proposalId: { $ref: "#/$defs/identifier" },
      baseRevisionId: { $ref: "#/$defs/identifier" },
      candidateRevisionId: { $ref: "#/$defs/identifier" },
      operationIds: { type: "array", items: { $ref: "#/$defs/identifier" } },
    },
  },
  "workspace.accepted": {
    $defs: DEFS,
    type: "object",
    required: ["proposalId", "revisionId"],
    additionalProperties: false,
    properties: {
      proposalId: { $ref: "#/$defs/identifier" },
      revisionId: { $ref: "#/$defs/identifier" },
      previousHeadRevisionId: { $ref: "#/$defs/identifier" },
    },
  },
  "resource.invalidated": {
    $defs: DEFS,
    type: "object",
    required: ["resourceId", "reason"],
    additionalProperties: false,
    properties: {
      resourceId: { $ref: "#/$defs/identifier" },
      reason: { type: "string", minLength: 1, maxLength: 512 },
      ownerGeneration: { $ref: "#/$defs/generation" },
      attachmentId: { $ref: "#/$defs/identifier" },
    },
  },
  "resource.rebound": {
    $defs: DEFS,
    type: "object",
    required: ["resourceId", "ownerAttachmentId", "ownerGeneration"],
    additionalProperties: false,
    properties: {
      resourceId: { $ref: "#/$defs/identifier" },
      ownerAttachmentId: { $ref: "#/$defs/identifier" },
      ownerGeneration: { $ref: "#/$defs/generation" },
      previousOwnerGeneration: { $ref: "#/$defs/generation" },
    },
  },
  "handoff.updated": {
    $defs: DEFS,
    type: "object",
    required: ["transitionId", "phase"],
    additionalProperties: false,
    properties: {
      transitionId: { $ref: "#/$defs/identifier" },
      phase: { type: "string", minLength: 1, maxLength: 64 },
      outcome: { enum: ["completed", "failed", "aborted"] },
      oldGeneration: { $ref: "#/$defs/generation" },
      newGeneration: { $ref: "#/$defs/generation" },
      detail: { type: "string", maxLength: 2048 },
    },
  },
  "cleanup.pending": {
    $defs: DEFS,
    type: "object",
    required: ["cleanupId", "kind", "targetId"],
    additionalProperties: false,
    properties: {
      cleanupId: { $ref: "#/$defs/identifier" },
      kind: { enum: ["release", "unresolved-allocation", "other"] },
      targetId: { $ref: "#/$defs/identifier" },
      detail: { type: "string", maxLength: 2048 },
      attempts: { $ref: "#/$defs/sequence" },
    },
  },
};

/** Every required event type has a payload contract. */
export const EVENT_TYPES_WITH_PAYLOADS: readonly EventTypeName[] = EVENT_TYPES;

/** Validate one event payload against its type contract. */
export function validateEventPayload(
  type: string,
  data: unknown,
): ValidationIssue[] {
  const schema = EVENT_PAYLOAD_SCHEMAS[type as EventTypeName];
  if (schema === undefined) {
    // Extension event types carry opaque payloads.
    return [];
  }
  return validateAgainstSchema(schema, data);
}
