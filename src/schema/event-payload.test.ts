import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES } from "./event.js";
import type { EventTypeName } from "./event.js";
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES_WITH_PAYLOADS,
  validateEventPayload,
} from "./event-payload.js";

const DIGEST = "a".repeat(64);

/** One valid payload per required event type. */
const VALID: Record<EventTypeName, Record<string, unknown>> = {
  "attachment.attached": {
    attachmentId: "att-1",
    name: "worker",
    generation: 1,
    environmentId: "env-1",
    capabilityIds: ["exec.process@1"],
  },
  "attachment.replaced": {
    attachmentId: "att-1",
    oldGeneration: 1,
    newGeneration: 2,
    oldEnvironmentId: "env-1",
    newEnvironmentId: "env-2",
    workspaceRevisionId: "rev-1",
    capabilityChanges: { added: ["browser.session@1"], removed: [] },
    dispositions: [
      { subject: "workspace", class: "portable", action: "transfer" },
      { subject: "server pid", class: "reconstructable", action: "reconstruct" },
    ],
  },
  "attachment.released": {
    attachmentId: "att-1",
    generation: 2,
    reason: "session closing",
    cleanupIds: ["clean-1"],
  },
  "attachment.unavailable": {
    attachmentId: "att-1",
    generation: 1,
    reason: "lease expired",
    providerConfirmedTermination: false,
  },
  "lease.expired": {
    attachmentId: "att-1",
    leaseKind: "environment",
    expiredAt: "2026-09-11T00:00:00Z",
    generation: 1,
  },
  "operation.updated": {
    operationId: "op-1",
    status: "running",
    requestKey: "invoke-1",
  },
  "operation.output": {
    operationId: "op-1",
    stream: "stdout",
    chunkSequence: 0,
    truncated: false,
    executionContinued: true,
    byteLength: 4,
  },
  "workspace.checkpointed": {
    revisionId: "rev-1",
    requestKey: "cp-1",
    parentRevisionId: "rev-0",
    fileCount: 3,
    totalBytes: 100,
  },
  "workspace.proposed": {
    proposalId: "prop-1",
    baseRevisionId: "rev-1",
    candidateRevisionId: "rev-2",
    operationIds: ["op-1"],
  },
  "workspace.accepted": {
    proposalId: "prop-1",
    revisionId: "rev-2",
    previousHeadRevisionId: "rev-1",
  },
  "resource.invalidated": {
    resourceId: "res-1",
    reason: "owner generation replaced",
    ownerGeneration: 1,
  },
  "resource.rebound": {
    resourceId: "res-1",
    ownerAttachmentId: "att-1",
    ownerGeneration: 2,
    previousOwnerGeneration: 1,
  },
  "handoff.updated": {
    transitionId: "tr-1",
    phase: "switching",
    outcome: "completed",
    oldGeneration: 1,
    newGeneration: 2,
  },
  "cleanup.pending": {
    cleanupId: "clean-1",
    kind: "release",
    targetId: "att-1",
    attempts: 1,
  },
};

/** One broken variant per type: drop the first required field. */
function broken(type: EventTypeName): Record<string, unknown> {
  const schema = EVENT_PAYLOAD_SCHEMAS[type] as { required?: string[] };
  const required = schema.required ?? [];
  assert.ok(required.length > 0, `type ${type} has required fields`);
  const clone = { ...VALID[type] };
  delete clone[required[0]!];
  return clone;
}

test("every required event type has a payload contract", () => {
  assert.equal(EVENT_TYPES.length, 14);
  assert.deepEqual([...EVENT_TYPES_WITH_PAYLOADS].sort(), [...EVENT_TYPES].sort());
  for (const type of EVENT_TYPES) {
    assert.ok(EVENT_PAYLOAD_SCHEMAS[type], `missing schema for ${type}`);
  }
});

test("valid payloads pass for every required type", () => {
  for (const type of EVENT_TYPES) {
    const issues = validateEventPayload(type, VALID[type]);
    assert.deepEqual(issues, [], `unexpected issues for ${type}`);
  }
});

test("dropping a required field fails for every required type", () => {
  for (const type of EVENT_TYPES) {
    const issues = validateEventPayload(type, broken(type));
    assert.ok(issues.length > 0, `missing-field payload accepted for ${type}`);
    assert.ok(
      issues.some((issue) => issue.keyword === "required"),
      `no required-keyword issue for ${type}`,
    );
  }
});

test("field-level rules reject wrong shapes", () => {
  assert.ok(
    validateEventPayload("attachment.attached", {
      attachmentId: "att 1",
      name: "worker",
      generation: 1,
    }).length > 0,
    "whitespace identifier accepted",
  );
  assert.ok(
    validateEventPayload("attachment.attached", {
      attachmentId: "att-1",
      name: "Worker",
      generation: 1,
    }).length > 0,
    "uppercase attachment name accepted",
  );
  assert.ok(
    validateEventPayload("attachment.attached", {
      attachmentId: "att-1",
      name: "worker",
      generation: 0,
    }).length > 0,
    "generation below one accepted",
  );
  assert.ok(
    validateEventPayload("lease.expired", {
      attachmentId: "att-1",
      leaseKind: "compute",
      expiredAt: "2026-09-11T00:00:00Z",
    }).length > 0,
    "unknown lease kind accepted",
  );
  assert.ok(
    validateEventPayload("lease.expired", {
      attachmentId: "att-1",
      leaseKind: "mutation",
      expiredAt: "yesterday",
    }).length > 0,
    "malformed timestamp accepted",
  );
  assert.ok(
    validateEventPayload("operation.output", {
      operationId: "op-1",
      stream: "stdout",
      chunkSequence: -1,
      truncated: false,
      executionContinued: true,
    }).length > 0,
    "negative chunk sequence accepted",
  );
  assert.ok(
    validateEventPayload("operation.output", {
      operationId: "op-1",
      stream: "stdout",
      chunkSequence: 1,
      truncated: false,
      executionContinued: true,
      artifactDigest: "not-a-digest",
    }).length > 0,
    "malformed digest accepted",
  );
  assert.ok(
    validateEventPayload("attachment.attached", {
      attachmentId: "att-1",
      name: "worker",
      generation: 1,
      extra: DIGEST,
    }).length > 0,
    "unknown payload field accepted",
  );
});

test("extension event types carry opaque payloads", () => {
  assert.deepEqual(validateEventPayload("com.example.custom.event", { anything: 1 }), []);
  assert.deepEqual(validateEventPayload("com.example.custom.event", "not an object"), []);
});
