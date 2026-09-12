import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { checkpointWorkspace, materializeRevision } from "./workspace.js";
import {
  manifestDigestOf,
  prepareVerificationRun,
  recordInvocationProvenance,
  settleVerificationRun,
} from "./provenance.js";
import type {
  ProvenanceCaptureRequest,
  ExecutionProvenance,
} from "../schema/workspace.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { EnvironmentManifest } from "../schema/capability.js";
import { PolicyAuthority } from "../core/policy.js";
import { ValidationError } from "../schema/validate.js";
import type { TreeEntry } from "../store/workspace-tree.js";

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

const LOCAL_AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["local"],
  locations: ["local", "remote"],
  networkEgress: "unrestricted",
  hostFilesystemAccess: true,
  maxEnvironmentLifetimeMs: 86_400_000,
  maxResources: {
    memoryBytes: 4 * 1024 ** 3,
    storageBytes: 4 * 1024 ** 3,
    gpuMemoryBytes: 4 * 1024 ** 3,
  },
});

/** One session, one imported revision, one worker copy, one attachment. */
function setup(): {
  store: ControlStore;
  sessionId: string;
  attachment: AttachmentSummary;
  blobs: BlobStore;
  baseRevisionId: string;
  workerCopyId: string;
  workerRoot: string;
  manifest: EnvironmentManifest;
  capture: (overrides?: Partial<ProvenanceCaptureRequest>) => ProvenanceCaptureRequest;
  dest: () => string;
  done: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "porta-prov-"));
  const workerRoot = join(root, "worker");
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(root, store);

  const source = join(root, "source");
  mkdirSync(join(source, "bin"), { recursive: true });
  writeFileSync(join(source, "app.txt"), "one");
  writeFileSync(join(source, "bin", "tool"), "#!/bin/sh\necho tool\n");
  mkdirSync(workerRoot);

  const sessionId = `sess-${randomUUID()}`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId: `ws-${randomUUID()}`,
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: new Date().toISOString(),
  });
  const imported = checkpointWorkspace(
    store,
    sessionId,
    blobs,
    { requestKey: "import-1", source: { kind: "bridge", rootPath: source } },
    { stability: { kind: "locked" } },
  );
  const baseRevisionId = imported.revision.id;
  const copy = materializeRevision(store, sessionId, blobs, baseRevisionId, workerRoot, {
    authority: LOCAL_AUTHORITY,
    mode: "proposal",
  });

  const attachment: AttachmentSummary = {
    sessionId,
    attachmentId: `att-${randomUUID()}`,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  };
  store.insertAttachment(attachment);

  const manifest: EnvironmentManifest = {
    environmentId: `env-${randomUUID()}`,
    providerId: "local-process",
    platform: { os: "linux", arch: "x64" },
    capabilities: [],
    enforcement: { isolation: "none" },
    adapterVersion: "9.9.9-prov",
  };
  const capture = (overrides: Partial<ProvenanceCaptureRequest> = {}): ProvenanceCaptureRequest => ({
    operationId: `op-${randomUUID()}`,
    attachment: {
      sessionId,
      attachmentId: attachment.attachmentId,
      generation: 1,
    },
    capability: "exec.process@1",
    operation: "run",
    arguments: { command: "/bin/sh", args: ["-c", "make check"] },
    workingCopyId: copy.record.id,
    ...overrides,
  });
  const dest = (): string => {
    const dir = join(root, `verify-${randomUUID()}`);
    mkdirSync(dir);
    return dir;
  };
  return {
    store,
    sessionId,
    attachment,
    blobs,
    baseRevisionId,
    workerCopyId: copy.record.id,
    workerRoot,
    manifest,
    capture,
    dest,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a capture records its base revision, copy, arguments, and environment", () => {
  const parts = setup();
  try {
    const request = parts.capture();
    const record = recordInvocationProvenance(parts.store, parts.sessionId, request, {
      manifest: parts.manifest,
      dependencyIds: ["npm:left-pad@1.0.0", "pip:pytest@8"],
      imageId: "img-sha256:abc123",
    });
    assert.equal(record.baseRevisionId, parts.baseRevisionId);
    assert.equal(record.workingCopyId, parts.workerCopyId);
    assert.deepEqual(record.arguments, { command: "/bin/sh", args: ["-c", "make check"] });
    assert.equal(record.adapterVersion, "9.9.9-prov");
    assert.deepEqual(record.dependencyIds, ["npm:left-pad@1.0.0", "pip:pytest@8"]);
    assert.equal(record.imageId, "img-sha256:abc123");

    // The manifest digest is canonical: equal manifests hash equally,
    // different ones differ.
    assert.match(record.manifestDigest ?? "", /^[0-9a-f]{64}$/);
    assert.equal(record.manifestDigest, manifestDigestOf(parts.manifest));
    const changed = manifestDigestOf({ ...parts.manifest, adapterVersion: "0.0.1" });
    assert.notEqual(record.manifestDigest, changed);

    // A plain capture claims nothing about tree state (SPEC.md 11.5).
    assert.equal(record.testedRevisionId, undefined);
    assert.equal(record.inputRootHash, undefined);
    assert.equal(record.copyModified, undefined);

    // One operation owns one record; the same request twice refuses.
    const duplicate = refuse(() =>
      recordInvocationProvenance(parts.store, parts.sessionId, request, {}),
    );
    assert.equal(duplicate?.code, "RequestConflict");

    // A request without arguments refuses schema validation.
    assert.throws(
      () =>
        recordInvocationProvenance(
          parts.store,
          parts.sessionId,
          parts.capture({
            arguments: undefined as unknown as { command: string },
          }),
          {},
        ),
      ValidationError,
    );

    // A copy of another session refuses.
    const stranger = refuse(() =>
      recordInvocationProvenance(
        parts.store,
        parts.sessionId,
        parts.capture({ workingCopyId: "wc-elsewhere" }),
        {},
      ),
    );
    assert.equal(stranger?.code, "InvalidRequest");

    // A replaced generation makes the handle stale.
    parts.store.casAttachment(parts.attachment.attachmentId, { generation: 1 }, {
      ...parts.attachment,
      generation: 2,
    });
    const stale = refuse(() =>
      recordInvocationProvenance(parts.store, parts.sessionId, parts.capture(), {}),
    );
    assert.equal(stale?.code, "StaleHandle");
  } finally {
    parts.done();
  }
});

