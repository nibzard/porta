import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { exportRevision, recoverBridgeExport } from "./export.js";
import { checkpointWorkspace } from "./workspace.js";
import { scanTreeFromDirectory } from "../store/workspace-tree.js";
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

const RESERVED = new Set([
  ".portable-bridge.lock",
  ".portable-bridge.state",
  ".portable-bridge.journal",
  ".portable-bridge.stage",
]);

/** One runtime, an in-memory store, a blob tree, and scratch roots. */
function fixture(): {
  runtime: PortableRuntime;
  store: ControlStore;
  blobs: BlobStore;
  done: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "porta-exp-"));
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

/** The non-reserved paths one directory holds right now, as a set. */
function contentOf(dir: string): Set<string> {
  return new Set(
    scanTreeFromDirectory(dir, { exclusions: [...RESERVED] }).entries.map((entry) => entry.path),
  );
}

test("an export writes a revision and records the destination base", async () => {
  const parts = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "app.txt"), "one");
    const runtime = parts.runtime;
    const sessionId = (await runtime.createSession({ policyRef: "policy://test" })).id;
    const session = await runtime.openSession(sessionId);
    const first = await session.checkpoint(
      parts.blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
      { stability: { kind: "locked" } },
    );

    const outcome = await session.export(
      parts.blobs,
      { revisionId: first.revision.id, destination: join(dest.dir, "out") },
      { authority: LOCAL_AUTHORITY },
    );
    assert.equal(outcome.revisionId, first.revision.id);
    assert.equal(outcome.fileCount, 1);
    assert.equal(readFileSync(join(dest.dir, "out", "app.txt"), "utf8"), "one");
    assert.deepEqual(contentOf(join(dest.dir, "out")), new Set(["app.txt"]));
    // The reserved bridge files never count as tree content.
    assert.ok(existsSync(join(dest.dir, "out", ".portable-bridge.state")));

    // A later revision replaces content and removes what it drops.
    writeFileSync(join(src.dir, "app.txt"), "two");
    writeFileSync(join(src.dir, "extra.txt"), "new");
    const second = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-2",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: first.revision.id,
      },
      { stability: { kind: "locked" } },
    );
    const updated = await session.export(
      parts.blobs,
      { revisionId: second.revision.id, destination: join(dest.dir, "out") },
      { authority: LOCAL_AUTHORITY, expectedBaseRevisionId: first.revision.id },
    );
    assert.equal(updated.revisionId, second.revision.id);
    assert.deepEqual(contentOf(join(dest.dir, "out")), new Set(["app.txt", "extra.txt"]));
    assert.equal(readFileSync(join(dest.dir, "out", "app.txt"), "utf8"), "two");

    // Deletions propagate: dropping extra.txt removes it on export.
    rmSync(join(src.dir, "extra.txt"));
    const third = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-3",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: second.revision.id,
      },
      { stability: { kind: "locked" } },
    );
    await session.export(
      parts.blobs,
      { revisionId: third.revision.id, destination: join(dest.dir, "out") },
      { authority: LOCAL_AUTHORITY },
    );
    assert.deepEqual(contentOf(join(dest.dir, "out")), new Set(["app.txt"]));
  } finally {
    parts.done();
    src.done();
    dest.done();
  }
});

test("changed local files conflict before any overwrite", async () => {
  const parts = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "app.txt"), "one");
    const runtime = parts.runtime;
    const sessionId = (await runtime.createSession({ policyRef: "policy://test" })).id;
    const session = await runtime.openSession(sessionId);
    const first = await session.checkpoint(
      parts.blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
      { stability: { kind: "locked" } },
    );
    const target = join(dest.dir, "out");
    await session.export(
      parts.blobs,
      { revisionId: first.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );

    // A newer revision exists, but the destination drifted.
    writeFileSync(join(src.dir, "app.txt"), "two");
    const second = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-2",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: first.revision.id,
      },
      { stability: { kind: "locked" } },
    );
    writeFileSync(join(target, "app.txt"), "precious local edit");

    const conflict = await session
      .export(parts.blobs, { revisionId: second.revision.id, destination: target }, { authority: LOCAL_AUTHORITY })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(conflict) && conflict.code === "WorkspaceConflict");
    assert.ok(JSON.stringify(conflict?.details).includes("changed-local-files"));
    // The local edit survived untouched.
    assert.equal(readFileSync(join(target, "app.txt"), "utf8"), "precious local edit");

    // A destination with files but no recorded base refuses as well.
    const stray = join(dest.dir, "stray");
    writeFileSync(stray, "unknown origin");
    const unverified = await session
      .export(parts.blobs, { revisionId: second.revision.id, destination: dest.dir }, { authority: LOCAL_AUTHORITY })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.equal(readFileSync(stray, "utf8"), "unknown origin");
    assert.ok(isPortableCode(unverified) && unverified.code === "WorkspaceConflict");
    assert.ok(JSON.stringify(unverified?.details).includes("unverified-destination"));
  } finally {
    parts.done();
    src.done();
    dest.done();
  }
});

