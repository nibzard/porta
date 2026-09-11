import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import { PortableRuntime } from "./session.js";
import { checkpointWorkspace } from "./workspace.js";
import type { CheckpointRequest } from "../schema/workspace.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** One runtime over an in-memory store, plus a blob tree beside it. */
function fixture(): {
  runtime: PortableRuntime;
  store: ControlStore;
  blobs: BlobStore;
  root: string;
  done: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "porta-import-"));
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(root, store);
  const runtime = new PortableRuntime(store);
  return { runtime, store, blobs, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** One source directory to import. */
function source(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "porta-src-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function bridge(dir: string, requestKey: string, extra: Partial<CheckpointRequest> = {}): CheckpointRequest {
  return {
    requestKey,
    source: { kind: "bridge", rootPath: dir },
    ...extra,
  };
}

async function newSession(runtime: PortableRuntime): Promise<string> {
  const session = await runtime.createSession({ policyRef: "policy://test" });
  return session.id;
}

test("an initial import creates the first revision and one journal event", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = source();
  try {
    writeFileSync(join(src.dir, "readme.txt"), "hello\n");
    const sessionId = await newSession(runtime);
    const session = await runtime.openSession(sessionId);

    const first = await session.checkpoint(blobs, bridge(src.dir, "import-1"), {
      stability: { kind: "locked", detail: "caller holds flock" },
    });
    assert.equal(first.created, true);
    assert.equal(first.fileCount, 1);
    assert.equal(first.totalBytes, 6);
    assert.equal(first.revision.parentId, undefined);
    assert.equal(store.getWorkspaceHead((await session.describe()).workspace.workspaceId), first.revision.id);

    // The lock file never entered the tree and is gone afterwards.
    assert.equal(first.exclusions.includes(".portable-bridge.lock"), true);
    let lockExists = true;
    try {
      statSync(join(src.dir, ".portable-bridge.lock"));
    } catch {
      lockExists = false;
    }
    assert.equal(lockExists, false, "the bridge lock is released");

    const events = new SessionEventStream(store, sessionId).read(0).events;
    const checkpointed = events.filter((event) => event.type === "workspace.checkpointed");
    assert.equal(checkpointed.length, 1);
    assert.equal(checkpointed[0]!.data.revisionId, first.revision.id);
    assert.equal(checkpointed[0]!.data.requestKey, "import-1");
    assert.equal(checkpointed[0]!.data.fileCount, 1);
    assert.equal(checkpointed[0]!.data.totalBytes, 6);
    assert.deepEqual(checkpointed[0]!.data.exclusions, [".portable-bridge.lock"]);
    assert.equal(checkpointed[0]!.data.parentRevisionId, undefined);

    // The same key with the same input returns the recorded import.
    const repeat = await session.checkpoint(blobs, bridge(src.dir, "import-1"), {
      stability: { kind: "locked", detail: "caller holds flock" },
    });
    assert.equal(repeat.created, false);
    assert.equal(repeat.revision.id, first.revision.id);
    assert.equal(
      new SessionEventStream(store, sessionId).read(0).events.filter(
        (event) => event.type === "workspace.checkpointed",
      ).length,
      1,
      "the repeat records no second event",
    );
  } finally {
    done();
    src.done();
  }
});

