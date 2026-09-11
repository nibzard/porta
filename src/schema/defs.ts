/**
 * Shared JSON Schema fragments and scalar contract types.
 *
 * Schemas use JSON Schema draft 2020-12. Record schemas in sibling modules
 * embed `DEFS` under `$defs` so every schema stays self-contained.
 *
 * Identifier rules (SPEC.md section 3): identifiers are opaque strings. The
 * schemas enforce shape only. They never require a prefix and never grant
 * authority. Attachment names use `[a-z][a-z0-9_-]{0,62}`.
 */

/** Opaque Portable identifier. */
export type Identifier = string;

/** Attachment name, unique within a session. */
export type AttachmentName = string;

/** Capability identifier in `name@major` form. */
export type CapabilityId = string;

/** UTC timestamp string with an explicit `Z` suffix. */
export type UtcTimestamp = string;

/** Duration in integer milliseconds. */
export type DurationMs = number;

/** Size in integer bytes. */
export type ByteSize = number;

/** Lowercase hexadecimal SHA-256 digest. */
export type Sha256Hex = string;

/** Extension map keyed by domain namespace (SPEC.md section 20). */
export type Extensions = Record<string, unknown>;

export const ATTACHMENT_NAME_PATTERN = "^[a-z][a-z0-9_-]{0,62}$";
export const CAPABILITY_ID_PATTERN = "^[a-z0-9][a-z0-9._-]*@[0-9]+$";
export const OPERATION_NAME_PATTERN = "^[a-z][a-zA-Z0-9_-]{0,63}$";
export const TIMESTAMP_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$";
export const DIGEST_PATTERN = "^[0-9a-f]{64}$";
export const EXTENSION_KEY_PATTERN =
  "^[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)+$";
export const EVENT_NAME_PATTERN = "^[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9_-]+)+$";

/** Shared schema definitions embedded by every record schema. */
export const DEFS = {
  identifier: { type: "string", minLength: 1, maxLength: 128, pattern: "^\\S+$" },
  attachmentName: { type: "string", pattern: ATTACHMENT_NAME_PATTERN },
  capabilityId: { type: "string", pattern: CAPABILITY_ID_PATTERN },
  operationName: { type: "string", pattern: OPERATION_NAME_PATTERN },
  schemaVersion: { const: 1 },
  timestamp: {
    type: "string",
    format: "utc-timestamp",
    pattern: TIMESTAMP_PATTERN,
  },
  durationMs: { type: "integer", minimum: 0 },
  byteSize: { type: "integer", minimum: 0 },
  digest: { type: "string", pattern: DIGEST_PATTERN },
  generation: { type: "integer", minimum: 1 },
  sequence: { type: "integer", minimum: 0 },
  requestKey: { type: "string", minLength: 1, maxLength: 256, pattern: "^\\S+$" },
  jsonValue: true,
  jsonObject: { type: "object", additionalProperties: true },
  jsonSchema: { type: "object" },
  extensions: {
    type: "object",
    propertyNames: { pattern: EXTENSION_KEY_PATTERN },
    additionalProperties: true,
  },
} as const;
