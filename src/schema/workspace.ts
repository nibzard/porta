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

/**
 * Durable record of one proposal (SPEC.md sections 4 and 11.3).
 *
 * A proposal is a candidate revision offered by one private working
 * copy through its attachment. It becomes authoritative only through
 * `acceptProposal`, which compares the current head with the base
 * revision in one transaction.
 */
export type ProposalStatus = "open" | "accepted";

export interface ProposalRecord {
  id: Identifier;
  sessionId: Identifier;
  /** Deduplication key of the proposing call. */
  requestKey: string;
  /** The private working copy the candidate was read from. */
  copyId: Identifier;
  baseRevisionId: Identifier;
  candidateRevisionId: Identifier;
  /** The attachment whose generation produced the candidate. */
  source: AttachmentRef;
  /** Operations recorded as provenance of the candidate. */
  operationIds: Identifier[];
  /** Deduplication hash of the proposing call's identity. */
  inputHash: string;
  status: ProposalStatus;
  createdAt: UtcTimestamp;
  extensions?: Extensions;
}

export const proposalRecordSchema = {
  $id: "https://portable.dev/schema/proposal-record.json",
  $defs: DEFS,
  type: "object",
  required: [
    "id",
    "sessionId",
    "requestKey",
    "copyId",
    "baseRevisionId",
    "candidateRevisionId",
    "source",
    "operationIds",
    "inputHash",
    "status",
    "createdAt",
  ],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    sessionId: { $ref: "#/$defs/identifier" },
    requestKey: { $ref: "#/$defs/requestKey" },
    copyId: { $ref: "#/$defs/identifier" },
    baseRevisionId: { $ref: "#/$defs/identifier" },
    candidateRevisionId: { $ref: "#/$defs/identifier" },
    source: { $ref: "https://portable.dev/schema/attachment-ref.json" },
    operationIds: { type: "array", items: { $ref: "#/$defs/identifier" } },
    inputHash: { $ref: "#/$defs/digest" },
    status: { enum: ["open", "accepted"] },
    createdAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Request for `Session.propose()` (SPEC.md sections 11.3 and 11.5).
 *
 * `attachment` names the attachment whose environment owns the copy.
 * Its generation is checked again at acceptance: a proposal from a
 * replaced generation cannot accept workspace changes.
 */
export interface ProposalRequest {
  requestKey: string;
  copyId: Identifier;
  attachment: AttachmentRef;
  operationIds?: Identifier[];
  exclusions?: string[];
  extensions?: Extensions;
}

export const proposalRequestSchema = {
  $id: "https://portable.dev/schema/proposal-request.json",
  $defs: DEFS,
  type: "object",
  required: ["requestKey", "copyId", "attachment"],
  additionalProperties: false,
  properties: {
    requestKey: { $ref: "#/$defs/requestKey" },
    copyId: { $ref: "#/$defs/identifier" },
    attachment: { $ref: "https://portable.dev/schema/attachment-ref.json" },
    operationIds: { type: "array", items: { $ref: "#/$defs/identifier" } },
    exclusions: { type: "array", items: { type: "string", minLength: 1, maxLength: 512 } },
    extensions: { $ref: "#/$defs/extensions" },
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

// -- Execution provenance (SPEC.md section 11.5) --------------------------------

/** How one tracked path changed between a run's input and output trees. */
export type TrackedPathChangeKind = "added" | "removed" | "modified";

/** One tracked path a run changed, as the output tree proves. */
export interface TrackedPathChange {
  path: string;
  change: TrackedPathChangeKind;
}

/**
 * What one workspace-backed execution actually ran against
 * (SPEC.md section 11.5).
 *
 * Every workspace-backed invocation records its base revision and working
 * copy. Verification runs add the tested revision, input and output tree
 * hashes, and the tracked paths the run changed. The record describes
 * what ran; it never promises identical results across providers.
 */
export interface ExecutionProvenance {
  operationId: Identifier;
  sessionId: Identifier;
  attachment: AttachmentRef;
  capability: string;
  operation: string;
  /** The command's arguments as dispatched. */
  arguments: unknown;
  /** Revision the working copy was based on. */
  baseRevisionId: Identifier;
  /** Working copy the command ran against. */
  workingCopyId: Identifier;
  /**
   * Revision the run actually tested: the base revision when the copy
   * was clean, otherwise the pre-run checkpoint. Present when measured.
   */
  testedRevisionId?: Identifier;
  /** `true` when the copy differed from its base at capture time. */
  copyModified?: boolean;
  /** Private copy the verification ran in, excluding unrelated writers. */
  verificationCopyId?: Identifier;
  /** Tree hash of the verification input. */
  inputRootHash?: Sha256Hex;
  /** Tree hash of the verification output. */
  outputRootHash?: Sha256Hex;
  /** Tracked paths the run changed. */
  changedPaths?: TrackedPathChange[];
  /** Version of the adapter that executed. */
  adapterVersion?: string;
  /** Digest of the environment manifest. */
  manifestDigest?: Sha256Hex;
  /** Available dependency identifiers. */
  dependencyIds?: string[];
  /** Available image identifier. */
  imageId?: string;
  capturedAt: UtcTimestamp;
  /** When the output hash and tracked changes were measured. */
  settledAt?: UtcTimestamp;
}

const trackedPathChangeSchema = {
  type: "object",
  required: ["path", "change"],
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1, maxLength: 1024 },
    change: { enum: ["added", "removed", "modified"] },
  },
};

const provenanceIdentityProperties = {
  operationId: { $ref: "#/$defs/identifier" },
  attachment: { $ref: "https://portable.dev/schema/attachment-ref.json" },
  capability: { $ref: "#/$defs/capabilityId" },
  operation: { $ref: "#/$defs/operationName" },
  arguments: { $ref: "#/$defs/jsonValue" },
  workingCopyId: { $ref: "#/$defs/identifier" },
};

export const executionProvenanceSchema = {
  $id: "https://portable.dev/schema/execution-provenance.json",
  $defs: DEFS,
  type: "object",
  required: [
    "operationId",
    "sessionId",
    "attachment",
    "capability",
    "operation",
    "arguments",
    "baseRevisionId",
    "workingCopyId",
    "capturedAt",
  ],
  additionalProperties: false,
  properties: {
    ...provenanceIdentityProperties,
    sessionId: { $ref: "#/$defs/identifier" },
    baseRevisionId: { $ref: "#/$defs/identifier" },
    testedRevisionId: { $ref: "#/$defs/identifier" },
    copyModified: { type: "boolean" },
    verificationCopyId: { $ref: "#/$defs/identifier" },
    inputRootHash: { $ref: "#/$defs/digest" },
    outputRootHash: { $ref: "#/$defs/digest" },
    changedPaths: { type: "array", maxItems: 65536, items: trackedPathChangeSchema },
    adapterVersion: { type: "string", minLength: 1, maxLength: 64 },
    manifestDigest: { $ref: "#/$defs/digest" },
    dependencyIds: {
      type: "array",
      maxItems: 1024,
      items: { type: "string", minLength: 1, maxLength: 512 },
    },
    imageId: { type: "string", minLength: 1, maxLength: 512 },
    capturedAt: { $ref: "#/$defs/timestamp" },
    settledAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Request that associates one invocation with its workspace context. */
export interface ProvenanceCaptureRequest {
  operationId: Identifier;
  attachment: AttachmentRef;
  capability: string;
  operation: string;
  arguments: unknown;
  workingCopyId: Identifier;
}

export const provenanceCaptureRequestSchema = {
  $id: "https://portable.dev/schema/provenance-capture-request.json",
  $defs: DEFS,
  type: "object",
  required: ["operationId", "attachment", "capability", "operation", "arguments", "workingCopyId"],
  additionalProperties: false,
  properties: provenanceIdentityProperties,
} as const;

/** Request that measures one verification run's output. */
export interface ProvenanceSettleRequest {
  operationId: Identifier;
  attachment: AttachmentRef;
}

export const provenanceSettleRequestSchema = {
  $id: "https://portable.dev/schema/provenance-settle-request.json",
  $defs: DEFS,
  type: "object",
  required: ["operationId", "attachment"],
  additionalProperties: false,
  properties: {
    operationId: { $ref: "#/$defs/identifier" },
    attachment: { $ref: "https://portable.dev/schema/attachment-ref.json" },
  },
} as const;
