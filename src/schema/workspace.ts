import {
  DEFS,
  type Extensions,
  type Identifier,
  type Sha256Hex,
  type UtcTimestamp,
} from "./defs.js";
import type { AttachmentRef } from "./session.js";

/** Workspace access mode for an attached environment (SPEC.md section 6.4). */
export type WorkspaceMode = "read-only" | "proposal";

/**
 * Immutable workspace tree revision (SPEC.md section 11.1).
 *
 * Revision identifiers are opaque. `rootHash` establishes tree integrity.
 */
export interface WorkspaceRevision {
  id: Identifier;
  workspaceId: Identifier;
  parentId?: Identifier;
  rootHash: Sha256Hex;
  createdAt: UtcTimestamp;
  extensions?: Extensions;
}

export const workspaceRevisionSchema = {
  $id: "https://portable.dev/schema/workspace-revision.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "workspaceId", "rootHash", "createdAt"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    workspaceId: { $ref: "#/$defs/identifier" },
    parentId: { $ref: "#/$defs/identifier" },
    rootHash: { $ref: "#/$defs/digest" },
    createdAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Candidate revision pending acceptance (SPEC.md section 11.1).
 *
 * Private working copies produce proposals. Acceptance compares the current
 * head with the base revision in one transaction.
 */
export interface WorkspaceProposal {
  id: Identifier;
  baseRevisionId: Identifier;
  candidateRevisionId: Identifier;
  source: AttachmentRef;
  operationIds: string[];
  extensions?: Extensions;
}

export const workspaceProposalSchema = {
  $id: "https://portable.dev/schema/workspace-proposal.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "baseRevisionId", "candidateRevisionId", "source", "operationIds"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    baseRevisionId: { $ref: "#/$defs/identifier" },
    candidateRevisionId: { $ref: "#/$defs/identifier" },
    source: { $ref: "https://portable.dev/schema/attachment-ref.json" },
    operationIds: { type: "array", items: { $ref: "#/$defs/identifier" } },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * One materialized copy of a revision (SPEC.md sections 11.1 and 11.3).
 *
 * A `read-only` copy is a snapshot: its bytes are written without
 * write permission. A `proposal` copy is private and mutable; it
 * reaches the authoritative head only through an accepted proposal,
 * never through the bridge.
 */
export interface WorkingCopyRecord {
  id: Identifier;
  sessionId: Identifier;
  baseRevisionId: Identifier;
  rootPath: string;
  mode: WorkspaceMode;
  createdAt: UtcTimestamp;
}

export const workingCopyRecordSchema = {
  $id: "https://portable.dev/schema/working-copy-record.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "sessionId", "baseRevisionId", "rootPath", "mode", "createdAt"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    sessionId: { $ref: "#/$defs/identifier" },
    baseRevisionId: { $ref: "#/$defs/identifier" },
    rootPath: { type: "string", minLength: 1, maxLength: 4096 },
    mode: { enum: ["read-only", "proposal"] },
    createdAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Source of a checkpoint: a managed copy or the local bridge. */
export type CheckpointSource =
  | { kind: "attachment"; attachment: AttachmentRef }
  | { kind: "bridge"; rootPath: string };

/**
 * Request for `Session.checkpoint()` (SPEC.md section 15).
 *
 * `expectedHead` is mandatory after the first import: a later checkpoint
 * requires the expected workspace head (SPEC.md section 11.4).
 */
export interface CheckpointRequest {
  requestKey: string;
  source: CheckpointSource;
  expectedHead?: Identifier;
  exclusions?: string[];
  extensions?: Extensions;
}

export const checkpointRequestSchema = {
  $id: "https://portable.dev/schema/checkpoint-request.json",
  $defs: DEFS,
  type: "object",
  required: ["requestKey", "source"],
  additionalProperties: false,
  properties: {
    requestKey: { $ref: "#/$defs/requestKey" },
    source: {
      anyOf: [
        {
          type: "object",
          required: ["kind", "attachment"],
          additionalProperties: false,
          properties: {
            kind: { const: "attachment" },
            attachment: { $ref: "https://portable.dev/schema/attachment-ref.json" },
          },
        },
        {
          type: "object",
          required: ["kind", "rootPath"],
          additionalProperties: false,
          properties: {
            kind: { const: "bridge" },
            rootPath: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
      ],
    },
    expectedHead: { $ref: "#/$defs/identifier" },
    exclusions: { type: "array", items: { type: "string", minLength: 1, maxLength: 512 } },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
