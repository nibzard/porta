import { randomUUID } from "node:crypto";
import {
  invalidRequestError,
  invalidRequestFromValidation,
  policyDeniedError,
  toPortableError,
} from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import { policyRevocationInputSchema, policyRevocationSchema } from "../schema/policy.js";
import type { PolicyRevocation, PolicyRevocationInput } from "../schema/policy.js";
import type { CancellationResult } from "../schema/adapter.js";
import type { OperationRecord } from "../schema/operation.js";
import { ValidationError, assertValid } from "../schema/validate.js";
import { nowUtcTimestamp } from "../core/time.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import { cancelOperation } from "./cancellation.js";
import type { CancelTransport } from "./cancellation.js";
import { requireOpenSession } from "./workspace.js";

/**
 * Policy revocation (SPEC.md section 7).
 *
 * Revocation commits a durable narrowing of the session's authority.
 * From the commit onward, new admissions under the revoked permissions
 * refuse with `PolicyDenied` — the admission transaction reads the
 * committed revocations, so the block starts at the commit itself.
 *
 * Existing operations receive cancellation requests where a transport
 * carries them. Only a provider-confirmed stop settles an operation as
 * cancelled; an unconfirmed stop stays visible — the operation keeps an
 * unresolved outcome and the attempt stays on its cancellation trail —
 * and is never reported as stopped.
 */

/** Options of one revocation commit. */
export interface RevocationOptions {
  /** Transport that carries cancellation requests to the provider. */
  transport?: CancelTransport;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** One cancellation request the sweep issued, and what came back. */
export interface RevocationCancellation {
  operationId: string;
  /** The provider's answer; null when no transport was supplied. */
  result: CancellationResult | null;
  /** The operation's durable status after the attempt. */
  status: OperationRecord["status"];
  /** The failure of the attempt itself, when the transport refused it. */
  error?: PortableError;
}

/** The outcome of one revocation commit. */
export interface RevocationOutcome {
  revocation: PolicyRevocation;
  /** `false` when the identifier was already committed. */
  created: boolean;
  /** Cancellation attempts issued for in-flight covered operations. */
  cancellations: RevocationCancellation[];
}

/** The journal type of one committed revocation. */
const REVOKED_EVENT = "policy.revoked";

/**
 * Commit one policy revocation and sweep in-flight work
 * (SPEC.md section 7).
 *
 * The commit lands first, in one transaction with its journal event:
 * admissions refuse from that instant. The cancellation sweep runs
 * after the commit; each in-flight operation covered by the revocation
 * receives one request through the transport, and the report states
 * exactly what each provider answered.
 */
export async function commitPolicyRevocation(
  store: ControlStore,
  sessionId: string,
  input: PolicyRevocationInput,
  options: RevocationOptions = {},
): Promise<RevocationOutcome> {
  try {
    assertValid(policyRevocationInputSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  requireOpenSession(store, sessionId);

  // A repeated identity returns the committed record; the sweep does
  // not run again for the same revocation.
  const revocationId = input.revocationId ?? `rev-${randomUUID()}`;
  const existing = store.getPolicyRevocation(revocationId);
  if (existing !== null) {
    if (existing.sessionId !== sessionId) {
      throw invalidRequestError(
        `Revocation ${revocationId} belongs to another session.`,
        { revocationId, sessionId },
      );
    }
    return { revocation: existing, created: false, cancellations: [] };
  }

  const revocation: PolicyRevocation = {
    id: revocationId,
    sessionId,
    operations: [...new Set(input.operations ?? [])].sort(),
    providers: [...new Set(input.providers ?? [])].sort(),
    reason: input.reason,
    committedAt: nowUtcTimestamp(),
  };
  assertValid(policyRevocationSchema, revocation);
  const stream = new SessionEventStream(store, sessionId, options.redactor);
  try {
    store.transaction(() => {
      store.insertPolicyRevocation(revocation);
      stream.append(REVOKED_EVENT, revocation.id, {
        revocationId: revocation.id,
        operations: revocation.operations,
        providers: revocation.providers,
        reason: revocation.reason,
      });
    });
  } catch (error) {
    throw portable(error);
  }

  const cancellations: RevocationCancellation[] = [];
  for (const operation of inFlightCovered(store, sessionId, revocation)) {
    if (options.transport === undefined) {
      // No transport, no request: the obligation stays visible instead
      // of being silently dropped.
      cancellations.push({
        operationId: operation.id,
        result: null,
        status: operation.status,
      });
      continue;
    }
    try {
      const { operation: after, result } = await cancelOperation(
        store,
        sessionId,
        operation.id,
        options.transport,
      );
      cancellations.push({ operationId: operation.id, result, status: after.status });
    } catch (error) {
      // The request itself failed; the operation is untouched and the
      // failure is reported, never folded into a claimed stop.
      cancellations.push({
        operationId: operation.id,
        result: null,
        status: store.getOperation(operation.id)?.status ?? operation.status,
        error: toPortableError(error),
      });
    }
  }
  return { revocation, created: true, cancellations };
}

/** The in-flight operations one revocation covers, oldest first. */
function inFlightCovered(
  store: ControlStore,
  sessionId: string,
  revocation: PolicyRevocation,
): OperationRecord[] {
  return store.listOperationsBySession(sessionId).filter((operation) => {
    if (operation.status !== "accepted" && operation.status !== "running") {
      return false;
    }
    const providerId = store.getAttachment(operation.attachment.attachmentId)?.providerId;
    return revocationCovers(revocation, {
      capability: operation.capability,
      operation: operation.operation,
      ...(providerId !== undefined ? { providerId } : {}),
    });
  });
}

/** What one admission or operation names, for coverage checks. */
export interface RevocationTarget {
  capability: string;
  operation: string;
  providerId?: string;
}

/**
 * Whether one revocation covers a target (SPEC.md section 7).
 *
 * An operations entry of `name@major` covers every operation of that
 * capability; `name@major/operation` covers that operation alone. A
 * providers entry covers everything the named provider supplies.
 */
export function revocationCovers(
  revocation: PolicyRevocation,
  target: RevocationTarget,
): boolean {
  if (target.providerId !== undefined && revocation.providers.includes(target.providerId)) {
    return true;
  }
  return (
    revocation.operations.includes(target.capability) ||
    revocation.operations.includes(`${target.capability}/${target.operation}`)
  );
}

/**
 * The committed revocation that blocks one admission, or null.
 *
 * Admission runs this check inside its own transaction, so a revocation
 * that committed blocks the next admission the store admits — no window
 * separates the commit from the block.
 */
export function findBlockingRevocation(
  store: ControlStore,
  sessionId: string,
  target: RevocationTarget,
): PolicyRevocation | null {
  for (const revocation of store.listPolicyRevocations(sessionId)) {
    if (revocationCovers(revocation, target)) {
      return revocation;
    }
  }
  return null;
}

/** The denial one blocked admission throws. */
export function revocationDenied(revocation: PolicyRevocation, target: RevocationTarget): PortableError {
  return policyDeniedError(
    `The authority for ${target.capability}/${target.operation} was revoked.`,
    {
      dimension: "revocation",
      revocationId: revocation.id,
      reason: revocation.reason,
      committedAt: revocation.committedAt,
    },
  );
}

/** Map one store error to its portable form; pass others through. */
function portable(error: unknown): unknown {
  if (error instanceof StoreError) {
    return error.toPortableError();
  }
  return error;
}
