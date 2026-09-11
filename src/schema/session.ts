import {
  DEFS,
  type AttachmentName,
  type CapabilityId,
  type Extensions,
  type Identifier,
  type UtcTimestamp,
} from "./defs.js";

/** Session lifecycle status (SPEC.md section 5.1). */
export type SessionStatus = "open" | "closing" | "closed";

/**
 * Durable session record (SPEC.md section 5.1).
 *
 * Reopening restores metadata and reconciles leases. It does not restore a
 * harness conversation.
 */
export interface SessionRecord {
  id: Identifier;
  schemaVersion: 1;
  status: SessionStatus;
  workspaceId: Identifier;
  eventSequence: number;
  policyRef: string;
  createdAt: UtcTimestamp;
  extensions?: Extensions;
}

export const sessionRecordSchema = {
  $id: "https://portable.dev/schema/session-record.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "schemaVersion", "status", "workspaceId", "eventSequence", "policyRef", "createdAt"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    schemaVersion: { $ref: "#/$defs/schemaVersion" },
    status: { enum: ["open", "closing", "closed"] },
    workspaceId: { $ref: "#/$defs/identifier" },
    eventSequence: { $ref: "#/$defs/sequence" },
    policyRef: { type: "string", minLength: 1, maxLength: 512 },
    createdAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Reference to the current binding of one attachment (SPEC.md section 5.1). */
export interface AttachmentRef {
  sessionId: Identifier;
  attachmentId: Identifier;
  generation: number;
}

export const attachmentRefSchema = {
  $id: "https://portable.dev/schema/attachment-ref.json",
  $defs: DEFS,
  type: "object",
  required: ["sessionId", "attachmentId", "generation"],
  additionalProperties: false,
  properties: {
    sessionId: { $ref: "#/$defs/identifier" },
    attachmentId: { $ref: "#/$defs/identifier" },
    generation: { $ref: "#/$defs/generation" },
  },
} as const;

/** Attachment lifecycle states (SPEC.md section 8.1). */
export type AttachmentStatus =
  | "acquiring"
  | "active"
  | "replacing"
  | "releasing"
  | "released"
  | "failed"
  | "unavailable";

/** Inspection summary for one attachment. */
export interface AttachmentSummary {
  sessionId: Identifier;
  attachmentId: Identifier;
  name: AttachmentName;
  generation: number;
  status: AttachmentStatus;
  environmentId?: Identifier;
  providerId?: Identifier;
  capabilityIds: CapabilityId[];
  leaseExpiresAt?: UtcTimestamp;
  extensions?: Extensions;
}

export const attachmentSummarySchema = {
  $id: "https://portable.dev/schema/attachment-summary.json",
  $defs: DEFS,
  type: "object",
  required: ["sessionId", "attachmentId", "name", "generation", "status", "capabilityIds"],
  additionalProperties: false,
  properties: {
    sessionId: { $ref: "#/$defs/identifier" },
    attachmentId: { $ref: "#/$defs/identifier" },
    name: { $ref: "#/$defs/attachmentName" },
    generation: { $ref: "#/$defs/generation" },
    status: {
      enum: ["acquiring", "active", "replacing", "releasing", "released", "failed", "unavailable"],
    },
    environmentId: { $ref: "#/$defs/identifier" },
    providerId: { $ref: "#/$defs/identifier" },
    capabilityIds: { type: "array", items: { $ref: "#/$defs/capabilityId" } },
    leaseExpiresAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Result of `Session.describe()` (SPEC.md section 15). */
export interface SessionDescription {
  session: SessionRecord;
  attachments: AttachmentSummary[];
  workspace: {
    workspaceId: Identifier;
    headRevisionId?: Identifier;
  };
  /** Durable allocations whose outcome is not yet resolved. */
  unresolvedAllocations: Identifier[];
  /** Cleanup obligations that survive restart. */
  pendingCleanup: Identifier[];
  extensions?: Extensions;
}

export const sessionDescriptionSchema = {
  $id: "https://portable.dev/schema/session-description.json",
  $defs: DEFS,
  type: "object",
  required: ["session", "attachments", "workspace", "unresolvedAllocations", "pendingCleanup"],
  additionalProperties: false,
  properties: {
    session: { $ref: "https://portable.dev/schema/session-record.json" },
    attachments: { type: "array", items: { $ref: "https://portable.dev/schema/attachment-summary.json" } },
    workspace: {
      type: "object",
      required: ["workspaceId"],
      additionalProperties: false,
      properties: {
        workspaceId: { $ref: "#/$defs/identifier" },
        headRevisionId: { $ref: "#/$defs/identifier" },
      },
    },
    unresolvedAllocations: { type: "array", items: { $ref: "#/$defs/identifier" } },
    pendingCleanup: { type: "array", items: { $ref: "#/$defs/identifier" } },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Options for `Portable.createSession()` (SPEC.md section 15).
 *
 * The embedding application supplies the policy reference of the
 * authenticated authority. Model-controlled input cannot supply it.
 */
export interface SessionOptions {
  policyRef: string;
  /** Root of the local directory bridge, when used. */
  bridgeRootPath?: string;
  /** Directory for the durable control store. Defaults beside the bridge. */
  storagePath?: string;
  extensions?: Extensions;
}

export const sessionOptionsSchema = {
  $id: "https://portable.dev/schema/session-options.json",
  $defs: DEFS,
  type: "object",
  required: ["policyRef"],
  additionalProperties: false,
  properties: {
    policyRef: { type: "string", minLength: 1, maxLength: 512 },
    bridgeRootPath: { type: "string", minLength: 1 },
    storagePath: { type: "string", minLength: 1 },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