test("later imports require the expected head and chain revisions", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = source();
  try {
    writeFileSync(join(src.dir, "a.txt"), "one");
    const sessionId = await newSession(runtime);
    const session = await runtime.openSession(sessionId);
    const workspaceId = (await session.describe()).workspace.workspaceId;

    // The first import cannot name an expectation: no head exists yet.
    const premature = await session
      .checkpoint(blobs, bridge(src.dir, "pre-1", { expectedHead: "rev-missing" }), {
        stability: { kind: "snapshot" },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(premature) && premature.code === "InvalidRequest");

    const first = await session.checkpoint(blobs, bridge(src.dir, "import-1"), {
      stability: { kind: "snapshot" },
    });

    // A later import without an expectation is refused.
    const noHead = await session.checkpoint(blobs, bridge(src.dir, "import-2"), {
      stability: { kind: "snapshot" },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(isPortableCode(noHead) && noHead.code === "InvalidRequest");

    // A moved or wrong head conflicts without changing anything.
    const conflict = await session.checkpoint(
      blobs,
      bridge(src.dir, "import-2", { expectedHead: "rev-bogus" }),
      { stability: { kind: "snapshot" } },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(isPortableCode(conflict) && conflict.code === "WorkspaceConflict");
    assert.equal(store.getWorkspaceHead(workspaceId), first.revision.id);

    // The right expectation chains the new revision onto the old head.
    writeFileSync(join(src.dir, "b.txt"), "two");
    const second = await session.checkpoint(
      blobs,
      bridge(src.dir, "import-2", { expectedHead: first.revision.id }),
      { stability: { kind: "snapshot" } },
    );
    assert.equal(second.revision.parentId, first.revision.id);
    assert.equal(store.getWorkspaceHead(workspaceId), second.revision.id);
    assert.notEqual(second.revision.id, first.revision.id);
    // The first revision stays immutable and readable.
    assert.equal(store.getRevision(first.revision.id)?.id, first.revision.id);
  } finally {
    done();
    src.done();
  }
});

test("an undeclared source stability refuses the checkpoint", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = source();
  try {
    writeFileSync(join(src.dir, "a.txt"), "one");
    const sessionId = await newSession(runtime);
    const session = await runtime.openSession(sessionId);

    const refused = await session.checkpoint(blobs, bridge(src.dir, "import-1")).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(isPortableCode(refused) && refused.code === "WorkspaceUnstable");
    const workspaceId = (await session.describe()).workspace.workspaceId;
    assert.equal(store.getWorkspaceHead(workspaceId), null);
    assert.equal(store.getBridgeImport(sessionId, "import-1"), null);

    // Declaring the guarantee afterwards succeeds with the same key.
    const done_ = await session.checkpoint(blobs, bridge(src.dir, "import-1"), {
      stability: { kind: "locked" },
    });
    assert.equal(done_.created, true);
  } finally {
    done();
    src.done();
  }
});

test("a held bridge lock refuses; a stale lock is taken over", async () => {
  const { runtime, blobs, done } = fixture();
  const src = source();
  try {
    writeFileSync(join(src.dir, "a.txt"), "one");
    const sessionId = await newSession(runtime);
    const session = await runtime.openSession(sessionId);
    const lockPath = join(src.dir, ".portable-bridge.lock");

    writeFileSync(lockPath, "999999 2026-01-01T00:00:00Z");
    const held = await session
      .checkpoint(blobs, bridge(src.dir, "import-1"), { stability: { kind: "locked" } })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(held) && held.code === "WorkspaceUnstable");
    assert.ok(isPortableCode(held) && JSON.stringify(held).includes("bridge lock"));

    // Age the lock past the stale threshold: the import takes it over.
    const aged = new Date(Date.now() - 60_000);
    utimesSync(lockPath, aged, aged);
    const recovered = await session.checkpoint(blobs, bridge(src.dir, "import-1"), {
      stability: { kind: "locked" },
      staleLockMs: 30_000,
    });
    assert.equal(recovered.created, true);
    let lockExists = true;
    try {
      statSync(lockPath);
    } catch {
      lockExists = false;
    }
    assert.equal(lockExists, false, "the taken-over lock is released");
  } finally {
    done();
    src.done();
  }
});

test("limits refuse the import before any revision publishes", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = source();
  try {
    writeFileSync(join(src.dir, "a.txt"), "12345");
    writeFileSync(join(src.dir, "b.txt"), "123456");
    const sessionId = await newSession(runtime);
    const session = await runtime.openSession(sessionId);
    const workspaceId = (await session.describe()).workspace.workspaceId;

    const cases: Array<{ limits: { maxFileCount?: number; maxTotalBytes?: number; maxFileBytes?: number }; expected: string }> = [
      { limits: { maxFileCount: 1 }, expected: "maxFileCount" },
      { limits: { maxTotalBytes: 10 }, expected: "maxTotalBytes" },
      { limits: { maxFileBytes: 5 }, expected: "maxFileBytes" },
    ];
    for (const { limits, expected } of cases) {
      const refused = await session
        .checkpoint(blobs, bridge(src.dir, `import-${expected}`), { stability: { kind: "locked" }, limits })
        .then(
          () => null,
          (error: unknown) => error,
        );
      assert.ok(isPortableCode(refused) && refused.code === "InvalidRequest", `${expected} refuses`);
      assert.ok(JSON.stringify(refused?.details).includes(expected));
      assert.equal(store.getWorkspaceHead(workspaceId), null);
    }

    // The same source imports once the limits allow it.
    const ok = await session.checkpoint(blobs, bridge(src.dir, "import-ok"), {
      stability: { kind: "locked" },
      limits: { maxFileCount: 2, maxTotalBytes: 11, maxFileBytes: 6 },
    });
    assert.equal(ok.fileCount, 2);
    assert.equal(store.getWorkspaceHead(workspaceId), ok.revision.id);
  } finally {
    done();
    src.done();
  }
});

