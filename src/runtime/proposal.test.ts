import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import { PortableRuntime } from "./session.js";
import { checkpointWorkspace } from "./workspace.js";
import { PolicyAuthority } from "../core/policy.js";
import type { AttachmentSummary } from "../schema/session.js";

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
});

/** One runtime, an in-memory store, a blob tree, and scratch roots. */
function fixture(): {
  runtime: PortableRuntime;
  store: ControlStore;
  blobs: BlobStore;
  done: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "porta-prop-"));
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

/** One active attachment of generation 1 owned by the session. */
function attachment(store: ControlStore, sessionId: string, attachmentId = "att-1"): AttachmentSummary {
  const record: AttachmentSummary = {
    sessionId,
    attachmentId,
    name: `worker-${attachmentId}`,
    generation: 1,
    status: "active",
    capabilityIds: ["fs.workspace@1"],
  };
  store.insertAttachment(record);
  return record;
}

/**
 * One session with an imported base revision, one private working
 * copy, and one active attachment that owns the copy.
 */
async function setup(): Promise<{
  runtime: PortableRuntime;
  store: ControlStore;
  blobs: BlobStore;
  sessionId: string;
  workspaceId: string;
  baseRevisionId: string;
  copyId: string;
  done: () => void;
  cleanup: Array<() => void>;
}> {
  const parts = fixture();
  const src = scratch("porta-src-");
  writeFileSync(join(src.dir, "app.txt"), "base");
  const session = await parts.runtime.createSession({ policyRef: "policy://test" });
  const outcome = checkpointWorkspace(
    parts.runtime.controlStore,
    session.id,
    parts.blobs,
    { requestKey: "import-1", source: { kind: "bridge", rootPath: src.dir } },
    { stability: { kind: "locked" } },
  );
  const work = scratch("porta-work-");
  const copy = await (await parts.runtime.openSession(session.id)).materialize(
    parts.blobs,
    outcome.revision.id,
    join(work.dir, "copy"),
    { authority: LOCAL_AUTHORITY, mode: "proposal" },
  );
  attachment(parts.store, session.id);
  const described = await (await parts.runtime.openSession(session.id)).describe();
  return {
    runtime: parts.runtime,
    store: parts.store,
    blobs: parts.blobs,
    sessionId: session.id,
    workspaceId: described.workspace.workspaceId,
    baseRevisionId: outcome.revision.id,
    copyId: copy.record.id,
    done: parts.done,
    cleanup: [src.done, work.done],
  };
}

/** Release every scratch directory of one setup. */
function release(parts: { done: () => void; cleanup: Array<() => void> }): void {
  parts.done();
  for (const clean of parts.cleanup) {
    clean();
  }
}

/** One session's own private copy of its own imported base. */
async function privateCopyOfOwnBase(
  parts: { runtime: PortableRuntime; blobs: BlobStore },
  sessionId: string,
  destination: string,
): Promise<{ record: { id: string } }> {
  const source = scratch("porta-other-");
  try {
    writeFileSync(join(source.dir, "own.txt"), "own");
    const session = await parts.runtime.openSession(sessionId);
    const ownBase = await session.checkpoint(
      parts.blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: source.dir } },
      { stability: { kind: "locked" } },
    );
    return session.materialize(parts.blobs, ownBase.revision.id, destination, {
      authority: LOCAL_AUTHORITY,
      mode: "proposal",
    });
  } finally {
    source.done();
  }
}

