import { invalidRequestError } from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import { validateAgainstSchema } from "../schema/validate.js";
import { portableEventSchema } from "../schema/event.js";
import type { EventTypeName, PortableEvent } from "../schema/event.js";
import { validateEventPayload } from "../schema/event-payload.js";
import type { ControlStore } from "./control-store.js";

/** One batch of journal events plus the cursor it leaves behind. */
export interface EventBatch {
  events: PortableEvent[];
  /** Sequence of the last event in the batch, or the resume point. */
  lastSequence: number;
  /** True when the batch reached its limit and more events may follow. */
  hasMore: boolean;
}

/** Stable identity of one event across duplicate deliveries. */
export function uniqueEventKey(event: PortableEvent): string {
  return `${event.sessionId}:${event.sequence}`;
}

/**
 * Removes credentials from event data before it is validated and
 * persisted. Secret references survive; released values do not.
 */
export type EventRedactor = (
  data: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * Durable per-session journal stream (SPEC.md sections 9.3 and 18.1).
 *
 * Appends validate the envelope and the type-specific payload, then commit
 * the event with its sequence in one transaction. Readers resume by
 * sequence; because delivery may repeat, consumers deduplicate on the
 * event key rather than assuming exactly-once delivery.
 *
 * An optional redactor runs before validation on every append, so
 * journal entries never store released credential values.
 */
export class SessionEventStream {
  private readonly store: ControlStore;
  private readonly redactor: EventRedactor | undefined;
  readonly sessionId: string;

  constructor(store: ControlStore, sessionId: string, redactor?: EventRedactor) {
    this.store = store;
    this.sessionId = sessionId;
    this.redactor = redactor;
  }

  /** Append one validated event. */
  append(
    type: EventTypeName | string,
    subjectId: string,
    data: Record<string, unknown>,
  ): PortableEvent {
    const clean = this.prepare(type, subjectId, data);
    return this.store.appendEvent(this.sessionId, type, subjectId, clean);
  }

  /**
   * Apply a state mutation and its event in one transaction.
   *
   * When the mutation fails, the event never lands; when the event
   * fails validation, the mutation never runs (SPEC.md section 18.1).
   */
  commitWith<T>(
    type: EventTypeName | string,
    subjectId: string,
    data: Record<string, unknown>,
    mutate: () => T,
  ): { result: T; event: PortableEvent } {
    const clean = this.prepare(type, subjectId, data);
    return this.store.transaction(() => {
      const result = mutate();
      const event = this.store.appendEvent(this.sessionId, type, subjectId, clean);
      return { result, event };
    });
  }

  /** Redact, then validate, the data of one pending event. */
  private prepare(
    type: EventTypeName | string,
    subjectId: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const clean = this.redactor === undefined ? data : this.redactor(data);
    checkPayload(type, subjectId, clean);
    return clean;
  }

  /** Read committed events after a sequence, in order. */
  read(afterSequence: number, limit?: number): EventBatch {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw invalidRequestError("The event batch limit must be a positive integer.");
    }
    const events = this.store.listEvents(this.sessionId, afterSequence, limit);
    const last = events.at(-1);
    return {
      events,
      lastSequence: last === undefined ? afterSequence : last.sequence,
      hasMore: limit !== undefined && events.length === limit,
    };
  }

  /** The last committed sequence of the session. */
  currentSequence(): number {
    const session = this.store.getSession(this.sessionId);
    if (session === null) {
      throw invalidRequestError(`Session ${this.sessionId} does not exist.`);
    }
    return session.eventSequence;
  }
}

/**
 * Check one event against the envelope and its payload contract.
 *
 * Throws an `InvalidRequest` error naming the offending paths before any
 * write happens.
 */
function checkPayload(type: string, subjectId: string, data: Record<string, unknown>): void {
  const envelope = {
    schemaVersion: 1,
    sessionId: "session",
    sequence: 0,
    occurredAt: new Date().toISOString(),
    type,
    subjectId,
    data,
  };
  const envelopeIssues = validateAgainstSchema(portableEventSchema, envelope);
  if (envelopeIssues.length > 0) {
    throw invalidRequestError("The event envelope failed validation.", {
      issues: compact(envelopeIssues),
    });
  }
  const payloadIssues = validateEventPayload(type, data);
  if (payloadIssues.length > 0) {
    throw invalidRequestError(`The ${type} event payload failed validation.`, {
      issues: compact(payloadIssues),
    });
  }
}

function compact(issues: ReturnType<typeof validateAgainstSchema>): unknown {
  return issues.map((issue) => ({
    path: issue.instancePath || "/",
    keyword: issue.keyword,
    message: issue.message,
  }));
}

/**
 * Consumer-side duplicate filter.
 *
 * Delivery may repeat a committed event. The deduplicator keeps the first
 * copy of each key and returns only events the consumer has not seen, so
 * replaying overlapping ranges never misses or double-applies an event.
 */
export class EventDeduplicator {
  private readonly seen = new Set<string>();

  /** Return the events not seen before and record their keys. */
  accept(events: readonly PortableEvent[]): PortableEvent[] {
    const fresh: PortableEvent[] = [];
    for (const event of events) {
      const key = uniqueEventKey(event);
      if (this.seen.has(key)) {
        continue;
      }
      this.seen.add(key);
      fresh.push(event);
    }
    return fresh;
  }

  /** True when the key was already recorded. */
  has(event: PortableEvent): boolean {
    return this.seen.has(uniqueEventKey(event));
  }

  /** Number of distinct events recorded. */
  get size(): number {
    return this.seen.size;
  }
}

/** Re-check a stored event, including its type payload. */
export function validateStoredEvent(event: PortableEvent): PortableError | null {
  const issues = validateAgainstSchema(portableEventSchema, event);
  if (issues.length > 0) {
    return invalidRequestError("The stored event failed its envelope.", {
      issues: compact(issues),
    });
  }
  const payloadIssues = validateEventPayload(event.type, event.data);
  if (payloadIssues.length > 0) {
    return invalidRequestError(`The stored ${event.type} payload failed validation.`, {
      issues: compact(payloadIssues),
    });
  }
  return null;
}