test("exclusion rules are enforced and stored with import provenance", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = source();
  try {
    writeFileSync(join(src.dir, "app.txt"), "kept");
    mkdirSync(join(src.dir, "node_modules"));
    writeFileSync(join(src.dir, "node_modules", "dep.txt"), "skipped");
    mkdirSync(join(src.dir, "dist"));
    writeFileSync(join(src.dir, "dist", "out.js"), "skipped");

    const sessionId = await newSession(runtime);
    const session = await runtime.openSession(sessionId);
    const outcome = await session.checkpoint(
      blobs,
      bridge(src.dir, "import-1", { exclusions: ["node_modules", "dist"] }),
      { stability: { kind: "locked" } },
    );
    assert.equal(outcome.fileCount, 1);
    assert.equal(outcome.totalBytes, 4);
    assert.deepEqual(outcome.exclusions, [".portable-bridge.lock", "dist", "node_modules"]);

    const provenance = outcome.revision.extensions?.["portable.runtime.import"] as {
      exclusions?: string[];
      rootPath?: string;
      stability?: { kind?: string };
      fileCount?: number;
    };
    assert.equal(provenance?.rootPath, src.dir);
    assert.equal(provenance?.stability?.kind, "locked");
    assert.equal(provenance?.fileCount, 1);
    assert.deepEqual(provenance?.exclusions, [".portable-bridge.lock", "dist", "node_modules"]);

    const event = new SessionEventStream(store, sessionId)
      .read(0)
      .events.find((entry) => entry.type === "workspace.checkpointed")!;
    assert.deepEqual(event.data.exclusions, [".portable-bridge.lock", "dist", "node_modules"]);

    // An exclusion that is not a valid workspace path is refused.
    const badExclusion = await session
      .checkpoint(blobs, bridge(src.dir, "import-2", { exclusions: ["../escape"] }), {
        stability: { kind: "locked" },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(badExclusion) && badExclusion.code === "InvalidRequest");
  } finally {
    done();
    src.done();
  }
});

test("a repeated key with changed input conflicts", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = source();
  try {
    writeFileSync(join(src.dir, "app.txt"), "kept");
    const sessionId = await newSession(runtime);
    const session = await runtime.openSession(sessionId);
    await session.checkpoint(blobs, bridge(src.dir, "import-1"), {
      stability: { kind: "locked" },
    });

    const conflict = await session
      .checkpoint(blobs, bridge(src.dir, "import-1", { exclusions: ["app.txt"] }), {
        stability: { kind: "locked" },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(conflict) && conflict.code === "RequestConflict");
    assert.equal((await session.describe()).workspace.headRevisionId, store.getBridgeImport(sessionId, "import-1")?.revisionId);
  } finally {
    done();
    src.done();
  }
});

test("closing sessions and attachment sources are refused", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = source();
  try {
    writeFileSync(join(src.dir, "a.txt"), "one");
    const sessionId = await newSession(runtime);
    const session = await runtime.openSession(sessionId);

    const fromAttachment = await session
      .checkpoint(blobs, {
        requestKey: "import-1",
        source: {
          kind: "attachment",
          attachment: { sessionId, attachmentId: "att-x", generation: 1 },
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(fromAttachment) && fromAttachment.code === "UnsupportedOperation");

    store.casSessionStatus(sessionId, ["open"], "closing");
    const closing = await session
      .checkpoint(blobs, bridge(src.dir, "import-1"), { stability: { kind: "locked" } })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(closing) && closing.code === "InvalidRequest");
  } finally {
    done();
    src.done();
  }
});

test("the flow function serves callers without a session handle", async () => {
  const { runtime, store, blobs, done } = fixture();
  const src = source();
  try {
    writeFileSync(join(src.dir, "a.txt"), "one");
    const sessionId = await newSession(runtime);
    const outcome = checkpointWorkspace(store, sessionId, blobs, bridge(src.dir, "import-1"), {
      stability: { kind: "snapshot", detail: "btrfs snapshot" },
    });
    assert.equal(outcome.created, true);
    assert.equal(store.getBridgeImport(sessionId, "import-1")?.revisionId, outcome.revision.id);
  } finally {
    done();
    src.done();
  }
});