test("a proposal records a candidate without moving the head", async () => {
  const parts = await setup();
  try {
    const session = await parts.runtime.openSession(parts.sessionId);
    writeFileSync(join(join(parts.store.getWorkingCopy(parts.copyId)!.rootPath), "app.txt"), "edited");

    const outcome = await session.propose(parts.blobs, {
      requestKey: "propose-1",
      copyId: parts.copyId,
      attachment: { sessionId: parts.sessionId, attachmentId: "att-1", generation: 1 },
    }, { stability: { kind: "locked" } });
    assert.equal(outcome.created, true);
    assert.equal(outcome.fileCount, 1);
    assert.equal(outcome.candidate.parentId, parts.baseRevisionId);
    assert.equal(outcome.proposal.status, "open");
    // The head did not move: a proposal is not an authoritative writer.
    assert.equal(parts.store.getWorkspaceHead(parts.workspaceId), parts.baseRevisionId);
    assert.notEqual(outcome.candidate.id, parts.baseRevisionId);
    assert.ok(parts.store.getRevisionTree(outcome.candidate.id), "the candidate has a manifest");

    const events = new SessionEventStream(parts.store, parts.sessionId).read(0).events;
    const proposed = events.filter((event) => event.type === "workspace.proposed");
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0]!.data.proposalId, outcome.proposal.id);
    assert.equal(proposed[0]!.data.baseRevisionId, parts.baseRevisionId);
    assert.equal(proposed[0]!.data.candidateRevisionId, outcome.candidate.id);

    // The same key with the same input returns the recorded proposal.
    const repeat = await session.propose(parts.blobs, {
      requestKey: "propose-1",
      copyId: parts.copyId,
      attachment: { sessionId: parts.sessionId, attachmentId: "att-1", generation: 1 },
    }, { stability: { kind: "locked" } });
    assert.equal(repeat.created, false);
    assert.equal(repeat.proposal.id, outcome.proposal.id);
    assert.equal(
      new SessionEventStream(parts.store, parts.sessionId).read(0).events.filter(
        (event) => event.type === "workspace.proposed",
      ).length,
      1,
      "the repeat records no second event",
    );

    // The same key with changed input conflicts.
    const conflict = await session
      .propose(
        parts.blobs,
        {
          requestKey: "propose-1",
          copyId: parts.copyId,
          attachment: { sessionId: parts.sessionId, attachmentId: "att-1", generation: 1 },
          exclusions: ["app.txt"],
        },
        { stability: { kind: "locked" } },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(conflict) && conflict.code === "RequestConflict");
  } finally {
    release(parts);
  }
});

test("concurrent proposals conflict instead of overwriting each other", async () => {
  const parts = await setup();
  const second = scratch("porta-work2-");
  try {
    const session = await parts.runtime.openSession(parts.sessionId);
    const firstCopy = parts.store.getWorkingCopy(parts.copyId)!;
    writeFileSync(join(firstCopy.rootPath, "app.txt"), "change one");

    // A second private copy of the same base pursues a different change.
    const other = await session.materialize(parts.blobs, parts.baseRevisionId, join(second.dir, "copy"), {
      authority: LOCAL_AUTHORITY,
      mode: "proposal",
    });
    writeFileSync(join(second.dir, "copy", "app.txt"), "change two");

    const reference = { sessionId: parts.sessionId, attachmentId: "att-1", generation: 1 };
    const one = await session.propose(parts.blobs, {
      requestKey: "propose-1",
      copyId: parts.copyId,
      attachment: reference,
    }, { stability: { kind: "locked" } });
    const two = await session.propose(parts.blobs, {
      requestKey: "propose-2",
      copyId: other.record.id,
      attachment: reference,
    }, { stability: { kind: "locked" } });

    // The first acceptance moves the head onto its candidate.
    const accepted = await session.accept(one.proposal.id);
    assert.equal(accepted.alreadyAccepted, false);
    assert.equal(parts.store.getWorkspaceHead(parts.workspaceId), one.candidate.id);

    // The second proposal names a base the head left: conflict, no
    // overwrite, no merge (SPEC.md section 11.3).
    const refused = await session.accept(two.proposal.id).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(isPortableCode(refused) && refused.code === "WorkspaceConflict");
    assert.equal(parts.store.getWorkspaceHead(parts.workspaceId), one.candidate.id);
    assert.equal(parts.store.getProposal(two.proposal.id)?.status, "open");
    // Both candidates stay immutable and readable for a new proposal.
    assert.equal(parts.store.getRevision(two.candidate.id)?.id, two.candidate.id);

    // Accepting the same proposal again is idempotent.
    const again = await session.accept(one.proposal.id);
    assert.equal(again.alreadyAccepted, true);
    assert.equal(again.revisionId, one.candidate.id);
    const events = new SessionEventStream(parts.store, parts.sessionId).read(0).events;
    const acceptedEvents = events.filter((event) => event.type === "workspace.accepted");
    assert.equal(acceptedEvents.length, 1);
    assert.equal(acceptedEvents[0]!.data.previousHeadRevisionId, parts.baseRevisionId);
    assert.equal(acceptedEvents[0]!.data.revisionId, one.candidate.id);
  } finally {
    release(parts);
    second.done();
  }
});