test("a clean-copy verification tests the base revision and reports tracked changes", () => {
  const parts = setup();
  try {
    const request = parts.capture();
    const prepared = prepareVerificationRun(
      parts.store,
      parts.sessionId,
      parts.blobs,
      request,
      {
        authority: LOCAL_AUTHORITY,
        destination: parts.dest(),
        manifest: parts.manifest,
      },
    );
    assert.equal(prepared.provenance.copyModified, false);
    assert.equal(prepared.provenance.testedRevisionId, parts.baseRevisionId);
    assert.equal(prepared.provenance.inputRootHash, prepared.testedRevision.rootHash);

    // The private copy holds the tested tree.
    assert.equal(readFileSync(join(prepared.verificationCopy.rootPath, "app.txt"), "utf8"), "one");

    // The run modifies one tracked input and writes one new output.
    writeFileSync(join(prepared.verificationCopy.rootPath, "app.txt"), "two");
    mkdirSync(join(prepared.verificationCopy.rootPath, "out"));
    writeFileSync(join(prepared.verificationCopy.rootPath, "out", "result.txt"), "ok");

    const settled = settleVerificationRun(parts.store, parts.sessionId, parts.blobs, {
      operationId: request.operationId,
      attachment: request.attachment,
    });
    assert.notEqual(settled.outputRootHash, settled.inputRootHash);
    assert.deepEqual(settled.changedPaths, [
      { path: "app.txt", change: "modified" },
      { path: "out", change: "added" },
      { path: "out/result.txt", change: "added" },
    ]);
    assert.ok(settled.settledAt !== undefined);

    // The journal carries both durable events.
    const types = parts.store
      .listEvents(parts.sessionId, 0)
      .map((event) => event.type);
    assert.ok(types.includes("provenance.captured"));
    assert.ok(types.includes("provenance.recorded"));

    // A repeated settle returns the recorded answer unchanged, whatever
    // happens to the copy afterwards.
    writeFileSync(join(prepared.verificationCopy.rootPath, "late.txt"), "late");
    const again = settleVerificationRun(parts.store, parts.sessionId, parts.blobs, {
      operationId: request.operationId,
      attachment: request.attachment,
    });
    assert.equal(again.settledAt, settled.settledAt);
    assert.deepEqual(again.changedPaths, settled.changedPaths);
  } finally {
    parts.done();
  }
});

