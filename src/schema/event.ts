import {
  DEFS,
  EVENT_NAME_PATTERN,
  type Extensions,
  type Identifier,
  type UtcTimestamp,
} from "./defs.js";

/** Event types required by SPEC.md section 18.1. */
export const EVENT_TYPES = [
  "attachment.attached",
  "attachment.replaced",
  "attachment.released",
  "attachment.unavailable",
  "lease.expired",
  "operation.updated",
  "operation.output",
  "workspace.checkpointed",
  "workspace.proposed",
  "workspace.accepted",
  "resource.invalidated",
  "resource.rebound",
  "handoff.updated",
  "cleanup.pending",
] as const;

export type EventTypeName = (typeof EVENT_TYPES)[number];

/**
 * Durable journal event (SPEC.md section 18.1).
 *
 * Events commit atomically with their state change. Consumers resume by
 * sequence and tolerate duplicate delivery.
 */
export interface PortableEvent {
  schemaVersion: 1;
  sessionId: Identifier;
  sequence: number;
  occurredAt: UtcTimestamp;
  type: EventTypeName | (string & {});
  subjectId: Identifier;
  data: Record<string, unknown>;
  extensions?: Extensions;
}

export const portableEventSchema = {
  $id: "https://portable.dev/schema/event.json",
  $defs: DEFS,
  type: "object",
  required: ["schemaVersion", "sessionId", "sequence", "occurredAt", "type", "subjectId", "data"],
  additionalProperties: false,
  properties: {
    schemaVersion: { $ref: "#/$defs/schemaVersion" },
    sessionId: { $ref: "#/$defs/identifier" },
    sequence: { $ref: "#/$defs/sequence" },
    occurredAt: { $ref: "#/$defs/timestamp" },
    type: {
      // Required types plus namespaced extension events.
      anyOf: [{ enum: EVENT_TYPES }, { type: "string", pattern: EVENT_NAME_PATTERN }],
    },
    subjectId: { $ref: "#/$defs/identifier" },
    data: { $ref: "#/$defs/jsonObject" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
