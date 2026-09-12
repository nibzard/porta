import { createHash, randomUUID } from "node:crypto";
import {
  invalidRequestError,
  invalidRequestFromValidation,
  requestConflictError,
  staleHandleError,
} from "../core/errors.js";
import type { PolicyAuthority } from "../core/policy.js";
import { ValidationError, assertValid } from "../schema/validate.js";
import { invocationRequestSchema } from "../schema/operation.js";
import type { InvocationRequest, OperationRecord } from "../schema/operation.js";
import type { AttachmentSummary } from "../schema/session.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";
import { canonicalJson } from "./acquisition.js";
import { checkAttachmentAcceptsOperations } from "./lifecycle.js";
import { findBlockingRevocation, revocationDenied } from "./revocation.js";
import { requireOpenSession } from "./workspace.js";

/**
 * Invocation admission and request deduplication (SPEC.md sections
 * 5.3 and 9.1).
 *
 * Admission checks the session status, the attachment status, the
 * attachment generation, the operation policy, and the environment
 * lease in one transaction that also records the operation. A check
 * that passes outside that transaction proves nothing: a replacement
 * or release that commits in between must find the operation either
 * fully recorded or not admitted at all.
 *
 * The pair (sessionId, requestKey) names one logical request. A
 * repeated key returns the operation it created — whatever status it
 * holds — and never redispatches it. The same key offered for
 * different work — another input, capability, operation, or
 * attachment generation — is a `RequestConflict`.
 */

