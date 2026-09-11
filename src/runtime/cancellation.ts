import { invalidRequestError, operationUnknownError, portableError } from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import type { Extensions } from "../schema/defs.js";
import type { OperationRecord } from "../schema/operation.js";
import type { CancellationResult } from "../schema/adapter.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";
import { reconcileOperation, settleOperation } from "./outcomes.js";
import type { OperationResolution } from "./outcomes.js";

/**
 * Cancellation and deadlines (SPEC.md sections 7, 9.2, and 15).
 *
 * A deadline bounds a caller's wait, nothing more: when it passes, the
 * operation keeps its status and the remote work keeps running, because
 * a timeout proves nothing about termination. Cancelling the remote
 * work is a separate, explicit request to the provider, and only a
 * provider-confirmed stop settles the record as `cancelled`. A
 * best-effort stop that nobody confirmed leaves the outcome unknown,
 * with the attempt recorded on the trail.
 */

/** Extension key the cancellation trail lives under. */
const CANCELLATION_KEY = "portable.runtime.cancellation";

/** One cancellation attempt recorded on an operation. */
export interface CancellationAttempt {
  at: string;
  outcome: CancellationResult["outcome"];
  stopped: boolean;
  descendantsStopped?: boolean;
  detail?: string;
}

/** The cancellation trail one operation record carries. */
export interface CancellationTrail {
  /** One entry per explicit cancellation attempt, oldest first. */
  attempts: CancellationAttempt[];
}

/** The transport an explicit cancellation needs. */
export interface CancelTransport {
  /** Ask the provider to stop one operation by its durable identifier. */
  cancel(operationId: string): Promise<CancellationResult>;
}

/** The result of one bounded wait. */
export type WaitOutcome =
  | { outcome: "settled"; operation: OperationRecord }
  | { outcome: "timed-out"; operation: OperationRecord };

/**
 * The absolute deadline one timeout names (SPEC.md sections 7 and 15).
 *
 * The deadline is derived, never trusted from invocation input: the
 * caller states a duration and the runtime stamps the instant. A
 * non-positive or fractional duration refuses.
 */
export function deadlineFromTimeoutMs(timeoutMs: number, from: Date = new Date()): string {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw invalidRequestError("The timeout must be a positive whole number of milliseconds.");
  }
  return new Date(from.getTime() + timeoutMs).toISOString();
}

/**
 * Wait for one operation to settle, bounded by a deadline
 * (SPEC.md section 15).
 *
 * The wait reads durable state only. When the deadline passes it
 * reports `timed-out` and changes nothing: the operation keeps its
 * status and the remote work keeps running, because a timeout does
 * not establish cancellation. Stopping the remote work needs an
 * explicit `cancelOperation` call.
 */
