import test from "node:test";
import assert from "node:assert/strict";
import { jsonRoundTrip, validateAgainstSchema } from "./validate.js";
import {
  attachmentRefSchema,
  sessionDescriptionSchema,
  sessionOptionsSchema,
  sessionRecordSchema,
} from "./session.js";
import type { AttachmentRef, SessionRecord } from "./session.js";
import {
  artifactRecordSchema,
  invocationRequestSchema,
  operationRecordSchema,
  outputChunkSchema,
} from "./operation.js";
import type {
  ArtifactRecord,
  InvocationRequest,
  OperationRecord,
  OutputChunk,
} from "./operation.js";
import {
  resourceDescriptionSchema,
  resourceRefSchema,
} from "./resource.js";
import type { ResourceDescription, ResourceRef } from "./resource.js";
import {
  checkpointRequestSchema,
  workspaceProposalSchema,
  workspaceRevisionSchema,
} from "./workspace.js";
import type {
  CheckpointRequest,
  WorkspaceProposal,
  WorkspaceRevision,
} from "./workspace.js";
import { portableEventSchema } from "./event.js";
import type { PortableEvent } from "./event.js";
import { portableErrorSchema } from "./error.js";
import type { PortableError } from "./error.js";

const HEX64 = "a".repeat(64);

function issuesFor(schema: object, value: unknown): string[] {
  return validateAgainstSchema(schema, value).map(
    (issue) => `${issue.instancePath || "/"}:${issue.keyword}`,
  );
}

const attachmentRef: AttachmentRef = {
  sessionId: "ses_01",
  attachmentId: "att_01",
  generation: 2,
};

const sessionRecord: SessionRecord = {
  id: "ses_01",
  schemaVersion: 1,
  status: "open",
  workspaceId: "ws_01",
  eventSequence: 7,
  policyRef: "policy://local/default",
  createdAt: "2026-09-11T12:00:00Z",
};

test("session records round-trip through JSON", () => {
  const parsed = jsonRoundTrip(sessionRecordSchema, sessionRecord);
  assert.deepEqual(parsed, sessionRecord);
});

test("session records reject bad status, version, and timestamps", () => {
  const issues = issuesFor(sessionRecordSchema, {
    ...sessionRecord,
    status: "paused",
    schemaVersion: 2,
    eventSequence: -1,
    createdAt: "2026-02-30T00:00:00Z",
  });
  assert.ok(issues.includes("/status:enum"));
  assert.ok(issues.includes("/schemaVersion:const"));
  assert.ok(issues.includes("/eventSequence:minimum"));
  assert.ok(issues.includes("/createdAt:format"));
});

test("session records reject unknown fields and missing fields", () => {
  const { workspaceId, ...missing } = sessionRecord;
  void workspaceId;
  assert.ok(issuesFor(sessionRecordSchema, missing).includes("/:required"));
  assert.ok(
    issuesFor(sessionRecordSchema, { ...sessionRecord, extra: true }).includes(
      "/:additionalProperties",
    ),
  );
});

test("attachment refs require positive generations", () => {
  assert.deepEqual(issuesFor(attachmentRefSchema, attachmentRef), []);
  assert.ok(
    issuesFor(attachmentRefSchema, { ...attachmentRef, generation: 0 }).includes(
      "/generation:minimum",
    ),
  );
});

test("session descriptions and options validate", () => {
  const description = {
    session: sessionRecord,
    attachments: [
      {
        sessionId: "ses_01",
        attachmentId: "att_01",
        name: "build",
        generation: 2,
        status: "active",
        capabilityIds: ["exec.process@1"],
        leaseExpiresAt: "2026-09-11T13:00:00Z",
      },
    ],
    workspace: { workspaceId: "ws_01", headRevisionId: "rev_01" },
    unresolvedAllocations: [],
    pendingCleanup: [],
  };
  assert.deepEqual(issuesFor(sessionDescriptionSchema, description), []);
  const parsed = jsonRoundTrip(sessionDescriptionSchema, description);
  assert.deepEqual(parsed, description);

  assert.ok(
    issuesFor(sessionOptionsSchema, { policyRef: "" }).includes("/policyRef:minLength"),
  );
  assert.deepEqual(issuesFor(sessionOptionsSchema, { policyRef: "policy://x" }), []);
});