test("an exclusive bridge lock protects export and recovery", async () => {
  const parts = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "app.txt"), "one");
    const runtime = parts.runtime;
    const sessionId = (await runtime.createSession({ policyRef: "policy://test" })).id;
    const session = await runtime.openSession(sessionId);
    const first = await session.checkpoint(
      parts.blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
      { stability: { kind: "locked" } },
    );
    const target = join(dest.dir, "out");
    await session.export(
      parts.blobs,
      { revisionId: first.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );

    // A held lock refuses both export and recovery.
    const lockPath = join(target, ".portable-bridge.lock");
    writeFileSync(lockPath, "999999 2026-01-01T00:00:00Z");
    writeFileSync(join(src.dir, "app.txt"), "two");
    const second = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-2",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: first.revision.id,
      },
      { stability: { kind: "locked" } },
    );
    const busyExport = await session
      .export(parts.blobs, { revisionId: second.revision.id, destination: target }, { authority: LOCAL_AUTHORITY })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(busyExport) && busyExport.code === "WorkspaceUnstable");
    const busyRecovery = await session
      .recoverExport(parts.blobs, target, { authority: LOCAL_AUTHORITY })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(busyRecovery) && busyRecovery.code === "WorkspaceUnstable");
    assert.equal(readFileSync(join(target, "app.txt"), "utf8"), "one");
  } finally {
    parts.done();
    src.done();
    dest.done();
  }
});

test("a crash mid-apply completes from the staging tree", async () => {
  const parts = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "app.txt"), "one");
    const runtime = parts.runtime;
    const sessionId = (await runtime.createSession({ policyRef: "policy://test" })).id;
    const session = await runtime.openSession(sessionId);
    const first = await session.checkpoint(
      parts.blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
      { stability: { kind: "locked" } },
    );
    const target = join(dest.dir, "out");
    await session.export(
      parts.blobs,
      { revisionId: first.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );

    // A newer revision changes one file and adds another.
    writeFileSync(join(src.dir, "app.txt"), "two");
    writeFileSync(join(src.dir, "new.txt"), "fresh");
    const second = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-2",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: first.revision.id,
      },
      { stability: { kind: "locked" } },
    );

    // Stage and journal like an export would, then "crash" after only
    // one file of the apply landed.
    const staged = join(target, ".portable-bridge.stage");
    await simulatePrepare(parts, target, second.revision.id);
      mkdirSync(join(target), { recursive: true });
    copyFileSync(join(staged, "new.txt"), join(target, "new.txt"));

    const outcome = await session.recoverExport(parts.blobs, target, { authority: LOCAL_AUTHORITY });
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.restored, false);
    assert.equal(outcome.revisionId, second.revision.id);
    assert.equal(readFileSync(join(target, "app.txt"), "utf8"), "two");
    assert.equal(readFileSync(join(target, "new.txt"), "utf8"), "fresh");
    assert.equal(existsSync(join(target, ".portable-bridge.journal")), false);
    assert.equal(existsSync(staged), false);

    // The completed destination accepts the next export normally.
    writeFileSync(join(src.dir, "app.txt"), "three");
    const third = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-3",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: second.revision.id,
      },
      { stability: { kind: "locked" } },
    );
    const next = await session.export(
      parts.blobs,
      { revisionId: third.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );
    assert.equal(next.recovered, false);
    assert.equal(readFileSync(join(target, "app.txt"), "utf8"), "three");
  } finally {
    parts.done();
    src.done();
    dest.done();
  }
});

