import { validateAgainstSchema, ValidationError } from "../schema/validate.js";
import {
  PORTABLE_ERROR_CODES,
  portableErrorSchema,
  type PortableError,
  type PortableErrorCode,
  type RetryClassification,
} from "../schema/error.js";

/**
 * Failure categories for the required error codes (SPEC.md section 18.2).
 *
 * Errors MUST distinguish invalid input, policy denial, unsupported
 * semantics, and temporary provider failure. The extra categories separate
 * state, integrity, uncertainty, cleanup, and conflict failures.
 */
export type FailureCategory =
  | "input"
  | "policy"
  | "semantic"
  | "provider"
  | "state"
  | "conflict"
  | "integrity"
  | "uncertainty"
  | "cleanup";

/** Stable metadata for one required error code. */
export interface ErrorSpec {
  category: FailureCategory;
  defaultRetry: RetryClassification;
  description: string;
}

/**
 * Taxonomy of every required code. The retry value is the default; callers
 * may override it when context demands a stricter answer.
 */
export const ERROR_TAXONOMY: Record<PortableErrorCode, ErrorSpec> = {
  InvalidRequest: {
    category: "input",
    defaultRetry: "never",
    description: "The request is malformed or fails validation.",
  },
  RequirementUnsatisfied: {
    category: "semantic",
    defaultRetry: "never",
    description: "No configured environment satisfies the stated requirements.",
  },
  AmbiguousEnvironment: {
    category: "semantic",
    defaultRetry: "never",
    description: "Multiple environments match and no provider was selected.",
  },
  PolicyDenied: {
    category: "policy",
    defaultRetry: "never",
    description: "The authenticated policy does not permit the request.",
  },
  UnsupportedOperation: {
    category: "semantic",
    defaultRetry: "never",
    description: "The capability does not offer the requested semantics.",
  },
  StaleHandle: {
    category: "state",
    defaultRetry: "never",
    description: "The handle names a generation that is no longer current.",
  },
  LeaseExpired: {
    category: "state",
    defaultRetry: "after-reconciliation",
    description: "The lease authorizing the mutation or invocation expired.",
  },
  WorkspaceConflict: {
    category: "conflict",
    defaultRetry: "never",
    description: "The workspace head moved past the expected base revision.",
  },
  WorkspaceUnstable: {
    category: "state",
    defaultRetry: "safe",
    description: "The checkpoint source changed while being read.",
  },
  IntegrityFailure: {
    category: "integrity",
    defaultRetry: "never",
    description: "Content failed a hash or integrity check.",
  },
  RequestConflict: {
    category: "input",
    defaultRetry: "never",
    description: "A request key was reused with different input.",
  },
  OperationUnknown: {
    category: "uncertainty",
    defaultRetry: "after-reconciliation",
    description: "The outcome of the operation cannot be determined.",
  },
  HandoffBlocked: {
    category: "state",
    defaultRetry: "after-reconciliation",
    description: "The replacement cannot proceed in the current phase.",
  },
  ProviderUnavailable: {
    category: "provider",
    defaultRetry: "safe",
    description: "The provider failed temporarily.",
  },
  CleanupPending: {
    category: "cleanup",
    defaultRetry: "after-reconciliation",
    description: "A durable cleanup obligation remains unresolved.",
  },
};

/** Detail keys that never appear in a serialized error. */
const SECRET_KEY_RE =
  /(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|bearer)/i;

/** High-confidence credential value shapes. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
];

const REDACTED = "[redacted]";

/** Replace credential-shaped substrings with a redaction marker. */
export function scrubStringValue(value: string): string {
  let scrubbed = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, REDACTED);
  }
  return scrubbed;
}

/**
 * Remove credentials from an arbitrary value.
 *
 * Drops object keys that name credentials. Redacts credential-shaped string
 * values. Recurses into nested objects and arrays. The check fails closed:
 * ambiguous material is removed rather than kept.
 */
export function scrubValue(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubStringValue(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) {
        continue;
      }
      out[key] = scrubValue(inner);
    }
    return out;
  }
  return value;
}

/** Options for the error factory. */
export interface PortableErrorOptions {
  retry?: RetryClassification | undefined;
  operationId?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

/**
 * Build a sanitized Portable error.
 *
 * The error is scrubbed at construction, so credentials never enter a
 * serializable error (SPEC.md section 18.2).
 */
export function portableError(
  code: PortableError["code"],
  message: string,
  options: PortableErrorOptions = {},
): PortableError {
  const spec: ErrorSpec = ERROR_TAXONOMY[code as PortableErrorCode] ?? {
    category: "semantic",
    defaultRetry: "never",
    description: "",
  };
  const error: PortableError = {
    code,
    message: scrubStringValue(message),
    retry: options.retry ?? spec.defaultRetry,
  };
  if (options.operationId !== undefined) {
    error.operationId = options.operationId;
  }
  if (options.details !== undefined) {
    error.details = scrubValue(options.details) as Record<string, unknown>;
  }
  return error;
}

/** Category of a required error code. */
export function failureCategory(code: PortableError["code"]): FailureCategory {
  return ERROR_TAXONOMY[code as PortableErrorCode]?.category ?? "semantic";
}

/** True when the failure is a temporary provider problem. */
export function isProviderFailure(error: PortableError): boolean {
  return failureCategory(error.code) === "provider";
}

/** True when the caller may retry without reconciliation. */
export function isSafeRetry(error: PortableError): boolean {
  return error.retry === "safe";
}

/** Convert a validation failure into a Portable error. */
export function invalidRequestFromValidation(failure: ValidationError): PortableError {
  return portableError("InvalidRequest", "The request failed schema validation.", {
    details: {
      issues: failure.issues.map((issue) => ({
        path: issue.instancePath || "/",
        keyword: issue.keyword,
        message: issue.message,
      })),
    },
  });
}

/** Normalize an unknown thrown value into a sanitized Portable error. */
export function toPortableError(thrown: unknown): PortableError {
  if (isPortableError(thrown)) {
    return sanitizeError(thrown);
  }
  if (thrown instanceof ValidationError) {
    return invalidRequestFromValidation(thrown);
  }
  if (thrown instanceof Error) {
    return portableError("portable.internal", thrown.message, {
      details: { name: thrown.name },
    });
  }
  return portableError("portable.internal", "An unrecognized failure occurred.", {
    details: { thrownType: typeof thrown },
  });
}

/** Whether one thrown value already carries the Portable error shape. */
export function isPortableError(value: unknown): value is PortableError {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PortableError).code === "string" &&
    typeof (value as PortableError).message === "string" &&
    typeof (value as PortableError).retry === "string"
  );
}

