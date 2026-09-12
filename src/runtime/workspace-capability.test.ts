import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { PortableRuntime } from "./session.js";
import { checkpointWorkspace } from "./workspace.js";
import {
  WORKSPACE_CAPABILITY_ID,
  WorkspaceFiles,
  workspaceCapabilityDescriptor,
} from "./workspace-capability.js";
import { validateCapabilityDescriptors } from "../core/matching.js";
import { PolicyAuthority } from "../core/policy.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
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

/** One runtime, an in-memory store, a blob tree, and scratch roots. */
function fixture(): {
  runtime: PortableRuntime;
  store: ControlStore;
  blobs: BlobStore;
  done: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "porta-fs-"));
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(root, store);
  const runtime = new PortableRuntime(store);
  return { runtime, store, blobs, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fresh empty directory. */
function scratch(prefix: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Grant write permission back, so cleanup can remove a snapshot. */
function writableAgain(dir: string): void {
  try {
    chmodSync(dir, 0o755);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        writableAgain(path);
      } else {
        chmodSync(path, 0o644);
      }
    }
  } catch {
    // Cleanup is best effort: rmSync with force ignores what is left.
  }
}

/** One session with an imported base and two copies of it. */
async function setup(): Promise<{
  runtime: PortableRuntime;
  store: ControlStore;
  blobs: BlobStore;
  sessionId: string;
  workspaceId: string;
  baseRevisionId: string;
  readOnlyCopyId: string;
  proposalCopyId: string;
  proposalRoot: string;
  done: () => void;
  cleanup: Array<() => void>;
}> {
  const parts = fixture();
  const src = scratch("porta-src-");
  writeFileSync(join(src.dir, "app.txt"), "base");
  mkdirSync(join(src.dir, "sub"));
  writeFileSync(join(src.dir, "sub", "note.txt"), "note");
  const created = await parts.runtime.createSession({ policyRef: "policy://test" });
  const session = await parts.runtime.openSession(created.id);
  const imported = await session.checkpoint(
    parts.blobs,
    { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
    { stability: { kind: "locked" } },
  );
  const snapRoot = scratch("porta-snap-");
  const workRoot = scratch("porta-work-");
  const snap = await session.materialize(
    parts.blobs,
    imported.revision.id,
    join(snapRoot.dir, "snap"),
    { authority: LOCAL_AUTHORITY, mode: "read-only" },
  );
  const work = await session.materialize(
    parts.blobs,
    imported.revision.id,
    join(workRoot.dir, "work"),
    { authority: LOCAL_AUTHORITY, mode: "proposal" },
  );
  const described = await session.describe();
  return {
    runtime: parts.runtime,
    store: parts.store,
    blobs: parts.blobs,
    sessionId: created.id,
    workspaceId: described.workspace.workspaceId,
    baseRevisionId: imported.revision.id,
    readOnlyCopyId: snap.record.id,
    proposalCopyId: work.record.id,
    proposalRoot: work.record.rootPath,
    done: parts.done,
    cleanup: [
      src.done,
      () => {
        writableAgain(snapRoot.dir);
        snapRoot.done();
      },
      workRoot.done,
    ],
  };
}

/** Release every scratch directory of one setup. */
function release(parts: { done: () => void; cleanup: Array<() => void> }): void {
  parts.done();
  for (const clean of parts.cleanup) {
    clean();
  }
}

/** Run one operation and capture its error instead of throwing. */
async function refuse(run: () => unknown): Promise<{ code: string; details?: unknown } | null> {
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

test("the descriptor states the five operations of fs.workspace@1", () => {
  const descriptor = workspaceCapabilityDescriptor();
  assert.equal(descriptor.id, WORKSPACE_CAPABILITY_ID);
  assert.deepEqual(Object.keys(descriptor.operations).sort(), [
    "delete",
    "list",
    "read",
    "stat",
    "write",
  ]);
  // The descriptor itself satisfies the capability contract.
  validateCapabilityDescriptors([descriptor]);
  assert.equal(descriptor.operations.write!.effects, "workspace");
  assert.equal(descriptor.operations.read!.effects, "none");
});

test("a read-only copy serves reads and rejects every mutation", async () => {
  const parts = await setup();
  try {
    const files = new WorkspaceFiles(parts.store, parts.sessionId);

    const listed = files.list({ copyId: parts.readOnlyCopyId });
    assert.deepEqual(
      listed.entries.map((entry) => entry.path),
      ["app.txt", "sub", "sub/note.txt"],
    );
    const read = files.read({
      copyId: parts.readOnlyCopyId,
      path: "app.txt",
      encoding: "utf-8",
    });
    assert.equal(read.content, "base");
    assert.equal(read.sizeBytes, 4);
    assert.equal(
      files.stat({ copyId: parts.readOnlyCopyId, path: "sub" }).kind,
      "directory",
    );

    const write = await refuse(() =>
      files.write({
        copyId: parts.readOnlyCopyId,
        path: "app.txt",
        content: "changed",
        encoding: "utf-8",
      }),
    );
    assert.ok(write !== null && write.code === "InvalidRequest");
    assert.ok(JSON.stringify(write.details).includes("read-only-copy"));

    const removed = await refuse(() =>
      files.delete({ copyId: parts.readOnlyCopyId, path: "app.txt" }),
    );
    assert.ok(removed !== null && removed.code === "InvalidRequest");
    assert.ok(JSON.stringify(removed.details).includes("read-only-copy"));

    // Nothing changed on disk.
    const root = parts.store.getWorkingCopy(parts.readOnlyCopyId)!.rootPath;
    assert.equal(readFileSync(join(root, "app.txt"), "utf8"), "base");
  } finally {
    release(parts);
  }
});

test("every operation validates its path first", async () => {
  const parts = await setup();
  try {
    const files = new WorkspaceFiles(parts.store, parts.sessionId);
    const badPaths = ["/etc/passwd", "../escape", "a\\b", "a//b", ""];
    const calls: Array<() => unknown> = [
      () => files.list({ copyId: parts.proposalCopyId, path: "../escape" }),
      () => files.read({ copyId: parts.proposalCopyId, path: "../escape", encoding: "utf-8" }),
      () =>
        files.write({
          copyId: parts.proposalCopyId,
          path: "../escape",
          content: "x",
          encoding: "utf-8",
        }),
      () => files.delete({ copyId: parts.proposalCopyId, path: "../escape" }),
      () => files.stat({ copyId: parts.proposalCopyId, path: "../escape" }),
    ];
    for (const call of calls) {
      const refused = await refuse(call);
      assert.ok(refused !== null && refused.code === "InvalidRequest", `${call} refuses`);
    }
    // Each rule refuses too, not only the traversal form.
    for (const path of badPaths) {
      const refused = await refuse(() =>
        files.stat({ copyId: parts.proposalCopyId, path }),
      );
      assert.ok(refused !== null && refused.code === "InvalidRequest");
    }
    // Nothing landed outside the copy.
    assert.deepEqual(readdirSync(parts.proposalRoot).sort(), ["app.txt", "sub"]);
  } finally {
    release(parts);
  }
});

test("writes are atomic per file with explicit encodings", async () => {
  const parts = await setup();
  try {
    const files = new WorkspaceFiles(parts.store, parts.sessionId);
    const copyId = parts.proposalCopyId;

    // A write into a fresh subdirectory creates the parents.
    const written = files.write({
      copyId,
      path: "deep/dir/new.txt",
      content: "hello",
      encoding: "utf-8",
    });
    assert.equal(written.sizeBytes, 5);
    assert.equal(readFileSync(join(parts.proposalRoot, "deep/dir/new.txt"), "utf8"), "hello");

    // No temporary file survives a write.
    const replaced = files.write({
      copyId,
      path: "deep/dir/new.txt",
      content: "goodbye",
      encoding: "utf-8",
    });
    assert.equal(replaced.sizeBytes, 7);
    assert.equal(readFileSync(join(parts.proposalRoot, "deep/dir/new.txt"), "utf8"), "goodbye");
    assert.deepEqual(
      readdirSync(join(parts.proposalRoot, "deep/dir")).filter((name) => name.includes(".tmp-")),
      [],
    );

    // Binary content moves only under a named encoding.
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x92]);
    const binary = files.write({
      copyId,
      path: "blob.bin",
      content: bytes.toString("base64"),
      encoding: "base64",
    });
    assert.equal(binary.sizeBytes, 4);
    assert.deepEqual(new Uint8Array(readFileSync(join(parts.proposalRoot, "blob.bin"))), new Uint8Array(bytes));
    const back = files.read({ copyId, path: "blob.bin", encoding: "base64" });
    assert.equal(back.content, bytes.toString("base64"));
    assert.equal(back.contentHash, binary.contentHash);

    // Invalid base64 refuses instead of writing quietly lossy bytes.
    const invalid = await refuse(() =>
      files.write({ copyId, path: "bad.bin", content: "not base64 !!", encoding: "base64" }),
    );
    assert.ok(invalid !== null && invalid.code === "InvalidRequest");
    // The refused write left no file behind.
    const missing = await refuse(() => files.stat({ copyId, path: "bad.bin" }));
    assert.ok(missing !== null && missing.code === "InvalidRequest");

    // The executable bit is stated explicitly and survives.
    chmodSync(join(parts.proposalRoot, "app.txt"), 0o644);
    files.write({ copyId, path: "tool.sh", content: "#!/bin/sh\n", encoding: "utf-8", executable: true });
    assert.equal(files.stat({ copyId, path: "tool.sh" }).executable, true);
  } finally {
    release(parts);
  }
});