test("a crash that lost the staging tree restores the recorded base", async () => {
  const parts = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  try {
    writeFileSync(join(src.dir, "app.txt"), "one");
    const runtime = parts.runtime;
    const sessionId = (await runtime.createSession({ policyRef: "policy://test" })).id;
    const session = await runtime.openSession(sessionId);
    const first = await session.checkpoint(
      parts.blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
      { stability: { kind: "locked" } },
    );
    const target = join(dest.dir, "out");
    await session.export(
      parts.blobs,
      { revisionId: first.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );

    writeFileSync(join(src.dir, "app.txt"), "two");
    const second = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-2",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: first.revision.id,
      },
      { stability: { kind: "locked" } },
    );
    await simulatePrepare(parts, target, second.revision.id);
    // The staging tree is gone, and one file of the apply landed.
    rmSync(join(target, ".portable-bridge.stage"), { recursive: true, force: true });
    writeFileSync(join(target, "app.txt"), "two");

    const outcome = await session.recoverExport(parts.blobs, target, { authority: LOCAL_AUTHORITY });
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.restored, true);
    assert.equal(outcome.revisionId, first.revision.id);
    assert.equal(readFileSync(join(target, "app.txt"), "utf8"), "one");
    assert.deepEqual(contentOf(target), new Set(["app.txt"]));
    assert.equal(existsSync(join(target, ".portable-bridge.journal")), false);

    // After the restore, the destination is a clean base again: the
    // next bridge operation proceeds without recovery.
    const next = await session.export(
      parts.blobs,
      { revisionId: second.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );
    assert.equal(next.recovered, false);
    assert.equal(readFileSync(join(target, "app.txt"), "utf8"), "two");
  } finally {
    parts.done();
    src.done();
    dest.done();
  }
});

test("entry type changes replace entries in both directions", async () => {
  const parts = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  const target = join(dest.dir, "out");
  try {
    // Revision one: a file that becomes a directory, a nested directory
    // that becomes a file, a nested file that becomes a directory, and
    // a deep subtree the next revision drops completely.
    writeFileSync(join(src.dir, "swap-to-dir"), "once a file");
    mkdirSync(join(src.dir, "swap-to-file"));
    mkdirSync(join(src.dir, "swap-to-file", "sub"));
    writeFileSync(join(src.dir, "swap-to-file", "kept-then-gone.txt"), "kept");
    writeFileSync(join(src.dir, "swap-to-file", "sub", "y.txt"), "y");
    mkdirSync(join(src.dir, "deep"));
    mkdirSync(join(src.dir, "deep", "nested"));
    writeFileSync(join(src.dir, "deep", "nested", "leaf.txt"), "once a leaf");
    mkdirSync(join(src.dir, "gone"));
    mkdirSync(join(src.dir, "gone", "inner"));
    writeFileSync(join(src.dir, "gone", "inner", "obsolete.txt"), "obsolete");
    writeFileSync(join(src.dir, "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(src.dir, "run.sh"), 0o755);
    const runtime = parts.runtime;
    const sessionId = (await runtime.createSession({ policyRef: "policy://test" })).id;
    const session = await runtime.openSession(sessionId);
    const first = await session.checkpoint(
      parts.blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
      { stability: { kind: "locked" } },
    );
    await session.export(
      parts.blobs,
      { revisionId: first.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );

    // Revision two reworks the entry shapes.
    rmSync(join(src.dir, "swap-to-dir"));
    mkdirSync(join(src.dir, "swap-to-dir"));
    writeFileSync(join(src.dir, "swap-to-dir", "child.txt"), "now a directory");
    rmSync(join(src.dir, "swap-to-file"), { recursive: true });
    writeFileSync(join(src.dir, "swap-to-file"), "now a file");
    rmSync(join(src.dir, "deep", "nested", "leaf.txt"));
    mkdirSync(join(src.dir, "deep", "nested", "leaf.txt"));
    writeFileSync(join(src.dir, "deep", "nested", "leaf.txt", "under.txt"), "leaf became a directory");
    rmSync(join(src.dir, "gone"), { recursive: true });
    const second = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-2",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: first.revision.id,
      },
      { stability: { kind: "locked" } },
    );

    // A local edit still conflicts before the type change overwrites.
    writeFileSync(join(target, "swap-to-dir"), "precious local edit");
    const conflict = await session
      .export(parts.blobs, { revisionId: second.revision.id, destination: target }, { authority: LOCAL_AUTHORITY })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(conflict) && conflict.code === "WorkspaceConflict");
    assert.ok(JSON.stringify(conflict?.details).includes("changed-local-files"));
    assert.equal(readFileSync(join(target, "swap-to-dir"), "utf8"), "precious local edit");
    writeFileSync(join(target, "swap-to-dir"), "once a file");

    const updated = await session.export(
      parts.blobs,
      { revisionId: second.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY, expectedBaseRevisionId: first.revision.id },
    );
    // The destination holds exactly the requested tree and root hash.
    const settled = scanTreeFromDirectory(target, { exclusions: [...RESERVED] });
    assert.equal(settled.rootHash, updated.rootHash);
    assert.deepEqual(contentOf(target), contentOf(src.dir));

    // Both type changes landed with the requested kinds.
    assert.ok(statSync(join(target, "swap-to-dir")).isDirectory());
    assert.equal(readFileSync(join(target, "swap-to-dir", "child.txt"), "utf8"), "now a directory");
    assert.ok(statSync(join(target, "swap-to-file")).isFile());
    assert.equal(readFileSync(join(target, "swap-to-file"), "utf8"), "now a file");
    assert.ok(statSync(join(target, "deep", "nested", "leaf.txt")).isDirectory());
    assert.equal(
      readFileSync(join(target, "deep", "nested", "leaf.txt", "under.txt"), "utf8"),
      "leaf became a directory",
    );

    // Nested obsolete directories removed fully, children and parents.
    assert.equal(existsSync(join(target, "gone")), false);
    assert.equal(existsSync(join(target, "swap-to-file", "sub")), false);

    // Executable metadata survived the change.
    assert.equal(statSync(join(target, "run.sh")).mode & 0o777, 0o755);

    // Reserved bridge files survived the apply.
    assert.ok(existsSync(join(target, ".portable-bridge.state")));
  } finally {
    parts.done();
    src.done();
    dest.done();
  }
});

