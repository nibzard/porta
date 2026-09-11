import {
  DEFS,
  type Extensions,
  type Identifier,
  type Sha256Hex,
} from "./defs.js";
import type { PortableError } from "./error.js";
import type { AttachmentRef } from "./session.js";

/** Operation status values (SPEC.md section 9.2). */
export type OperationStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

/**
 * Public invocation request (SPEC.md section 9.1).
 *
 * The pair `(sessionId, requestKey)` identifies one logical request for the
 * session's retention period.
 */
export interface InvocationRequest {
  attachment: AttachmentRef;
  capability: string;
  operation: string;
  input: unknown;
  requestKey: string;
  timeoutMs?: number;
  extensions?: Extensions;
}

export const invocationRequestSchema = {
  $id: "https://portable.dev/schema/invocation-request.json",
  $defs: DEFS,
  type: "object",
  required: ["attachment", "capability", "operation", "input", "requestKey"],
  additionalProperties: false,
  properties: {
    attachment: { $ref: "https://portable.dev/schema/attachment-ref.json" },
    capability: { $ref: "#/$defs/capabilityId" },
    operation: { $ref: "#/$defs/operationName" },
    input: { $ref: "#/$defs/jsonValue" },
    requestKey: { $ref: "#/$defs/requestKey" },
    timeoutMs: { $ref: "#/$defs/durationMs" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Durable operation record (SPEC.md section 9.1).
 *
 * Every invocation records its attachment generation and workspace basis
 * when one applies. `inputHash` is the SHA-256 of the canonical request
 * input; reuse of a request key with a different hash is a conflict.
 */
export interface OperationRecord {
  id: Identifier;
  attachment: AttachmentRef;
  capability: string;
  operation: string;
  inputHash: Sha256Hex;
  inputRevisionId?: Identifier;
  workingCopyId?: Identifier;
  status: OperationStatus;
  resultRef?: string;
  error?: PortableError;
  extensions?: Extensions;
}

export const operationRecordSchema = {
  $id: "https://portable.dev/schema/operation-record.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "attachment", "capability", "operation", "inputHash", "status"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    attachment: { $ref: "https://portable.dev/schema/attachment-ref.json" },
    capability: { $ref: "#/$defs/capabilityId" },
    operation: { $ref: "#/$defs/operationName" },
    inputHash: { $ref: "#/$defs/digest" },
    inputRevisionId: { $ref: "#/$defs/identifier" },
    workingCopyId: { $ref: "#/$defs/identifier" },
    status: { enum: ["accepted", "running", "completed", "failed", "cancelled", "unknown"] },
    resultRef: { type: "string", minLength: 1, maxLength: 512 },
    error: { $ref: "https://portable.dev/schema/error.json" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * One chunk of streamed output (SPEC.md section 9.3).
 *
 * Standard output and standard error stay separate. Each stream numbers its
 * own chunks. `omittedBytes` is present when known truncation occurred.
 */
export interface OutputChunk {
  operationId: Identifier;
  stream: "stdout" | "stderr";
  sequence: number;
  /** Base64 payload for binary-safe transfer. */
  dataBase64: string;
  truncated: boolean;
  omittedBytes?: number;
  executionContinued: boolean;
  extensions?: Extensions;
}

export const outputChunkSchema = {
  $id: "https://portable.dev/schema/output-chunk.json",
  $defs: DEFS,
  type: "object",
  required: ["operationId", "stream", "sequence", "dataBase64", "truncated", "executionContinued"],
  additionalProperties: false,
  properties: {
    operationId: { $ref: "#/$defs/identifier" },
    stream: { enum: ["stdout", "stderr"] },
    sequence: { $ref: "#/$defs/sequence" },
    dataBase64: { type: "string", minLength: 0 },
    truncated: { type: "boolean" },
    omittedBytes: { $ref: "#/$defs/byteSize" },
    executionContinued: { type: "boolean" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/**
 * Content-addressed artifact record (SPEC.md section 9.3).
 *
 * Includes digest, byte size, media type, and an authorized retrieval
 * location. The location reference carries no embedded credential.
 */
export interface ArtifactRecord {
  digest: Sha256Hex;
  sizeBytes: number;
  mediaType: string;
  retrieval: {
    kind: "inline" | "artifact-store" | "authorized-reference";
    location: string;
  };
  extensions?: Extensions;
}

export const artifactRecordSchema = {
  $id: "https://portable.dev/schema/artifact-record.json",
  $defs: DEFS,
  type: "object",
  required: ["digest", "sizeBytes", "mediaType", "retrieval"],
  additionalProperties: false,
  properties: {
    digest: { $ref: "#/$defs/digest" },
    sizeBytes: { $ref: "#/$defs/byteSize" },
    mediaType: { type: "string", minLength: 1, maxLength: 255 },
    retrieval: {
      type: "object",
      required: ["kind", "location"],
      additionalProperties: false,
      properties: {
        kind: { enum: ["inline", "artifact-store", "authorized-reference"] },
        location: { type: "string", minLength: 1, maxLength: 2048 },
      },
    },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