const invocationRequest: InvocationRequest = {
  attachment: attachmentRef,
  capability: "exec.process@1",
  operation: "run",
  input: { argv: ["ls", "-la"], workdir: "." },
  requestKey: "rk-001",
  timeoutMs: 30000,
};

test("invocation requests round-trip and reject malformed capability ids", () => {
  const parsed = jsonRoundTrip(invocationRequestSchema, invocationRequest);
  assert.deepEqual(parsed, invocationRequest);
  assert.ok(
    issuesFor(invocationRequestSchema, {
      ...invocationRequest,
      capability: "exec.process",
    }).includes("/capability:pattern"),
  );
  assert.ok(
    issuesFor(invocationRequestSchema, { ...invocationRequest, requestKey: "" }).includes(
      "/requestKey:minLength",
    ),
  );
  assert.ok(
    issuesFor(invocationRequestSchema, { ...invocationRequest, timeoutMs: -5 }).includes(
      "/timeoutMs:minimum",
    ),
  );
});

const operationRecord: OperationRecord = {
  id: "op_01",
  attachment: attachmentRef,
  capability: "exec.process@1",
  operation: "run",
  inputHash: HEX64,
  status: "unknown",
};

test("operation records validate status and input hash", () => {
  const parsed = jsonRoundTrip(operationRecordSchema, operationRecord);
  assert.deepEqual(parsed, operationRecord);
  assert.ok(
    issuesFor(operationRecordSchema, { ...operationRecord, status: "done" }).includes(
      "/status:enum",
    ),
  );
  assert.ok(
    issuesFor(operationRecordSchema, { ...operationRecord, inputHash: "xyz" }).includes(
      "/inputHash:pattern",
    ),
  );
});

const outputChunk: OutputChunk = {
  operationId: "op_01",
  stream: "stdout",
  sequence: 3,
  dataBase64: "aGVsbG8=",
  truncated: false,
  executionContinued: true,
};

test("output chunks keep streams separate and validated", () => {
  const parsed = jsonRoundTrip(outputChunkSchema, outputChunk);
  assert.deepEqual(parsed, outputChunk);
  assert.ok(
    issuesFor(outputChunkSchema, { ...outputChunk, stream: "combined" }).includes(
      "/stream:enum",
    ),
  );
  assert.ok(
    issuesFor(outputChunkSchema, { ...outputChunk, omittedBytes: -1 }).includes(
      "/omittedBytes:minimum",
    ),
  );
});

const artifact: ArtifactRecord = {
  digest: HEX64,
  sizeBytes: 128,
  mediaType: "application/octet-stream",
  retrieval: { kind: "artifact-store", location: "blobs/aa/aa" },
};

test("artifact records require retrieval metadata", () => {
  const parsed = jsonRoundTrip(artifactRecordSchema, artifact);
  assert.deepEqual(parsed, artifact);
  const { retrieval, ...withoutRetrieval } = artifact;
  void retrieval;
  assert.ok(
    issuesFor(artifactRecordSchema, withoutRetrieval).includes("/:required"),
  );
});

const resourceRef: ResourceRef = {
  id: "res_01",
  sessionId: "ses_01",
  type: "process",
  owner: attachmentRef,
  lifetime: "attachment",
  recovery: "native",
};