test("a crash between removal and creation recovers a type change", async () => {
  const parts = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  const target = join(dest.dir, "out");
  try {
    // Revision one: `x` is a file and `d` is a directory.
    writeFileSync(join(src.dir, "x"), "once a file");
    mkdirSync(join(src.dir, "d"));
    writeFileSync(join(src.dir, "d", "old.txt"), "old");
    const runtime = parts.runtime;
    const sessionId = (await runtime.createSession({ policyRef: "policy://test" })).id;
    const session = await runtime.openSession(sessionId);
    const first = await session.checkpoint(
      parts.blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
      { stability: { kind: "locked" } },
    );
    await session.export(
      parts.blobs,
      { revisionId: first.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );

    // Revision two: `x` becomes a directory and `d` becomes a file.
    rmSync(join(src.dir, "x"));
    mkdirSync(join(src.dir, "x"));
    writeFileSync(join(src.dir, "x", "child.txt"), "child");
    rmSync(join(src.dir, "d"), { recursive: true });
    writeFileSync(join(src.dir, "d"), "now a file");
    const second = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-2",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: first.revision.id,
      },
      { stability: { kind: "locked" } },
    );

    // Stage and journal like an export would, then "crash" after the
    // removals: the old file `x` is gone and `d` lost its child, so an
    // empty directory stands where the revision needs a file.
    await simulatePrepare(parts, target, second.revision.id);
    rmSync(join(target, "x"));
    rmSync(join(target, "d", "old.txt"));

    const outcome = await session.recoverExport(parts.blobs, target, { authority: LOCAL_AUTHORITY });
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.restored, false);
    assert.equal(outcome.revisionId, second.revision.id);
    assert.ok(statSync(join(target, "x")).isDirectory());
    assert.equal(readFileSync(join(target, "x", "child.txt"), "utf8"), "child");
    assert.ok(statSync(join(target, "d")).isFile());
    assert.equal(readFileSync(join(target, "d"), "utf8"), "now a file");
    assert.deepEqual(contentOf(target), new Set(["x", "x/child.txt", "d"]));
    assert.equal(existsSync(join(target, ".portable-bridge.stage")), false);
    assert.equal(existsSync(join(target, ".portable-bridge.journal")), false);
    const settled = scanTreeFromDirectory(target, { exclusions: [...RESERVED] });
    assert.equal(settled.rootHash, outcome.rootHash);
  } finally {
    parts.done();
    src.done();
    dest.done();
  }
});

