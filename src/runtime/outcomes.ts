import { invalidRequestError } from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import type { Extensions } from "../schema/defs.js";
import type { OperationRecord, OperationStatus } from "../schema/operation.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";

/**
 * Operation outcomes and reconciliation (SPEC.md section 9.2).
 *
 * An operation moves `accepted` to `running` once provider execution
 * is known to have started, and settles from there to `completed`,
 * `failed`, `cancelled`, or `unknown`. A lost response after dispatch
 * settles as `unknown` — a timeout proves nothing about cancellation —
 * and only reconciliation with evidence resolves an unknown record.
 *
 * Settled operations never move again: settling the same outcome twice
 * changes nothing, a different outcome refuses, and dispatching a
 * settled operation refuses. Nothing here retries an unsafe effect.
 */

/** Input of one dispatch, settlement, or reconciliation call. */
export interface OutcomeOptions {
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** One settled outcome of an operation. */
export type OperationOutcome =
  | { kind: "completed"; resultRef: string; extensions?: Extensions }
  | { kind: "failed"; error: PortableError; extensions?: Extensions }
  | { kind: "cancelled"; error: PortableError; extensions?: Extensions }
  | { kind: "unknown"; error: PortableError; extensions?: Extensions };

/** One reconciliation result, offered against an unknown operation. */
export type OperationResolution =
  | { kind: "completed"; resultRef: string; detail: string; extensions?: Extensions }
  | { kind: "failed"; error: PortableError; detail: string }
  | { kind: "cancelled"; error: PortableError; detail: string }
  | { kind: "still-unknown"; detail: string };

/** One observation a reconciliation pass left behind. */
export interface ReconciliationObservation {
  observedAt: string;
  outcome: "completed" | "failed" | "cancelled" | "still-unknown";
  detail?: string;
}

/** The reconciliation trail one operation record carries. */
export interface ReconciliationTrail {
  /** The uncertainty exactly as it was first recorded. */
  originalError: PortableError;
  /** One entry per reconciliation pass, oldest first. */
  observations: ReconciliationObservation[];
}

/** The statuses an operation can settle from. */
const SETTLEABLE: ReadonlySet<OperationStatus> = new Set(["accepted", "running"]);

/** The statuses an operation never leaves. */
const TERMINAL: ReadonlySet<OperationStatus> = new Set(["completed", "failed", "cancelled"]);

/** Extension key the reconciliation trail lives under. */
const RECONCILIATION_KEY = "portable.runtime.reconciliation";

/** The plan one transition produced: the next record, written or not. */
interface Plan {
  record: OperationRecord;
  /** `false` when the current record already answers the call. */
  write: boolean;
  /** Reconciliation evidence the journal entry carries, when one does. */
  reconciliation?: ReconciliationObservation;
}

/**
 * Record that provider execution of one operation is known to have
 * started (SPEC.md section 9.2).
 *
 * The move is compare-and-set from `accepted`; a second call changes
 * nothing. A settled or unknown operation refuses: dispatching again
 * would replay effects whose first run may already have happened.
 */
export function markOperationDispatched(
  store: ControlStore,
  sessionId: string,
  operationId: string,
  options: OutcomeOptions = {},
): OperationRecord {
  return transition(store, sessionId, operationId, options, (current) => {
    if (current.status === "running") {
      return { record: current, write: false };
    }
    if (SETTLEABLE.has(current.status)) {
      return { record: { ...current, status: "running" }, write: true };
    }
    if (current.status === "unknown") {
      throw dispatchRefusal(current, "operation-needs-reconciliation");
    }
    throw dispatchRefusal(current, "operation-settled");
  });
}

/**
 * Settle one operation with a known outcome (SPEC.md section 9.2).
 *
 * Settling is allowed while the operation is `accepted` or `running`.
 * A `completed` result carries its result reference: a process that
 * exits nonzero is completed with that exit code, not a transport
 * failure. A lost response settles as `unknown`, because a timeout
 * does not establish cancellation. Settling an already settled
 * operation with the same outcome changes nothing; a different
 * outcome refuses. An `unknown` record resolves only through
 * reconciliation.
 */
export function settleOperation(
  store: ControlStore,
  sessionId: string,
  operationId: string,
  outcome: OperationOutcome,
  options: OutcomeOptions = {},
): OperationRecord {
  return transition(store, sessionId, operationId, options, (current) => {
    if (TERMINAL.has(current.status)) {
      return settleTerminal(current, outcome);
    }
    if (current.status === "unknown") {
      throw invalidRequestError(
        `Operation ${operationId} is unknown; only reconciliation resolves it.`,
        { operationId, status: current.status, reason: "operation-needs-reconciliation" },
      );
    }
    return { record: settledRecord(current, outcome), write: true };
  });
}

/**
 * Reconcile one unknown operation with provider evidence
 * (SPEC.md section 9.2).
 *
 * The original uncertainty stays on the record, and every pass
 * appends its observation to the trail in the record extensions and
 * to the journal. A resolution that names an outcome moves the status;
 * `still-unknown` leaves it. Reconciling an operation that is not
 * unknown refuses: it never held uncertainty.
 */
export function reconcileOperation(
  store: ControlStore,
  sessionId: string,
  operationId: string,
  resolution: OperationResolution,
  options: OutcomeOptions = {},
): OperationRecord {
  return transition(store, sessionId, operationId, options, (current) => {
    if (current.status !== "unknown") {
      throw invalidRequestError(
        `Operation ${operationId} is ${current.status}; it holds no uncertainty to reconcile.`,
        { operationId, status: current.status, reason: "operation-not-unknown" },
      );
    }
    const trail = trailOf(current);
    const observation = observe(resolution);
    trail.observations.push(observation);
    if (resolution.kind === "still-unknown") {
      // The uncertainty stands; the pass only leaves its evidence.
      return {
        record: withTrail(current, trail),
        write: true,
        reconciliation: observation,
      };
    }
    const resolved = settledRecord(current, resolution);
    return {
      record: withTrail(resolved, trail),
      write: true,
      reconciliation: observation,
    };
  });
}

// -- Internals ----------------------------------------------------------------

/** Read, decide, and commit one operation transition. */
function transition(
  store: ControlStore,
  sessionId: string,
  operationId: string,
  options: OutcomeOptions,
  decide: (current: OperationRecord) => Plan,
): OperationRecord {
  try {
    return store.transaction(() => {
      const current = requireOperation(store, sessionId, operationId);
      const plan = decide(current);
      if (!plan.write) {
        return plan.record;
      }
      const updated = store.casOperation(operationId, { status: current.status }, plan.record);
      if (updated === null) {
        throw invalidRequestError(
          `Operation ${operationId} moved while its outcome was being written.`,
          { operationId, reason: "operation-moved" },
        );
      }
      const stream = new SessionEventStream(store, sessionId, options.redactor);
      stream.append("operation.updated", plan.record.id, payloadOf(plan.record, plan.reconciliation));
      return updated;
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/** The plan when an operation already holds the terminal outcome. */
function settleTerminal(current: OperationRecord, outcome: OperationOutcome): Plan {
  const same =
    (outcome.kind === "completed" && current.status === "completed" &&
      current.resultRef === outcome.resultRef) ||
    (outcome.kind !== "completed" && current.status === outcome.kind);
  if (same) {
    // The outcome is already durable; writing it again changes nothing
    // and dispatches nothing.
    return { record: current, write: false };
  }
  throw invalidRequestError(
    `Operation ${current.id} is ${current.status}; it cannot settle as ${outcome.kind}.`,
    { operationId: current.id, status: current.status, offered: outcome.kind, reason: "operation-settled" },
  );
}

/** The refusal when a settled or unknown operation is asked to dispatch. */
function dispatchRefusal(current: OperationRecord, reason: string): PortableError {
  return invalidRequestError(
    `Operation ${current.id} is ${current.status}; it cannot dispatch again.`,
    { operationId: current.id, status: current.status, reason },
  );
}

/** The record one settled outcome produces from the current one. */
function settledRecord(
  current: OperationRecord,
  outcome: OperationOutcome | (OperationResolution & { kind: "completed" | "failed" | "cancelled" }),
): OperationRecord {
  const base = bare(current);
  if (outcome.kind === "completed") {
    const extensions = outcome.extensions;
    return {
      ...base,
      status: "completed",
      resultRef: outcome.resultRef,
      ...(extensions !== undefined || current.extensions !== undefined
        ? { extensions: { ...current.extensions, ...extensions } }
        : {}),
    };
  }
  if (outcome.kind === "unknown") {
    return merged(base, outcome);
  }
  return merged(base, outcome);
}

/** One non-completed outcome merged onto the cleared base record. */
function merged(
  base: OperationRecord,
  outcome: { kind: "failed" | "cancelled" | "unknown"; error: PortableError; extensions?: Extensions },
): OperationRecord {
  return {
    ...base,
    status: outcome.kind,
    error: outcome.error,
    ...(outcome.extensions !== undefined
      ? { extensions: { ...base.extensions, ...outcome.extensions } }
      : {}),
  };
}

/** One record without its result and error fields. */
function bare(record: OperationRecord): OperationRecord {
  const clone: Partial<OperationRecord> = { ...record };
  delete clone.resultRef;
  delete clone.error;
  return clone as OperationRecord;
}

/** The event payload one record state produces. */
function payloadOf(
  record: OperationRecord,
  reconciliation?: ReconciliationObservation,
): Record<string, unknown> {
  return {
    operationId: record.id,
    status: record.status,
    ...(record.resultRef !== undefined ? { resultRef: record.resultRef } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(reconciliation !== undefined ? { reconciliation } : {}),
  };
}

/** One observation of one resolution, stamped now. */
function observe(resolution: OperationResolution): ReconciliationObservation {
  return {
    observedAt: new Date().toISOString(),
    outcome: resolution.kind,
    ...(resolution.detail !== "" ? { detail: resolution.detail } : {}),
  };
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

/** The reconciliation trail of one record, fresh when none exists. */
function trailOf(record: OperationRecord): ReconciliationTrail {
  const stored = record.extensions?.[RECONCILIATION_KEY];
  if (stored === undefined) {
    return {
      originalError:
        record.error ?? {
          code: "OperationUnknown",
          message: "The outcome of the operation could not be determined.",
          retry: "after-reconciliation",
        },
      observations: [],
    };
  }
  return stored as ReconciliationTrail;
}

/** The record with one trail attached under the extension key. */
function withTrail(record: OperationRecord, trail: ReconciliationTrail): OperationRecord {
  return { ...record, extensions: { ...record.extensions, [RECONCILIATION_KEY]: trail } };
}