export async function waitForOperation(
  store: ControlStore,
  sessionId: string,
  operationId: string,
  options: { waitMs: number; pollIntervalMs?: number },
): Promise<WaitOutcome> {
  if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0) {
    throw invalidRequestError("The wait needs a non-negative whole number of milliseconds.");
  }
  const pollMs = options.pollIntervalMs ?? 5;
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const operation = requireOperation(store, sessionId, operationId);
    if (operation.status !== "accepted" && operation.status !== "running") {
      return { outcome: "settled", operation };
    }
    if (Date.now() >= deadline) {
      // The caller's patience ran out; the operation itself is
      // untouched and the remote work may still be running.
      return { outcome: "timed-out", operation };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Explicitly cancel one operation at its provider (SPEC.md sections 7
 * and 9.2).
 *
 * Only a confirmed stop settles the record as `cancelled` — prior
 * effects may remain, and nothing here hides them. A best-effort stop
 * without confirmation leaves the outcome `unknown` with the attempt
 * on the trail, because an unconfirmed stop is unresolved. An
 * unsupported cancellation changes no status and reports the refusal.
 * Cancelling an already cancelled operation is idempotent; cancelling
 * a completed or failed one refuses.
 */
export async function cancelOperation(
  store: ControlStore,
  sessionId: string,
  operationId: string,
  transport: CancelTransport,
): Promise<{ operation: OperationRecord; result: CancellationResult }> {
  const current = requireOperation(store, sessionId, operationId);
  if (current.status === "completed" || current.status === "failed") {
    throw invalidRequestError(
      `Operation ${operationId} is ${current.status}; it cannot be cancelled.`,
      { operationId, status: current.status, reason: "operation-settled" },
    );
  }
  if (current.status === "cancelled") {
    // The stop is already durable; report it without asking again.
    return { operation: current, result: lastResultOf(current) };
  }

  const result = await transport.cancel(operationId);
  const attempt = attemptOf(result);
  const trail = trailOf(current, attempt);
  const extensions: Extensions = { [CANCELLATION_KEY]: trail };

  if (result.outcome === "unsupported") {
    // The provider refuses cancellation; the record keeps its status
    // and the refusal stays visible on the trail.
    return { operation: recordTrail(store, sessionId, current, trail), result };
  }
  if (result.outcome === "confirmed" && result.stopped) {
    const operation = settleOperation(store, sessionId, operationId, {
      kind: "cancelled",
      error: cancelledError(operationId, result),
      extensions,
    });
    return { operation, result };
  }
  // Best effort, or a stop nobody confirmed: the outcome is unknown —
  // the stop itself is unresolved. Reconciliation can resolve it.
  const error: PortableError = operationUnknownError(
    operationId,
    result.detail ?? "The provider did not confirm the stop.",
  );
  if (current.status === "unknown") {
    // The outcome was already unresolved; the attempt joins the trail
    // and reconciliation notes that the stop is still unconfirmed.
    recordTrail(store, sessionId, current, trail);
    const resolution: OperationResolution = { kind: "still-unknown", detail: cancellationDetail(result) };
    const operation = reconcileOperation(store, sessionId, operationId, resolution);
    return { operation, result };
  }
  const operation = settleOperation(store, sessionId, operationId, { kind: "unknown", error, extensions });
  return { operation, result };
}

// -- Internals ----------------------------------------------------------------

/** Persist one trail on an otherwise unchanged record. */
function recordTrail(
  store: ControlStore,
  sessionId: string,
  current: OperationRecord,
  trail: CancellationTrail,
): OperationRecord {
  try {
    return store.transaction(() => {
      const updated = store.casOperation(current.id, { status: current.status }, {
        ...current,
        extensions: { ...current.extensions, [CANCELLATION_KEY]: trail },
      });
      if (updated === null) {
        throw invalidRequestError(
          `Operation ${current.id} moved while its cancellation was recorded.`,
          { operationId: current.id, reason: "operation-moved" },
        );
      }
      return updated;
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/** One trail entry of one provider result. */
function attemptOf(result: CancellationResult): CancellationAttempt {
  return {
    at: new Date().toISOString(),
    outcome: result.outcome,
    stopped: result.stopped,
    ...(result.descendantsStopped !== undefined
      ? { descendantsStopped: result.descendantsStopped }
      : {}),
    ...(result.detail !== undefined && result.detail !== "" ? { detail: result.detail } : {}),
  };
}

/** The trail of one record with one more attempt appended. */
function trailOf(record: OperationRecord, attempt: CancellationAttempt): CancellationTrail {
  const stored = record.extensions?.[CANCELLATION_KEY];
  const existing: CancellationTrail =
    stored === undefined ? { attempts: [] } : (stored as CancellationTrail);
  return { attempts: [...existing.attempts, attempt] };
}

/** The idempotent result of one already cancelled operation. */
function lastResultOf(record: OperationRecord): CancellationResult {
  const trail = record.extensions?.[CANCELLATION_KEY] as CancellationTrail | undefined;
  const last = trail?.attempts[trail.attempts.length - 1];
  if (last !== undefined && last.outcome === "confirmed" && last.stopped) {
    return {
      outcome: "confirmed",
      stopped: true,
      ...(last.descendantsStopped !== undefined
        ? { descendantsStopped: last.descendantsStopped }
        : {}),
      detail: "The operation was already cancelled.",
    };
  }
  return { outcome: "confirmed", stopped: true, detail: "The operation is cancelled." };
}

/** The error one confirmed cancellation records. */
function cancelledError(operationId: string, result: CancellationResult): PortableError {
  return portableError("InvalidRequest", `Operation ${operationId} was cancelled.`, {
    details: {
      cancellation: "confirmed",
      ...(result.descendantsStopped !== undefined
        ? { descendantsStopped: result.descendantsStopped }
        : {}),
      ...(result.detail !== undefined && result.detail !== "" ? { detail: result.detail } : {}),
    },
  });
}

/** The evidence string one reconciliation pass notes. */
function cancellationDetail(result: CancellationResult): string {
  return `Cancellation was ${result.outcome}; the stop is unconfirmed.${
    result.detail !== undefined && result.detail !== "" ? ` ${result.detail}` : ""
  }`;
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

/** Sleep for one duration. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
