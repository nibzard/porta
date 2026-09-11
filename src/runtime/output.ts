import { createHash } from "node:crypto";
import { integrityFailureError, invalidRequestError } from "../core/errors.js";
import type { Extensions } from "../schema/defs.js";
import type { ArtifactRecord, OperationRecord, OutputChunk } from "../schema/operation.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";
import type { BlobStore } from "../store/blob-store.js";

/**
 * Streamed output and result artifacts (SPEC.md section 9.3).
 *
 * Output chunks keep standard output and standard error separate, and
 * each stream numbers its own chunks in durable sequence order. Content
 * moves as base64, so binary output survives every hop; truncation
 * reports the omitted byte count when known and whether execution
 * continued.
 *
 * Large or binary results become content-addressed artifacts: the bytes
 * land in the blob store, and the artifact record carries digest, byte
 * size, media type, and an authorized retrieval location that holds no
 * credential.
 */

/** Input of one output or artifact call. */
export interface OutputOptions {
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** The content one new chunk carries. */
export interface ChunkInput {
  stream: "stdout" | "stderr";
  /** Bytes of the chunk, or UTF-8 text; the store keeps base64. */
  data: Uint8Array | string;
  truncated: boolean;
  /** Bytes the provider dropped, when it knows the count. */
  omittedBytes?: number;
  executionContinued: boolean;
  extensions?: Extensions;
}

/** The artifact one operation produced. */
export interface ArtifactInput {
  /** Raw bytes of the artifact. */
  data: Uint8Array | string;
  /** Media type of the bytes, for example `application/json`. */
  mediaType: string;
  /** The encoding of `data` when it is a string. Default `utf-8`. */
  encoding?: "utf-8" | "base64";
}

/**
 * Record one chunk of one operation's output (SPEC.md 9.3).
 *
 * The chunk and its journal event commit in one transaction, and the
 * store assigns the next sequence of the chunk's own stream, so order
 * within a stream is preserved. Standard output and standard error
 * never mix, and binary content moves as bytes, encoded once here.
 */
export function recordOutputChunk(
  store: ControlStore,
  sessionId: string,
  operationId: string,
  input: ChunkInput,
  options: OutputOptions = {},
): OutputChunk {
  const dataBase64 = encodeChunk(input);
  try {
    return store.transaction(() => {
      requireOperation(store, sessionId, operationId);
      const chunk = store.appendOutputChunk({
        operationId,
        stream: input.stream,
        dataBase64,
        truncated: input.truncated,
        ...(input.omittedBytes !== undefined ? { omittedBytes: input.omittedBytes } : {}),
        executionContinued: input.executionContinued,
        ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
      });
      const stream = new SessionEventStream(store, sessionId, options.redactor);
      stream.append("operation.output", operationId, {
        operationId,
        stream: chunk.stream,
        chunkSequence: chunk.sequence,
        truncated: chunk.truncated,
        executionContinued: chunk.executionContinued,
        byteLength: Buffer.from(chunk.dataBase64, "base64").byteLength,
        ...(chunk.omittedBytes !== undefined ? { omittedBytes: chunk.omittedBytes } : {}),
      });
      return chunk;
    });
  } catch (error) {
    throw portable(error);
  }
}

/**
 * Read one stream of one operation after a sequence
 * (SPEC.md section 18.1).
 *
 * Chunks return in sequence order; consumers resume by sequence and
 * tolerate duplicate delivery.
 */
export function readOutputStream(
  store: ControlStore,
  sessionId: string,
  operationId: string,
  stream: "stdout" | "stderr",
  afterSequence = 0,
  limit?: number,
): OutputChunk[] {
  requireOperation(store, sessionId, operationId);
  return store.listOutputChunks(operationId, stream, afterSequence, limit);
}

/**
 * Record one content-addressed artifact of one operation
 * (SPEC.md section 9.3).
 *
 * The bytes land in the blob store first, so the artifact record always
 * names content that is durably present. The retrieval location is a
 * bare digest reference — it carries no credential — and reading the
 * artifact verifies the bytes against the recorded digest and size.
 */
export function recordResultArtifact(
  store: ControlStore,
  blobs: BlobStore,
  sessionId: string,
  operationId: string,
  input: ArtifactInput,
): ArtifactRecord {
  requireOperation(store, sessionId, operationId);
  const data = decodeArtifact(input);
  const stored = blobs.put(data);
  const record: ArtifactRecord = {
    digest: stored.digest,
    sizeBytes: stored.sizeBytes,
    mediaType: input.mediaType,
    retrieval: {
      kind: "artifact-store",
      location: `blob:sha256:${stored.digest}`,
    },
  };
  try {
    return store.insertArtifact(sessionId, record, operationId);
  } catch (error) {
    throw portable(error);
  }
}

/**
 * Read one artifact of a session with its bytes.
 *
 * The stored bytes must hash to the recorded digest and match the
 * recorded size; anything else is an integrity failure, not a quiet
 * return of different content.
 */
export function readArtifact(
  store: ControlStore,
  blobs: BlobStore,
  sessionId: string,
  digest: string,
): { record: ArtifactRecord; data: Uint8Array } {
  const record = store.getArtifact(sessionId, digest);
  if (record === null) {
    throw invalidRequestError(`Artifact ${digest} does not exist in this session.`, {
      digest,
    });
  }
  const data = blobs.get(record.digest);
  if (data === null) {
    throw integrityFailureError(`artifact ${record.digest}`, record.digest, "absent");
  }
  if (data.byteLength !== record.sizeBytes) {
    throw integrityFailureError(`artifact ${record.digest}`, `${record.sizeBytes} bytes`, `${data.byteLength} bytes`);
  }
  const hashed = createHash("sha256").update(data).digest("hex");
  if (hashed !== record.digest) {
    throw integrityFailureError(`artifact ${record.digest}`, record.digest, hashed);
  }
  return { record, data };
}

// -- Internals ----------------------------------------------------------------

/** Encode one chunk's content as base64: bytes pass through, text is UTF-8. */
function encodeChunk(input: ChunkInput): string {
  const bytes =
    typeof input.data === "string" ? Buffer.from(input.data, "utf-8") : Buffer.from(input.data);
  return bytes.toString("base64");
}

/** Decode one artifact's content to its bytes. */
function decodeArtifact(input: ArtifactInput): Uint8Array {
  if (typeof input.data !== "string") {
    return input.data;
  }
  if (input.encoding === "base64") {
    const data = Buffer.from(input.data, "base64");
    if (input.data.length > 0 && data.toString("base64").replace(/=+$/, "") !== input.data.replace(/=+$/, "")) {
      throw invalidRequestError("The artifact content is not valid base64.", {
        reason: "invalid-encoding",
      });
    }
    return data;
  }
  return Buffer.from(input.data, "utf-8");
}

/** Load one operation of this session or refuse. */
function requireOperation(
  store: ControlStore,
  sessionId: string,
  operationId: string,
): OperationRecord {
  const record = store.getOperation(operationId);
  if (record === null || record.attachment.sessionId !== sessionId) {
    throw invalidRequestError(`Operation ${operationId} does not exist in this session.`, {
      operationId,
    });
  }
  return record;
}

/** Convert store failures to their Portable form; pass the rest through. */
function portable(error: unknown): unknown {
  if (error instanceof StoreError) {
    return error.toPortableError();
  }
  return error;
}
