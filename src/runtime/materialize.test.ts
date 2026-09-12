import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { PortableRuntime } from "./session.js";
import { checkpointWorkspace, materializeRevision } from "./workspace.js";
import { canonicalTreeJson, treeRootHash } from "../store/workspace-tree.js";
import type { TreeEntry } from "../store/workspace-tree.js";
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

/** One runtime, an in-memory store, a blob tree, and a source directory. */
function fixture(): {
  runtime: PortableRuntime;
  store: ControlStore;
  blobs: BlobStore;
  done: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "porta-mat-"));
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

/** Import a small tree and return the revision identifier. */
async function importedRevision(
  runtime: PortableRuntime,
  blobs: BlobStore,
  dir: string,
): Promise<string> {
  const session = await runtime.createSession({ policyRef: "policy://test" });
  const outcome = checkpointWorkspace(
    runtime.controlStore,
    session.id,
    blobs,
    { requestKey: "import-1", source: { kind: "bridge", rootPath: dir } },
    { stability: { kind: "locked" } },
  );
  return outcome.revision.id;
}

test("a read-only snapshot materializes without write permission", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "app.txt"), "kept");
    mkdirSync(join(src.dir, "bin"));
    writeFileSync(join(src.dir, "bin", "tool"), "#!/bin/sh\n");
    chmodSync(join(src.dir, "bin", "tool"), 0o755);
    const revisionId = await importedRevision(runtime, blobs, src.dir);
    const sessionId = store.listSessionIds()[0]!;
    const session = await runtime.openSession(sessionId);

    const copy = await session.materialize(blobs, revisionId, join(dest.dir, "snap"), {
      authority: LOCAL_AUTHORITY,
      mode: "read-only",
    });
    assert.equal(copy.record.mode, "read-only");
    assert.equal(copy.record.baseRevisionId, revisionId);
    assert.equal(copy.entryCount, 3);
    assert.equal(statSync(join(dest.dir, "snap", "app.txt")).mode & 0o222, 0);
    assert.equal(statSync(join(dest.dir, "snap", "app.txt")).mode & 0o444, 0o444);
    assert.equal(statSync(join(dest.dir, "snap", "bin", "tool")).mode & 0o111, 0o111);
    assert.equal(statSync(join(dest.dir, "snap", "bin")).mode & 0o222, 0);
    assert.equal(readFileSync(join(dest.dir, "snap", "app.txt"), "utf8"), "kept");
    assert.deepEqual(store.listWorkingCopies(sessionId).map((record) => record.mode), [
      "read-only",
    ]);
  } finally {
    writableAgain(dest.dir);
    done();
    src.done();
    dest.done();
  }
});

test("a private working copy materializes writable and stays off the head path", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "app.txt"), "base");
    const revisionId = await importedRevision(runtime, blobs, src.dir);
    const sessionId = store.listSessionIds()[0]!;
    const session = await runtime.openSession(sessionId);
    const workspaceId = (await session.describe()).workspace.workspaceId;

    const copy = await session.materialize(blobs, revisionId, join(dest.dir, "work"), {
      authority: LOCAL_AUTHORITY,
      mode: "proposal",
    });
    assert.equal(copy.record.mode, "proposal");
    assert.equal(statSync(join(dest.dir, "work", "app.txt")).mode & 0o200, 0o200);

    // The copy is mutable by its owner.
    writeFileSync(join(dest.dir, "work", "app.txt"), "edited");
    assert.equal(readFileSync(join(dest.dir, "work", "app.txt"), "utf8"), "edited");
    // The revision it came from never moved.
    assert.equal(store.getWorkspaceHead(workspaceId), revisionId);

    // The bridge refuses to import the private copy directly: private
    // copies reach the head only through a proposal.
    const bridged = await session
      .checkpoint(
        blobs,
        { requestKey: "copy-1", source: { kind: "bridge", rootPath: join(dest.dir, "work") }, expectedHead: revisionId },
        { stability: { kind: "locked" } },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(bridged) && bridged.code === "InvalidRequest");
    assert.ok(JSON.stringify(bridged?.details).includes("working-copy-source"));
    assert.equal(store.getWorkspaceHead(workspaceId), revisionId);

    // A bridge import of an unregistered directory still works.
    const bridge = await session.checkpoint(
      blobs,
      { requestKey: "bridge-1", source: { kind: "bridge", rootPath: src.dir }, expectedHead: revisionId },
      { stability: { kind: "locked" } },
    );
    assert.equal(bridge.created, true);
    assert.equal(store.getWorkingCopyByPath(sessionId, join(dest.dir, "work"))?.id, copy.record.id);
  } finally {
    done();
    src.done();
    dest.done();
  }
});