test("corrupt staging content restores the base instead of publishing", async () => {
  const parts = fixture();
  const src = scratch("porta-src-");
  const dest = scratch("porta-dest-");
  const target = join(dest.dir, "out");
  try {
    writeFileSync(join(src.dir, "app.txt"), "one");
    const runtime = parts.runtime;
    const sessionId = (await runtime.createSession({ policyRef: "policy://test" })).id;
    const session = await runtime.openSession(sessionId);
    const first = await session.checkpoint(
      parts.blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
      { stability: { kind: "locked" } },
    );
    await session.export(
      parts.blobs,
      { revisionId: first.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );

    writeFileSync(join(src.dir, "app.txt"), "two");
    writeFileSync(join(src.dir, "new.txt"), "fresh");
    const second = await session.checkpoint(
      parts.blobs,
      {
        requestKey: "import-2",
        source: { kind: "bridge", rootPath: src.dir },
        expectedHead: first.revision.id,
      },
      { stability: { kind: "locked" } },
    );
    await simulatePrepare(parts, target, second.revision.id);
    // The staged tree changed after the journal recorded its hash.
    // Recovery must not publish those bytes under the revision hash
    // the journal carries.
    writeFileSync(join(target, ".portable-bridge.stage", "new.txt"), "tampered");

    const outcome = await session.recoverExport(parts.blobs, target, { authority: LOCAL_AUTHORITY });
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.restored, true);
    assert.equal(outcome.revisionId, first.revision.id);
    assert.equal(readFileSync(join(target, "app.txt"), "utf8"), "one");
    assert.equal(existsSync(join(target, "new.txt")), false);
    assert.equal(existsSync(join(target, ".portable-bridge.stage")), false);
    assert.equal(existsSync(join(target, ".portable-bridge.journal")), false);
    const state = JSON.parse(readFileSync(join(target, ".portable-bridge.state"), "utf8")) as {
      revisionId: string;
    };
    assert.equal(state.revisionId, first.revision.id);

    // The restored base accepts the next export without recovery.
    const next = await session.export(
      parts.blobs,
      { revisionId: second.revision.id, destination: target },
      { authority: LOCAL_AUTHORITY },
    );
    assert.equal(next.recovered, false);
    assert.equal(readFileSync(join(target, "app.txt"), "utf8"), "two");
    assert.equal(readFileSync(join(target, "new.txt"), "utf8"), "fresh");
  } finally {
    parts.done();
    src.done();
    dest.done();
  }
});

/**
 * Reproduce the state a crashed exporter leaves behind: a staged tree
 * and an applying journal, with no destination file changed yet.
 */
async function simulatePrepare(
  parts: { blobs: BlobStore; store: ControlStore },
  target: string,
  revisionId: string,
): Promise<void> {
  const { materializeTree, treeRootHash } = await import("../store/workspace-tree.js");
  const tree = parts.store.getRevisionTree(revisionId)!;
  const entries = JSON.parse(tree.entriesJson) as Array<{
    path: string;
    kind: "file" | "directory";
    executable: boolean;
    contentHash: string | null;
  }>;
  const stageRoot = join(target, ".portable-bridge.stage");
  mkdirSync(target, { recursive: true });
  materializeTree(entries, stageRoot, (digest) => parts.blobs.get(digest));
  const state = JSON.parse(readFileSync(join(target, ".portable-bridge.state"), "utf8")) as {
    revisionId: string;
  };
  writeFileSync(
    join(target, ".portable-bridge.journal"),
    JSON.stringify({
      schemaVersion: 1,
      phase: "applying",
      revisionId,
      rootHash: treeRootHash(entries),
      fileCount: entries.filter((entry) => entry.kind === "file").length,
      baseRevisionId: state.revisionId,
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  );
}