test("a repeated preparation returns the recorded staging without duplicating it", () => {
  const parts = setup();
  try {
    const request = parts.capture();
    const first = prepareVerificationRun(
      parts.store,
      parts.sessionId,
      parts.blobs,
      request,
      { authority: LOCAL_AUTHORITY, destination: parts.dest() },
    );

    // The retry — a lost response or a crashed caller — finds the
    // recorded staging: the same private copy, the same tested
    // revision, no second checkpoint or materialization.
    const second = prepareVerificationRun(
      parts.store,
      parts.sessionId,
      parts.blobs,
      request,
      { authority: LOCAL_AUTHORITY, destination: parts.dest() },
    );
    assert.equal(second.provenance.operationId, first.provenance.operationId);
    assert.equal(second.verificationCopy.id, first.verificationCopy.id);
    assert.equal(second.testedRevision.id, first.testedRevision.id);
    assert.equal(second.provenance.verificationCopyId, first.verificationCopy.id);

    // One capture event proves no duplicate staging landed.
    const captured = parts.store
      .listEvents(parts.sessionId, 0)
      .filter((event) => event.type === "provenance.captured");
    assert.equal(captured.length, 1);

    // An operation that holds a plain capture, not a verification run,
    // refuses a preparation instead of overwriting its record.
    const plain = parts.capture();
    recordInvocationProvenance(parts.store, parts.sessionId, plain, {});
    const mixed = refuse(() =>
      prepareVerificationRun(parts.store, parts.sessionId, parts.blobs, plain, {
        authority: LOCAL_AUTHORITY,
        destination: parts.dest(),
      }),
    );
    assert.equal(mixed?.code, "InvalidRequest");
  } finally {
    parts.done();
  }
});

test("a modified copy never claims it tested the base revision", () => {
  const parts = setup();
  try {
    writeFileSync(join(parts.workerRoot, "drift.txt"), "uncommitted change");
    const request = parts.capture();
    const prepared = prepareVerificationRun(
      parts.store,
      parts.sessionId,
      parts.blobs,
      request,
      { authority: LOCAL_AUTHORITY, destination: parts.dest() },
    );
    assert.equal(prepared.provenance.copyModified, true);
    assert.notEqual(prepared.provenance.testedRevisionId, parts.baseRevisionId);

    // The checkpoint revision records the actual tested state and its
    // parentage, and it never moved the workspace head.
    const checkpoint = parts.store.getRevision(prepared.provenance.testedRevisionId ?? "");
    assert.ok(checkpoint !== null);
    assert.equal(checkpoint.parentId, parts.baseRevisionId);
    assert.equal(checkpoint.rootHash, prepared.provenance.inputRootHash);
    assert.notEqual(checkpoint.rootHash, parts.store.getRevision(parts.baseRevisionId)?.rootHash);
    assert.equal(
      parts.store.getWorkspaceHead(
        parts.store.getSession(parts.sessionId)!.workspaceId,
      ),
      parts.baseRevisionId,
    );

    // The run changed nothing: the output tree equals the input tree.
    const settled = settleVerificationRun(parts.store, parts.sessionId, parts.blobs, {
      operationId: request.operationId,
      attachment: request.attachment,
    });
    assert.equal(settled.outputRootHash, settled.inputRootHash);
    assert.deepEqual(settled.changedPaths, []);
  } finally {
    parts.done();
  }
});