test("transfer policy is checked before any byte leaves the source", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "a.txt"), "one");
    const revisionId = await importedRevision(runtime, blobs, src.dir);
    const sessionId = store.listSessionIds()[0]!;
    const session = await runtime.openSession(sessionId);
    const closed = PolicyAuthority.fromPolicy({ schemaVersion: 1 });
    const remoteOnly = PolicyAuthority.fromPolicy({
      schemaVersion: 1,
      transferDestinations: ["remote"],
    });

    // A denied destination refuses even a revision that does not
    // exist: the policy check runs first.
    for (const authority of [closed, remoteOnly]) {
      const denied = await session
        .materialize(blobs, "rev-missing", join(dest.dir, "snap"), {
          authority,
          mode: "read-only",
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      assert.ok(isPortableCode(denied) && denied.code === "PolicyDenied");
    }
    // Nothing was written and nothing was registered.
    assert.deepEqual(readdirSync(dest.dir), []);
    assert.deepEqual(store.listWorkingCopies(sessionId), []);

    // An occupied destination refuses without touching its content.
    mkdirSync(join(dest.dir, "snap"));
    writeFileSync(join(dest.dir, "snap", "precious.txt"), "keep");
    const occupied = await session
      .materialize(blobs, revisionId, join(dest.dir, "snap"), {
        authority: LOCAL_AUTHORITY,
        mode: "read-only",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(occupied) && occupied.code === "InvalidRequest");
    assert.equal(readFileSync(join(dest.dir, "snap", "precious.txt"), "utf8"), "keep");
  } finally {
    done();
    src.done();
    dest.done();
  }
});

test("materialization verifies manifest and blob hashes before writing", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "a.txt"), "one");
    const revisionId = await importedRevision(runtime, blobs, src.dir);
    const sessionId = store.listSessionIds()[0]!;
    const session = await runtime.openSession(sessionId);
    const options = { authority: LOCAL_AUTHORITY, mode: "read-only" as const };

    // A revision without a stored manifest refuses.
    store.insertRevision(
      {
        id: "rev-no-tree",
        workspaceId: (await session.describe()).workspace.workspaceId,
        rootHash: "ab".repeat(32),
        createdAt: "2026-01-01T00:00:00Z",
      },
      [],
    );
    const noTree = await session
      .materialize(blobs, "rev-no-tree", join(dest.dir, "a"), options)
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(noTree) && noTree.code === "IntegrityFailure");

    // A manifest whose hash disagrees with the revision refuses.
    const tree = store.getRevisionTree(revisionId)!;
    store.insertRevision(
      {
        id: "rev-wrong-hash",
        workspaceId: (await session.describe()).workspace.workspaceId,
        rootHash: "cd".repeat(32),
        createdAt: "2026-01-01T00:00:00Z",
      },
      [],
    );
    store.insertRevisionTree("rev-wrong-hash", tree.rootHash, tree.entriesJson);
    const mismatch = await session
      .materialize(blobs, "rev-wrong-hash", join(dest.dir, "b"), options)
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(mismatch) && mismatch.code === "IntegrityFailure");

    // A manifest referencing an absent blob refuses and leaves the
    // destination empty.
    store.insertRevision(
      {
        id: "rev-absent-blob",
        workspaceId: (await session.describe()).workspace.workspaceId,
        rootHash: "ef".repeat(32),
        createdAt: "2026-01-01T00:00:00Z",
      },
      [],
    );
    store.insertRevisionTree(
      "rev-absent-blob",
      "ef".repeat(32),
      JSON.stringify([
        { path: "gone.txt", kind: "file", executable: false, contentHash: "99".repeat(32) },
      ]),
    );
    const absent = await session
      .materialize(blobs, "rev-absent-blob", join(dest.dir, "c"), options)
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(absent) && absent.code === "IntegrityFailure");
    assert.deepEqual(readdirSync(dest.dir), []);

    // A name the filesystem cannot represent refuses explicitly. The
    // referenced blob exists, so the name itself is what fails.
    const longName = `${"x".repeat(300)}.txt`;
    const realDigest = (JSON.parse(tree.entriesJson) as Array<{ contentHash: string }>)[0]!
      .contentHash;
    const longEntries: TreeEntry[] = [
      { path: longName, kind: "file", executable: false, contentHash: realDigest },
    ];
    store.insertRevision(
      {
        id: "rev-long-name",
        workspaceId: (await session.describe()).workspace.workspaceId,
        rootHash: treeRootHash(longEntries),
        createdAt: "2026-01-01T00:00:00Z",
      },
      [realDigest],
    );
    store.insertRevisionTree("rev-long-name", treeRootHash(longEntries), canonicalTreeJson(longEntries));
    const unrepresentable = await session
      .materialize(blobs, "rev-long-name", join(dest.dir, "d"), options)
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(unrepresentable) && unrepresentable.code === "InvalidRequest");
    assert.ok(JSON.stringify(unrepresentable?.details).includes("unrepresentable-name"));

    // The intact revision still materializes after all the refusals.
    const copy = await session.materialize(blobs, revisionId, join(dest.dir, "e"), options);
    assert.equal(copy.entryCount, 1);
  } finally {
    done();
    src.done();
    dest.done();
  }
});

test("closing sessions accept no new copies", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "a.txt"), "one");
    const revisionId = await importedRevision(runtime, blobs, src.dir);
    const sessionId = store.listSessionIds()[0]!;
    store.casSessionStatus(sessionId, ["open"], "closing");
    let refused: unknown = null;
    try {
      materializeRevision(store, sessionId, blobs, revisionId, join(dest.dir, "snap"), {
        authority: LOCAL_AUTHORITY,
        mode: "read-only",
      });
    } catch (error) {
      refused = error;
    }
    assert.ok(isPortableCode(refused) && refused.code === "InvalidRequest");
    assert.deepEqual(store.listWorkingCopies(sessionId), []);
  } finally {
    done();
    src.done();
    dest.done();
  }
});