test("resource refs validate lifetime and recovery", () => {
  const parsed = jsonRoundTrip(resourceRefSchema, resourceRef);
  assert.deepEqual(parsed, resourceRef);
  assert.ok(
    issuesFor(resourceRefSchema, { ...resourceRef, lifetime: "session" }).includes(
      "/lifetime:enum",
    ),
  );
  const description: ResourceDescription = { ref: resourceRef, validity: "valid" };
  assert.deepEqual(issuesFor(resourceDescriptionSchema, description), []);
  assert.ok(
    issuesFor(resourceDescriptionSchema, { ...description, validity: "ok" }).includes(
      "/validity:enum",
    ),
  );
});

const revision: WorkspaceRevision = {
  id: "rev_01",
  workspaceId: "ws_01",
  parentId: "rev_00",
  rootHash: HEX64,
  createdAt: "2026-09-11T12:00:00Z",
};

test("workspace revisions require sha-256 root hashes", () => {
  assert.deepEqual(issuesFor(workspaceRevisionSchema, revision), []);
  assert.ok(
    issuesFor(workspaceRevisionSchema, { ...revision, rootHash: "abc" }).includes(
      "/rootHash:pattern",
    ),
  );
});

const proposal: WorkspaceProposal = {
  id: "prp_01",
  baseRevisionId: "rev_00",
  candidateRevisionId: "rev_01",
  source: attachmentRef,
  operationIds: ["op_01"],
};

test("workspace proposals round-trip", () => {
  const parsed = jsonRoundTrip(workspaceProposalSchema, proposal);
  assert.deepEqual(parsed, proposal);
});

const checkpoint: CheckpointRequest = {
  requestKey: "ck-001",
  source: { kind: "bridge", rootPath: "/tmp/repo" },
  expectedHead: "rev_01",
  exclusions: ["node_modules/", "dist/"],
};

test("checkpoint requests validate their source variant", () => {
  const parsed = jsonRoundTrip(checkpointRequestSchema, checkpoint);
  assert.deepEqual(parsed, checkpoint);
  const attachmentSource: CheckpointRequest = {
    requestKey: "ck-002",
    source: { kind: "attachment", attachment: attachmentRef },
  };
  assert.deepEqual(issuesFor(checkpointRequestSchema, attachmentSource), []);
  assert.notDeepEqual(
    issuesFor(checkpointRequestSchema, {
      requestKey: "ck-003",
      source: { kind: "clone", rootPath: "/tmp/x" },
    }),
    [],
  );
});

const event: PortableEvent = {
  schemaVersion: 1,
  sessionId: "ses_01",
  sequence: 9,
  occurredAt: "2026-09-11T12:01:00Z",
  type: "workspace.accepted",
  subjectId: "rev_01",
  data: { rootHash: HEX64 },
};

test("events validate required types and namespaced extensions", () => {
  const parsed = jsonRoundTrip(portableEventSchema, event);
  assert.deepEqual(parsed, event);
  assert.deepEqual(
    issuesFor(portableEventSchema, {
      ...event,
      type: "com.example.custom.thing",
    }),
    [],
  );
  assert.ok(
    issuesFor(portableEventSchema, { ...event, type: "random" }).includes("/type:anyOf"),
  );
  assert.ok(
    issuesFor(portableEventSchema, { ...event, sequence: -1 }).includes(
      "/sequence:minimum",
    ),
  );
});

const portableError: PortableError = {
  code: "StaleHandle",
  message: "generation mismatch",
  retry: "never",
  details: { expected: 2, actual: 1 },
};

test("portable errors validate codes and retry classes", () => {
  const parsed = jsonRoundTrip(portableErrorSchema, portableError);
  assert.deepEqual(parsed, portableError);
  assert.deepEqual(
    issuesFor(portableErrorSchema, {
      ...portableError,
      code: "com.example.limit.hit",
    }),
    [],
  );
  assert.ok(
    issuesFor(portableErrorSchema, { ...portableError, code: "Nope" }).includes(
      "/code:anyOf",
    ),
  );
  assert.ok(
    issuesFor(portableErrorSchema, { ...portableError, retry: "later" }).includes(
      "/retry:enum",
    ),
  );
});