test("delete handles files, empty directories, and recursive trees", async () => {
  const parts = await setup();
  try {
    const files = new WorkspaceFiles(parts.store, parts.sessionId);
    const copyId = parts.proposalCopyId;

    const file = files.delete({ copyId, path: "app.txt" });
    assert.deepEqual(file, { removed: true, kind: "file" });

    // A non-empty directory refuses without recursive.
    const refused = await refuse(() => files.delete({ copyId, path: "sub" }));
    assert.ok(refused !== null && refused.code === "InvalidRequest");
    assert.ok(JSON.stringify(refused.details).includes("directory-needs-recursive"));

    const tree = files.delete({ copyId, path: "sub", recursive: true });
    assert.deepEqual(tree, { removed: true, kind: "directory" });

    const missing = await refuse(() => files.delete({ copyId, path: "gone.txt" }));
    assert.ok(missing !== null && missing.code === "InvalidRequest");
  } finally {
    release(parts);
  }
});

test("file operations hold no revision authority", async () => {
  const parts = await setup();
  try {
    const files = new WorkspaceFiles(parts.store, parts.sessionId);
    const copyId = parts.proposalCopyId;
    files.write({ copyId, path: "app.txt", content: "edited", encoding: "utf-8" });
    files.delete({ copyId, path: "sub/note.txt" });

    // The head never moved and no revision appeared: only a proposal
    // accepted by the coordinator can change authority.
    assert.equal(parts.store.getWorkspaceHead(parts.workspaceId), parts.baseRevisionId);
    assert.equal(parts.store.listWorkingCopies(parts.sessionId).length, 2);
    const described = await (await parts.runtime.openSession(parts.sessionId)).describe();
    assert.equal(described.workspace.headRevisionId, parts.baseRevisionId);

    // A closing session authorizes nothing.
    parts.store.casSessionStatus(parts.sessionId, ["open"], "closing");
    const closed = await refuse(() =>
      files.read({ copyId, path: "app.txt", encoding: "utf-8" }),
    );
    assert.ok(closed !== null && closed.code === "InvalidRequest");

    // Another session's copy refuses as well.
    parts.store.casSessionStatus(parts.sessionId, ["closing"], "open");
    const outsider = await parts.runtime.createSession({ policyRef: "policy://other" });
    const foreignFiles = new WorkspaceFiles(parts.store, outsider.id);
    const crossed = await refuse(() =>
      foreignFiles.read({ copyId, path: "app.txt", encoding: "utf-8" }),
    );
    assert.ok(crossed !== null && crossed.code === "InvalidRequest");
    const unknown = await refuse(() =>
      files.read({ copyId: "wc-missing", path: "app.txt", encoding: "utf-8" }),
    );
    assert.ok(unknown !== null && unknown.code === "InvalidRequest");
  } finally {
    release(parts);
  }
});