/**
 * Copy an error with credentials removed.
 *
 * Apply this before serializing any error that came from outside the
 * factory, such as an adapter failure.
 */
export function sanitizeError(error: PortableError): PortableError {
  const clean: PortableError = {
    code: error.code,
    message: scrubStringValue(error.message),
    retry: error.retry,
  };
  if (error.operationId !== undefined) {
    clean.operationId = error.operationId;
  }
  if (error.details !== undefined) {
    clean.details = scrubValue(error.details) as Record<string, unknown>;
  }
  if (error.extensions !== undefined) {
    clean.extensions = scrubValue(error.extensions) as Record<string, unknown>;
  }
  return clean;
}

/**
 * Serialize an error to a JSON string.
 *
 * The result validates against the Portable error schema and contains no
 * credentials.
 */
export function serializeError(error: PortableError): string {
  const clean = sanitizeError(error);
  const issues = validateAgainstSchema(portableErrorSchema, clean);
  if (issues.length > 0) {
    // A malformed error is itself invalid input; degrade to a safe form.
    return JSON.stringify(
      portableError("portable.internal", "The error record failed its own schema.", {
        details: { code: String(error.code) },
      }),
    );
  }
  return JSON.stringify(clean);
}

// ---------------------------------------------------------------------------
// Named factories for the required codes. Each returns a sanitized error
// with the taxonomy default retry classification.
// ---------------------------------------------------------------------------

export function invalidRequestError(
  message: string,
  details?: Record<string, unknown>,
): PortableError {
  return portableError("InvalidRequest", message, { details });
}

export function requirementUnsatisfiedError(
  message: string,
  details?: Record<string, unknown>,
): PortableError {
  return portableError("RequirementUnsatisfied", message, { details });
}

export function ambiguousEnvironmentError(
  message: string,
  details?: Record<string, unknown>,
): PortableError {
  return portableError("AmbiguousEnvironment", message, { details });
}

export function policyDeniedError(
  message: string,
  details?: Record<string, unknown>,
): PortableError {
  return portableError("PolicyDenied", message, { details });
}

export function unsupportedOperationError(
  capability: string,
  operation: string,
  details?: Record<string, unknown>,
): PortableError {
  return portableError(
    "UnsupportedOperation",
    `The capability ${capability} does not support the operation ${operation}.`,
    { details: { capability, operation, ...details } },
  );
}

export function staleHandleError(
  expected: { kind: string; value: unknown },
  actual: { kind: string; value: unknown },
): PortableError {
  return portableError("StaleHandle", "The handle names a state that is no longer current.", {
    details: { expected, actual },
  });
}

export function leaseExpiredError(
  subject: string,
  expiresAt: string,
): PortableError {
  return portableError("LeaseExpired", `The lease for ${subject} expired at ${expiresAt}.`, {
    details: { subject, expiresAt },
  });
}

export function workspaceConflictError(
  expectedHead: string,
  currentHead: string,
): PortableError {
  return portableError("WorkspaceConflict", "The workspace head moved past the expected base.", {
    details: { expectedHead, currentHead },
  });
}

export function workspaceUnstableError(
  message: string,
  details?: Record<string, unknown>,
): PortableError {
  return portableError("WorkspaceUnstable", message, { details });
}

export function integrityFailureError(
  subject: string,
  expected: string,
  actual: string,
): PortableError {
  return portableError("IntegrityFailure", `Integrity check failed for ${subject}.`, {
    details: { subject, expected, actual },
  });
}

export function requestConflictError(
  requestKey: string,
  message: string,
  details?: Record<string, unknown>,
): PortableError {
  return portableError("RequestConflict", message, {
    details: { requestKey, ...details },
  });
}

export function operationUnknownError(
  operationId: string,
  detail: string,
): PortableError {
  return portableError(
    "OperationUnknown",
    `The outcome of operation ${operationId} cannot be determined.`,
    { operationId, details: { detail } },
  );
}

export function handoffBlockedError(
  message: string,
  details?: Record<string, unknown>,
): PortableError {
  return portableError("HandoffBlocked", message, { details });
}

export function providerUnavailableError(
  message: string,
  details?: Record<string, unknown>,
): PortableError {
  return portableError("ProviderUnavailable", message, { details });
}

export function cleanupPendingError(
  targetId: string,
  detail: string,
): PortableError {
  return portableError("CleanupPending", detail, {
    details: { targetId },
  });
}

/** Every required code, for tests that iterate the catalog. */
export const ALL_ERROR_CODES: readonly PortableErrorCode[] = PORTABLE_ERROR_CODES;
