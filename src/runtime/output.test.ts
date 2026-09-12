import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PolicyAuthority } from "../core/policy.js";
import type { InvocationRequest, OperationRecord } from "../schema/operation.js";
import type { AttachmentSummary } from "../schema/session.js";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { admitInvocation } from "./admission.js";
import type { AdmissionOptions } from "./admission.js";
import { claimOperationDispatch } from "./outcomes.js";
import {
  readArtifact,
  readOutputStream,
  recordOutputChunk,
  recordResultArtifact,
} from "./output.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
function refuse(run: () => unknown): { code: string; details?: unknown } | null {
  try {
    run();
  } catch (error) {
    if (isPortableCode(error)) {
      return error;
    }
    throw error;
  }
  return null;
}

const AUTHORITY: AdmissionOptions = {
  authority: PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    operations: ["exec.process@1"],
    locations: ["local", "remote"],
    networkEgress: "unrestricted",
    hostFilesystemAccess: true,
    maxEnvironmentLifetimeMs: 86_400_000,
    maxResources: {
      memoryBytes: 4 * 1024 ** 3,
      storageBytes: 4 * 1024 ** 3,
      gpuMemoryBytes: 4 * 1024 ** 3,
    },
  }),
};

/** One session with one active attachment, one admitted operation, and blobs. */
function setup(): {
  store: ControlStore;
  blobs: BlobStore;
  sessionId: string;
  operation: OperationRecord;
  done: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "porta-out-"));
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(root, store);
  const sessionId = `sess-${randomUUID()}`;
  const attachmentId = `att-${randomUUID()}`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId: `ws-${randomUUID()}`,
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: new Date().toISOString(),
  });
  const attachment: AttachmentSummary = {
    sessionId,
    attachmentId,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  };
  store.insertAttachment(attachment);
  const request: InvocationRequest = {
    attachment: { sessionId, attachmentId, generation: 1 },
    capability: "exec.process@1",
    operation: "run",
    input: { command: "sh", args: ["-c", "echo hi; echo ho >&2"] },
    requestKey: "invoke-1",
  };
  const admitted = admitInvocation(store, sessionId, request, AUTHORITY);
  claimOperationDispatch(store, sessionId, admitted.operation.id);
  return {
    store,
    blobs,
    sessionId,
    operation: admitted.operation,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("output streams stay separate with per-stream sequences", () => {
  const parts = setup();
  try {
    const operationId = parts.operation.id;

    // Two chunks of stdout and one of stderr interleave; each stream
    // numbers only itself.
    const one = recordOutputChunk(parts.store, parts.sessionId, operationId, {
      stream: "stdout",
      data: "hello ",
      truncated: false,
      executionContinued: true,
    });
    const two = recordOutputChunk(parts.store, parts.sessionId, operationId, {
      stream: "stderr",
      data: "warning",
      truncated: false,
      executionContinued: true,
    });
    const three = recordOutputChunk(parts.store, parts.sessionId, operationId, {
      stream: "stdout",
      data: "world",
      truncated: false,
      executionContinued: false,
    });
    assert.equal(one.sequence, 1);
    assert.equal(two.sequence, 1);
    assert.equal(three.sequence, 2);

    const stdout = readOutputStream(parts.store, parts.sessionId, operationId, "stdout");
    const stderr = readOutputStream(parts.store, parts.sessionId, operationId, "stderr");
    assert.deepEqual(
      stdout.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")),
      ["hello ", "world"],
    );
    assert.deepEqual(
      stderr.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")),
      ["warning"],
    );
    assert.equal(stdout[0]?.executionContinued, true);
    assert.equal(stdout[1]?.executionContinued, false);

    // Reading after a sequence resumes where the reader left off.
    const resumed = readOutputStream(parts.store, parts.sessionId, operationId, "stdout", 1);
    assert.equal(resumed.length, 1);
    assert.equal(Buffer.from(resumed[0]?.dataBase64 ?? "", "base64").toString("utf8"), "world");

    // Every chunk journaled as an operation.output event.
    const events = parts.store
      .listEvents(parts.sessionId, 0)
      .filter((event) => event.type === "operation.output");
    assert.equal(events.length, 3);

    // A foreign session and an unknown operation refuse.
    const crossed = refuse(() =>
      readOutputStream(parts.store, "sess-other", operationId, "stdout"),
    );
    assert.ok(crossed !== null && crossed.code === "InvalidRequest");
    const missing = refuse(() =>
      recordOutputChunk(parts.store, parts.sessionId, "op-missing", {
        stream: "stdout",
        data: "x",
        truncated: false,
        executionContinued: true,
      }),
    );
    assert.ok(missing !== null && missing.code === "InvalidRequest");
  } finally {
    parts.done();
  }
});

test("binary chunks, truncation, and omitted bytes are reported", () => {
  const parts = setup();
  try {
    const operationId = parts.operation.id;
    const bytes = Uint8Array.from([0x00, 0xff, 0x10, 0x92, 0x0a]);

    const binary = recordOutputChunk(parts.store, parts.sessionId, operationId, {
      stream: "stdout",
      data: bytes,
      truncated: false,
      executionContinued: true,
    });
    const round = Buffer.from(binary.dataBase64, "base64");
    assert.deepEqual(new Uint8Array(round), bytes);

    const cut = recordOutputChunk(parts.store, parts.sessionId, operationId, {
      stream: "stdout",
      data: "0123456789",
      truncated: true,
      omittedBytes: 4096,
      executionContinued: true,
    });
    assert.equal(cut.truncated, true);
    assert.equal(cut.omittedBytes, 4096);

    // Truncation without a known count omits the field, not a guess.
    const unknown = recordOutputChunk(parts.store, parts.sessionId, operationId, {
      stream: "stderr",
      data: "partial",
      truncated: true,
      executionContinued: false,
    });
    assert.equal(unknown.truncated, true);
    assert.equal(unknown.omittedBytes, undefined);
    assert.equal(unknown.executionContinued, false);

    // The journal carries the byte length and the omitted count.
    const last = parts.store
      .listEvents(parts.sessionId, 0)
      .filter((event) => event.type === "operation.output")
      .map((event) => event.data as { omittedBytes?: number; byteLength?: number });
    assert.deepEqual(last.map((data) => data.omittedBytes), [undefined, 4096, undefined]);
    assert.deepEqual(last.map((data) => data.byteLength), [5, 10, 7]);
  } finally {
    parts.done();
  }
});

test("artifacts are content-addressed, verified, and credential-free", () => {
  const parts = setup();
  try {
    const operationId = parts.operation.id;
    const payload = JSON.stringify({ result: [1, 2, 3] });

    const artifact = recordResultArtifact(parts.store, parts.blobs, parts.sessionId, operationId, {
      data: payload,
      mediaType: "application/json",
    });
    assert.equal(artifact.sizeBytes, payload.length);
    assert.equal(artifact.mediaType, "application/json");
    assert.equal(artifact.retrieval.kind, "artifact-store");
    // The location is a bare digest reference: no credential rides in it.
    assert.ok(!JSON.stringify(artifact.retrieval).match(/token|password|secret|key/i));
    assert.match(artifact.retrieval.location, /^blob:sha256:[0-9a-f]{64}$/);

    // Reading returns the exact bytes after digest verification.
    const read = readArtifact(parts.store, parts.blobs, parts.sessionId, artifact.digest);
    assert.equal(Buffer.from(read.data).toString("utf8"), payload);
    assert.equal(read.record.digest, artifact.digest);

    // The same bytes deduplicate to the same record.
    const again = recordResultArtifact(parts.store, parts.blobs, parts.sessionId, operationId, {
      data: payload,
      mediaType: "application/json",
    });
    assert.equal(again.digest, artifact.digest);

    // Binary artifacts travel under an explicit encoding.
    const binary = recordResultArtifact(parts.store, parts.blobs, parts.sessionId, operationId, {
      data: Buffer.from([0x00, 0x01, 0x02]).toString("base64"),
      encoding: "base64",
      mediaType: "application/octet-stream",
    });
    assert.equal(binary.sizeBytes, 3);
    const binaryRead = readArtifact(parts.store, parts.blobs, parts.sessionId, binary.digest);
    assert.deepEqual(new Uint8Array(binaryRead.data), Uint8Array.from([0, 1, 2]));

    // Invalid base64 refuses instead of storing lossy bytes.
    const invalid = refuse(() =>
      recordResultArtifact(parts.store, parts.blobs, parts.sessionId, operationId, {
        data: "not base64 !!",
        encoding: "base64",
        mediaType: "application/octet-stream",
      }),
    );
    assert.ok(invalid !== null && invalid.code === "InvalidRequest");

    // An unknown digest and a foreign session refuse.
    const missing = refuse(() =>
      readArtifact(parts.store, parts.blobs, parts.sessionId, "a".repeat(64)),
    );
    assert.ok(missing !== null && missing.code === "InvalidRequest");
    const crossed = refuse(() =>
      readArtifact(parts.store, parts.blobs, "sess-other", artifact.digest),
    );
    assert.ok(crossed !== null && crossed.code === "InvalidRequest");

    // Both artifacts answer by digest through the session.
    assert.ok(
      parts.store.getArtifact(parts.sessionId, artifact.digest) !== null &&
        parts.store.getArtifact(parts.sessionId, binary.digest) !== null,
    );
  } finally {
    parts.done();
  }
});