/** Input of one admission call. */
export interface AdmissionOptions {
  /** The policy authority in force for this call. */
  authority: PolicyAuthority;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** The outcome of one admission call. */
export interface AdmissionOutcome {
  /** The durable operation record this request owns. */
  operation: OperationRecord;
  /** `true` when an existing record already answered this request key. */
  deduplicated: boolean;
}

/**
 * Admit one invocation and record its operation durably
 * (SPEC.md sections 5.3 and 9.1).
 *
 * The checks and the insert commit in one transaction, so admission
 * is atomic against replacement preparation and release: both run
 * their own transactions, and the control store serializes writers.
 * On success the operation is `accepted` — recorded before any
 * dispatch — with its request key and input hash persisted.
 */
export function admitInvocation(
  store: ControlStore,
  sessionId: string,
  request: InvocationRequest,
  options: AdmissionOptions,
): AdmissionOutcome {
  assertRequest(request, sessionId);
  const inputHash = hashOf(request.input);

  // A request key that already owns a record answers without touching
  // the control state: no new checks run, no dispatch may follow.
  const settled = store.getOperationByRequestKey(sessionId, request.requestKey);
  if (settled !== null) {
    return deduplicated(settled, request, inputHash);
  }

  try {
    return store.transaction(() => admitLocked(store, sessionId, request, options, inputHash));
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/** Check everything and insert the record, inside one transaction. */
function admitLocked(
  store: ControlStore,
  sessionId: string,
  request: InvocationRequest,
  options: AdmissionOptions,
  inputHash: string,
): AdmissionOutcome {
  // The session must accept new work; `closing` refuses here, and the
  // check runs inside the transaction so a closing commit cannot land
  // between the check and the insert.
  requireOpenSession(store, sessionId);
  const attachment = requireAttachment(store, sessionId, request.attachment.attachmentId);

  // Attachment status and environment lease validity (SPEC.md 5.3).
  const refused = checkAttachmentAcceptsOperations(attachment);
  if (refused !== null) {
    throw refused;
  }
  if (attachment.status !== "active") {
    // `acquiring` holds no environment yet; `replacing` and
    // `releasing` block new admissions while they resolve active work.
    throw invalidRequestError(
      `Attachment ${attachment.attachmentId} is ${attachment.status}; it accepts no new operations.`,
      {
        attachmentId: attachment.attachmentId,
        status: attachment.status,
        reason: `attachment-${attachment.status}`,
      },
    );
  }

  // The generation the caller holds must be the generation that is
  // current right now; a replacement moved it otherwise.
  if (attachment.generation !== request.attachment.generation) {
    throw staleHandleError(
      { kind: "attachment-generation", value: request.attachment.generation },
      { kind: "attachment-generation", value: attachment.generation },
    );
  }

  // The attachment must offer the capability the request names.
  if (!attachment.capabilityIds.includes(request.capability)) {
    throw invalidRequestError(
      `Attachment ${attachment.attachmentId} does not offer ${request.capability}.`,
      {
        attachmentId: attachment.attachmentId,
        capability: request.capability,
        reason: "capability-not-offered",
      },
    );
  }

  // The operation must sit inside the operations allow list.
  const denied = options.authority.checkOperation(request.capability, request.operation);
  if (denied !== null) {
    throw denied;
  }

  // A committed revocation blocks this admission from its commit onward;
  // the check runs inside the transaction, so no window separates the
  // revocation commit from the block (SPEC.md section 7).
  const target = {
    capability: request.capability,
    operation: request.operation,
    ...(attachment.providerId !== undefined ? { providerId: attachment.providerId } : {}),
  };
  const blocking = findBlockingRevocation(store, sessionId, target);
  if (blocking !== null) {
    throw revocationDenied(blocking, target);
  }

  // Another admission may have committed this key while this call ran
  // its checks; the transaction re-read settles the race.
  const raced = store.getOperationByRequestKey(sessionId, request.requestKey);
  if (raced !== null) {
    return deduplicated(raced, request, inputHash);
  }

  const record: OperationRecord = {
    id: `op-${randomUUID()}`,
    attachment: { ...request.attachment },
    capability: request.capability,
    operation: request.operation,
    inputHash,
    status: "accepted",
    ...(request.extensions !== undefined ? { extensions: request.extensions } : {}),
  };
  store.insertOperation(record, request.requestKey);
  const stream = new SessionEventStream(store, sessionId, options.redactor);
  stream.append("operation.updated", record.id, {
    operationId: record.id,
    status: "accepted",
    requestKey: request.requestKey,
  });
  return { operation: record, deduplicated: false };
}

/** The shared answer of one request key that already owns a record. */
function deduplicated(
  existing: OperationRecord,
  request: InvocationRequest,
  inputHash: string,
): AdmissionOutcome {
  // One request key names one piece of work. The input hash alone does
  // not identify work: the same bytes under another capability,
  // operation, or attachment are different work, so the whole
  // invocation identity must match (SPEC.md section 9.1).
  const same =
    existing.inputHash === inputHash &&
    existing.capability === request.capability &&
    existing.operation === request.operation &&
    existing.attachment.attachmentId === request.attachment.attachmentId &&
    existing.attachment.generation === request.attachment.generation;
  if (!same) {
    throw requestConflictError(
      request.requestKey,
      `Request key ${request.requestKey} is reused for different work.`,
      {
        recorded: {
          capability: existing.capability,
          operation: existing.operation,
          attachmentId: existing.attachment.attachmentId,
          generation: existing.attachment.generation,
          inputHash: existing.inputHash,
        },
        offered: {
          capability: request.capability,
          operation: request.operation,
          attachmentId: request.attachment.attachmentId,
          generation: request.attachment.generation,
          inputHash,
        },
      },
    );
  }
  // Repeating a request returns its operation; it never dispatches
  // again, whatever status the operation now holds (SPEC.md 9.1).
  return { operation: existing, deduplicated: true };
}

/** Validate one request shape and its session binding. */
function assertRequest(request: InvocationRequest, sessionId: string): void {
  try {
    assertValid(invocationRequestSchema, request);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  if (request.attachment.sessionId !== sessionId) {
    throw invalidRequestError("The attachment reference names another session.", {
      sessionId,
      attachmentSessionId: request.attachment.sessionId,
    });
  }
}

/** Load one attachment of this session or refuse. */
function requireAttachment(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
): AttachmentSummary {
  const attachment = store.getAttachment(attachmentId);
  if (attachment === null || attachment.sessionId !== sessionId) {
    throw invalidRequestError(`Attachment ${attachmentId} does not exist in this session.`, {
      attachmentId,
    });
  }
  return attachment;
}

/** The SHA-256 of one request input under its canonical encoding. */
function hashOf(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}
