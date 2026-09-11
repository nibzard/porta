import {
  DEFS,
  type Extensions,
  type Identifier,
} from "./defs.js";

/** Error codes required by SPEC.md section 18.2. */
export const PORTABLE_ERROR_CODES = [
  "InvalidRequest",
  "RequirementUnsatisfied",
  "AmbiguousEnvironment",
  "PolicyDenied",
  "UnsupportedOperation",
  "StaleHandle",
  "LeaseExpired",
  "WorkspaceConflict",
  "WorkspaceUnstable",
  "IntegrityFailure",
  "RequestConflict",
  "OperationUnknown",
  "HandoffBlocked",
  "ProviderUnavailable",
  "CleanupPending",
] as const;

export type PortableErrorCode = (typeof PORTABLE_ERROR_CODES)[number];

/** Retry classification for a failure (SPEC.md section 18.2). */
export type RetryClassification = "safe" | "after-reconciliation" | "never";

/**
 * Structured Portable error.
 *
 * Errors distinguish invalid input, policy denial, unsupported semantics, and
 * temporary provider failure. An error MUST NOT expose credentials.
 */
export interface PortableError {
  code: PortableErrorCode | (string & {});
  message: string;
  retry: RetryClassification;
  operationId?: Identifier;
  details?: Record<string, unknown>;
  extensions?: Extensions;
}

export const portableErrorSchema = {
  $id: "https://portable.dev/schema/error.json",
  $defs: DEFS,
  type: "object",
  required: ["code", "message", "retry"],
  additionalProperties: false,
  properties: {
    code: {
      // The required codes are always allowed. Additional codes MUST contain
      // a domain namespace segment so they cannot collide with core codes.
      anyOf: [
        { enum: PORTABLE_ERROR_CODES },
        { type: "string", pattern: "^[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)+$" },
      ],
    },
    message: { type: "string", minLength: 1, maxLength: 2048 },
    retry: { enum: ["safe", "after-reconciliation", "never"] },
    operationId: { $ref: "#/$defs/identifier" },
    details: { $ref: "#/$defs/jsonObject" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