test("verification excludes unrelated writers of the original copy", () => {
  const parts = setup();
  try {
    const request = parts.capture();
    const prepared = prepareVerificationRun(
      parts.store,
      parts.sessionId,
      parts.blobs,
      request,
      { authority: LOCAL_AUTHORITY, destination: parts.dest() },
    );

    // After preparation, an unrelated writer touches the original copy.
    writeFileSync(join(parts.workerRoot, "unrelated.txt"), "someone else");

    // The run itself only writes its output inside the private copy.
    writeFileSync(join(prepared.verificationCopy.rootPath, "out.log"), "done");

    const settled = settleVerificationRun(parts.store, parts.sessionId, parts.blobs, {
      operationId: request.operationId,
      attachment: request.attachment,
    });
    assert.deepEqual(settled.changedPaths, [{ path: "out.log", change: "added" }]);
    const paths = (settled.changedPaths ?? []).map((change) => change.path);
    assert.ok(!paths.includes("unrelated.txt"));
  } finally {
    parts.done();
  }
});

test("configured exclusions keep dependency caches out of the checkpoint", () => {
  const parts = setup();
  try {
    // A dependency cache lands in the worker copy: an excluded change
    // leaves the tested tree clean.
    mkdirSync(join(parts.workerRoot, "node_modules"), { recursive: true });
    writeFileSync(join(parts.workerRoot, "node_modules", "junk.js"), "cache");
    const excluded = prepareVerificationRun(
      parts.store,
      parts.sessionId,
      parts.blobs,
      parts.capture(),
      {
        authority: LOCAL_AUTHORITY,
        destination: parts.dest(),
        exclusions: ["node_modules"],
      },
    );
    assert.equal(excluded.provenance.copyModified, false);
    assert.equal(excluded.provenance.testedRevisionId, parts.baseRevisionId);
    const entries = JSON.parse(
      parts.store.getRevisionTree(excluded.provenance.testedRevisionId ?? "")!.entriesJson,
    ) as TreeEntry[];
    assert.ok(entries.every((entry) => !entry.path.startsWith("node_modules")));

    // Without the exclusion the same cache makes the copy modified: the
    // exclusion is what kept the record honest about the base.
    const included = prepareVerificationRun(
      parts.store,
      parts.sessionId,
      parts.blobs,
      parts.capture(),
      { authority: LOCAL_AUTHORITY, destination: parts.dest() },
    );
    assert.equal(included.provenance.copyModified, true);
    assert.notEqual(included.provenance.testedRevisionId, parts.baseRevisionId);
  } finally {
    parts.done();
  }
});

test("settling refuses what it cannot measure", () => {
  const parts = setup();
  try {
    // No record: unknown operation.
    const unknown = refuse(() =>
      settleVerificationRun(parts.store, parts.sessionId, parts.blobs, {
        operationId: "op-never",
        attachment: {
          sessionId: parts.sessionId,
          attachmentId: parts.attachment.attachmentId,
          generation: 1,
        },
      }),
    );
    assert.equal(unknown?.code, "InvalidRequest");

    // A plain capture holds no verification state to settle.
    const request = parts.capture();
    const plain = recordInvocationProvenance(parts.store, parts.sessionId, request, {});
    assert.ok(plain.verificationCopyId === undefined);
    const notVerification = refuse(() =>
      settleVerificationRun(parts.store, parts.sessionId, parts.blobs, {
        operationId: request.operationId,
        attachment: request.attachment,
      }),
    );
    assert.equal(notVerification?.code, "UnsupportedOperation");
    assert.equal(
      (notVerification?.details as { reason?: string }).reason,
      "not-a-verification-run",
    );

    // The record exists and is complete: it validates against the
    // public schema.
    const verified: ExecutionProvenance = { ...plain };
    assert.equal(verified.operationId, request.operationId);
  } finally {
    parts.done();
  }
});