test("a stale attachment generation cannot propose or accept", async () => {
  const parts = await setup();
  try {
    const session = await parts.runtime.openSession(parts.sessionId);
    const copy = parts.store.getWorkingCopy(parts.copyId)!;
    writeFileSync(join(copy.rootPath, "app.txt"), "edited");

    // A current reference proposes; a replacement then strands it.
    const outcome = await session.propose(parts.blobs, {
      requestKey: "propose-1",
      copyId: parts.copyId,
      attachment: { sessionId: parts.sessionId, attachmentId: "att-1", generation: 1 },
    }, { stability: { kind: "locked" } });
    const current = parts.store.getAttachment("att-1")!;
    parts.store.casAttachment("att-1", { generation: 1 }, { ...current, generation: 2 });

    // Acceptance refuses the proposal of the replaced generation.
    const refused = await session.accept(outcome.proposal.id).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(isPortableCode(refused) && refused.code === "StaleHandle");
    assert.equal(parts.store.getWorkspaceHead(parts.workspaceId), parts.baseRevisionId);
    assert.equal(parts.store.getProposal(outcome.proposal.id)?.status, "open");

    // A fresh proposal that names the old generation is stale on arrival.
    const stale = await session
      .propose(parts.blobs, {
        requestKey: "propose-stale",
        copyId: parts.copyId,
        attachment: { sessionId: parts.sessionId, attachmentId: "att-1", generation: 1 },
      }, { stability: { kind: "locked" } })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(stale) && stale.code === "StaleHandle");
    assert.equal(parts.store.getProposalByKey(parts.sessionId, "propose-stale"), null);

    // A missing attachment is stale the same way.
    const absent = await session
      .propose(parts.blobs, {
        requestKey: "propose-absent",
        copyId: parts.copyId,
        attachment: { sessionId: parts.sessionId, attachmentId: "att-missing", generation: 1 },
      }, { stability: { kind: "locked" } })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(absent) && absent.code === "StaleHandle");
  } finally {
    release(parts);
  }
});

test("only private copies of this session with a stability guarantee propose", async () => {
  const parts = await setup();
  const readOnly = scratch("porta-ro-");
  try {
    const session = await parts.runtime.openSession(parts.sessionId);
    const reference = { sessionId: parts.sessionId, attachmentId: "att-1", generation: 1 };
    const options = { stability: { kind: "locked" as const } };

    // A read-only snapshot has no authority to propose.
    const snap = await session.materialize(parts.blobs, parts.baseRevisionId, join(readOnly.dir, "snap"), {
      authority: LOCAL_AUTHORITY,
      mode: "read-only",
    });
    const snapshot = await session
      .propose(parts.blobs, { requestKey: "p-snap", copyId: snap.record.id, attachment: reference }, options)
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(snapshot) && snapshot.code === "InvalidRequest");
    assert.ok(JSON.stringify(snapshot?.details).includes("read-only-copy"));

    // An unknown copy refuses.
    const unknown = await session
      .propose(parts.blobs, { requestKey: "p-unknown", copyId: "wc-missing", attachment: reference }, options)
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(unknown) && unknown.code === "InvalidRequest");

    // Another session's copy refuses; that session owns its own
    // workspace, so it imports its own base first.
    // Another session's copy refuses; that session owns its own
    // workspace, so it imports its own base first.
    const outsider = await parts.runtime.createSession({ policyRef: "policy://other" });
    const foreign = await privateCopyOfOwnBase(parts, outsider.id, join(readOnly.dir, "foreign"));
    const crossed = await session
      .propose(
        parts.blobs,
        {
          requestKey: "p-foreign",
          copyId: foreign.record.id,
          attachment: { sessionId: parts.sessionId, attachmentId: "att-1", generation: 1 },
        },
        options,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(crossed) && crossed.code === "InvalidRequest");

    // An attachment of another session refuses.
    const wrongSession = await session
      .propose(
        parts.blobs,
        {
          requestKey: "p-wrong",
          copyId: parts.copyId,
          attachment: { sessionId: outsider.id, attachmentId: "att-1", generation: 1 },
        },
        options,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(wrongSession) && wrongSession.code === "InvalidRequest");

    // Without a stability declaration the candidate is not proven
    // consistent, so the runtime refuses it.
    const unstable = await session
      .propose(parts.blobs, { requestKey: "p-unstable", copyId: parts.copyId, attachment: reference })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(isPortableCode(unstable) && unstable.code === "WorkspaceUnstable");
    assert.equal(parts.store.getProposalByKey(parts.sessionId, "p-unstable"), null);
  } finally {
    release(parts);
    readOnly.done();
  }
});
