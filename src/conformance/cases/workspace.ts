import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../store/control-store.js";
import { BlobStore } from "../../store/blob-store.js";
import { PolicyAuthority } from "../../core/policy.js";
import type { PolicyAuthority as Authority } from "../../core/policy.js";
import {
  materializeTree,
  treeRootHash,
  validateWorkspacePath,
} from "../../store/workspace-tree.js";
import type { TreeEntry } from "../../store/workspace-tree.js";
import {
  checkpointWorkspace,
  materializeRevision,
  proposeWorkspaceChange,
  acceptProposal,
} from "../../runtime/workspace.js";
import type { CheckpointOptions } from "../../runtime/workspace.js";
import { exportRevision, recoverBridgeExport } from "../../runtime/export.js";
import { attachEnvironment } from "../../runtime/acquisition.js";
import type { ConformanceCase, ConformanceContext } from "../runner.js";
import type { ConformanceCaseAnswer } from "../runner.js";

/**
 * Workspace and workspace-authority conformance cases (SPEC.md
 * section 21).
 *
 * The pack proves tree integrity, portable file behavior, proposal
 * authority, checkpoint stability, and export recovery. Every case
 * observes behavior the runtime itself reports; nothing is inferred
 * from the absence of bad news.
 *
 * Effects follow one rule: a case declares external effects exactly
 * when it drives the loaded adapter. Those cases attach one
 * environment, so a provider may allocate or charge. Every other case
 * touches only private temporary directories the case itself created.
 */

/** One in-memory session, one blob tree, and scratch roots per case. */
interface Bench {
  store: ControlStore;
  blobs: BlobStore;
  /** The directory the blob store keeps its objects under. */
  blobRoot: string;
  sessionId: string;
  workspaceId: string;
  /** A fresh empty directory under the case's own root. */
  directory(): string;
  done(): void;
}

function bench(): Bench {
  const root = mkdtempSync(join(tmpdir(), "porta-conf-ws-"));
  const store = ControlStore.inMemory();
  const blobRoot = join(root, "blobs");
  const blobs = new BlobStore(blobRoot, store);
  const sessionId = `sess-${randomUUID()}`;
  const workspaceId = `ws-${randomUUID()}`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId,
    eventSequence: 0,
    policyRef: "policy://conformance",
    createdAt: new Date().toISOString(),
  });
  let counter = 0;
  return {
    store,
    blobs,
    blobRoot,
    sessionId,
    workspaceId,
    directory() {
      counter += 1;
      const dir = join(root, `dir-${counter}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The authority every transfer in this pack runs under. */
const LOCAL_AUTHORITY: Authority = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["local"],
});

/** One policy that also admits the loaded adapter, for attachments. */
function policyOf(context: ConformanceContext): Authority {
  return PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    providers: [context.adapter.id],
    operations: ["exec.process@1"],
    transferDestinations: ["local"],
  });
}

/** Import one source directory as the next revision. */
function checkpoint(
  state: Bench,
  requestKey: string,
  rootPath: string,
  options: CheckpointOptions = {},
  expectedHead?: string,
) {
  return checkpointWorkspace(
    state.store,
    state.sessionId,
    state.blobs,
    {
      requestKey,
      source: { kind: "bridge", rootPath },
      ...(expectedHead !== undefined ? { expectedHead } : {}),
    },
    options,
  );
}

/** Read one portable error's code, or null for anything else. */
function codeOf(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

/** The answer of one observation that must refuse with a code. */
async function expectCode(
  run: () => unknown,
  wanted: string,
): Promise<ConformanceCaseAnswer | void> {
  try {
    await run();
  } catch (error) {
    const code = codeOf(error);
    if (code === wanted) {
      return undefined;
    }
    return {
      outcome: "fail",
      reason: `expected ${wanted}, saw ${code ?? "no portable error"}`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { outcome: "fail", reason: `expected ${wanted}, the call succeeded` };
}

/** The stored manifest entries of one revision. */
function entriesOf(state: Bench, revisionId: string): TreeEntry[] {
  const tree = state.store.getRevisionTree(revisionId);
  if (tree === null) {
    throw new Error(`revision ${revisionId} has no tree`);
  }
  return JSON.parse(tree.entriesJson) as TreeEntry[];
}

/** Reserved file names the export bridge keeps inside one destination. */
const JOURNAL_FILE = ".portable-bridge.journal";
const STATE_FILE = ".portable-bridge.state";
const STAGE_DIR = ".portable-bridge.stage";

/** The workspace and workspace-authority case pack. */
export function workspaceCases(): ConformanceCase[] {
  return [
    {
      id: "workspace.binary-roundtrip",
      area: "workspace",
      summary: "Arbitrary binary bytes survive one checkpoint and one materialization.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          const bytes = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x0a, 0x0d]);
          writeFileSync(join(src, "blob.bin"), bytes);
          const { revision } = checkpoint(state, `conf-${randomUUID()}`, src, {
            stability: { kind: "locked" },
          });
          const copy = join(state.directory(), "copy");
          materializeRevision(state.store, state.sessionId, state.blobs, revision.id, copy, {
            authority: LOCAL_AUTHORITY,
            mode: "proposal",
          });
          const read = readFileSync(join(copy, "blob.bin"));
          if (!read.equals(bytes)) {
            return {
              outcome: "fail",
              reason: "binary content changed between import and materialization",
              detail: `${read.toString("hex")} != ${bytes.toString("hex")}`,
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace.unicode-paths",
      area: "workspace",
      summary: "Unicode paths keep their exact sequence through the manifest.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          const nested = "ünïcode-日本語-🎵";
          const path = `${nested}/файл.txt`;
          mkdirSync(join(src, nested));
          writeFileSync(join(src, nested, "файл.txt"), "content");
          const { revision } = checkpoint(state, `conf-${randomUUID()}`, src, {
            stability: { kind: "locked" },
          });
          const entries = entriesOf(state, revision.id);
          const paths = entries.map((entry) => entry.path);
          if (!paths.includes(path)) {
            return {
              outcome: "fail",
              reason: "the manifest does not carry the exact Unicode path",
              detail: paths.join(", "),
            };
          }
          const copy = join(state.directory(), "copy");
          materializeRevision(state.store, state.sessionId, state.blobs, revision.id, copy, {
            authority: LOCAL_AUTHORITY,
            mode: "proposal",
          });
          if (!existsSync(join(copy, path))) {
            return {
              outcome: "fail",
              reason: "the materialized copy lost the Unicode path",
              detail: path,
            };
          }
          if (readFileSync(join(copy, path), "utf8") !== "content") {
            return {
              outcome: "fail",
              reason: "the Unicode-named file carries wrong content",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace.executable-bits",
      area: "workspace",
      summary: "The executable bit is recorded and restored exactly.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          writeFileSync(join(src, "run.sh"), "#!/bin/sh\n");
          writeFileSync(join(src, "note.txt"), "note");
          chmodSync(join(src, "run.sh"), 0o755);
          chmodSync(join(src, "note.txt"), 0o644);
          const { revision } = checkpoint(state, `conf-${randomUUID()}`, src, {
            stability: { kind: "locked" },
          });
          const byPath = new Map(entriesOf(state, revision.id).map((e) => [e.path, e.executable]));
          if (byPath.get("run.sh") !== true || byPath.get("note.txt") !== false) {
            return {
              outcome: "fail",
              reason: "the manifest did not record the executable bits",
              detail: JSON.stringify([...byPath]),
            };
          }
          const copy = join(state.directory(), "copy");
          materializeRevision(state.store, state.sessionId, state.blobs, revision.id, copy, {
            authority: LOCAL_AUTHORITY,
            mode: "proposal",
          });
          const runnable = (statSync(join(copy, "run.sh")).mode & 0o111) !== 0;
          const plain = (statSync(join(copy, "note.txt")).mode & 0o111) === 0;
          if (!runnable || !plain) {
            return {
              outcome: "fail",
              reason: "materialization restored the wrong permission bits",
              detail: `run.sh executable ${runnable}, note.txt plain ${plain}`,
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace.invalid-paths",
      area: "workspace",
      summary: "Invalid workspace paths are refused with a naming reason.",
      async run() {
        const refused = [
          "",
          "/absolute.txt",
          "../escape.txt",
          "a//b.txt",
          "a/../b.txt",
          "a\\b.txt",
          "a\0b.txt",
          "a/\uD800.txt",
        ];
        for (const path of refused) {
          const problem = validateWorkspacePath(path);
          if (problem === null) {
            return {
              outcome: "fail",
              reason: `the path ${JSON.stringify(path)} was accepted`,
            };
          }
        }
        for (const path of ["a/b/c.txt", "日本語", ".hidden"]) {
          if (validateWorkspacePath(path) !== null) {
            return {
              outcome: "fail",
              reason: `the valid path ${JSON.stringify(path)} was refused`,
            };
          }
        }
        return undefined;
      },
    },
    {
      id: "workspace.unsupported-links",
      area: "workspace",
      summary: "A symbolic link in the source refuses the import, not the link target.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          writeFileSync(join(src, "real.txt"), "content");
          symlinkSync("real.txt", join(src, "link.txt"));
          const answer = await expectCode(
            () =>
              checkpoint(state, `conf-${randomUUID()}`, src, {
                stability: { kind: "locked" },
              }),
            "UnsupportedOperation",
          );
          if (answer !== undefined) {
            return answer;
          }
          // Nothing published: the workspace still has no head.
          if (state.store.getWorkspaceHead(state.workspaceId) !== null) {
            return {
              outcome: "fail",
              reason: "the refused link import still created a revision",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace.size-limits",
      area: "workspace",
      summary: "Import limits refuse an oversized source before anything publishes.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          writeFileSync(join(src, "big.bin"), Buffer.alloc(4));
          const key = `conf-${randomUUID()}`;
          const answer = await expectCode(
            () =>
              checkpoint(state, key, src, {
                stability: { kind: "locked" },
                limits: { maxFileBytes: 3 },
              }),
            "InvalidRequest",
          );
          if (answer !== undefined) {
            return answer;
          }
          if (state.store.getWorkspaceHead(state.workspaceId) !== null) {
            return {
              outcome: "fail",
              reason: "the refused import still created a revision",
            };
          }
          // The same key stays free: the refusal recorded nothing.
          const retried = checkpoint(state, key, src, {
            stability: { kind: "locked" },
            limits: { maxFileBytes: 4 },
          });
          if (retried.created !== true) {
            return {
              outcome: "fail",
              reason: "the refused import still consumed the request key",
            };
          }
          return {
            outcome: "pass",
            detail: "The limit of maxFileBytes refused a 4-byte file and published nothing.",
          };
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace.hash-mismatch",
      area: "workspace",
      summary: "A corrupt blob refuses materialization before one file is written.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          writeFileSync(join(src, "app.txt"), "content");
          const { revision } = checkpoint(state, `conf-${randomUUID()}`, src, {
            stability: { kind: "locked" },
          });
          const entry = entriesOf(state, revision.id).find((e) => e.kind === "file")!;
          const digest = entry.contentHash!;
          // Corrupt the stored object in place: its bytes no longer
          // hash to the digest the manifest names.
          const objectPath = join(state.blobRoot, "objects", digest.slice(0, 2), digest);
          writeFileSync(objectPath, "tampered");
          const destination = join(state.directory(), "copy");
          const answer = await expectCode(
            () =>
              materializeRevision(
                state.store,
                state.sessionId,
                state.blobs,
                revision.id,
                destination,
                { authority: LOCAL_AUTHORITY, mode: "proposal" },
              ),
            "IntegrityFailure",
          );
          if (answer !== undefined) {
            return answer;
          }
          if (existsSync(destination)) {
            return {
              outcome: "fail",
              reason: "the refused materialization still wrote the destination",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace-authority.concurrent-proposals",
      area: "workspace-authority",
      summary: "Two proposals against one base: one accepts, the other conflicts.",
      effects: { external: true },
      async run(context) {
        const state = bench();
        try {
          const attached = await attachEnvironment(state.store, state.sessionId, "policy://conformance", {
            adapter: context.adapter,
            request: { name: "worker", providerId: context.adapter.id, requires: {} },
            requestKey: `conf-${randomUUID()}`,
            principal: "conformance",
            authority: policyOf(context),
          });
          const reference = {
            sessionId: state.sessionId,
            attachmentId: attached.attachmentId,
            generation: attached.generation,
          };
          const src = state.directory();
          writeFileSync(join(src, "shared.txt"), "one");
          const base = checkpoint(state, `conf-${randomUUID()}`, src, {
            stability: { kind: "locked" },
          });
          const copies = [state.directory(), state.directory()].map((root) =>
            join(root, "copy"),
          );
          const records = copies.map((copyRoot) =>
            materializeRevision(
              state.store,
              state.sessionId,
              state.blobs,
              base.revision.id,
              copyRoot,
              { authority: LOCAL_AUTHORITY, mode: "proposal" },
            ),
          );
          writeFileSync(join(copies[0]!, "shared.txt"), "first");
          writeFileSync(join(copies[1]!, "shared.txt"), "second");
          const offered = records.map((copy, index) =>
            proposeWorkspaceChange(
              state.store,
              state.sessionId,
              state.blobs,
              {
                requestKey: `prop-${index}-${randomUUID()}`,
                copyId: copy.record.id,
                attachment: reference,
              },
              { stability: { kind: "locked" } },
            ),
          );
          const winner = offered[0]!;
          const loserOffer = offered[1]!;
          const first = acceptProposal(state.store, state.sessionId, winner.proposal.id);
          if (first.alreadyAccepted || first.revisionId !== winner.candidate.id) {
            return {
              outcome: "fail",
              reason: "the first proposal did not become the head",
              detail: `${first.revisionId} != ${winner.candidate.id}`,
            };
          }
          const conflict = await expectCode(
            () => acceptProposal(state.store, state.sessionId, loserOffer.proposal.id),
            "WorkspaceConflict",
          );
          if (conflict !== undefined) {
            return conflict;
          }
          const head = state.store.getWorkspaceHead(state.workspaceId);
          if (head !== winner.candidate.id) {
            return {
              outcome: "fail",
              reason: "the conflicting acceptance still moved the head",
              detail: `${head} != ${winner.candidate.id}`,
            };
          }
          const loser = state.store.getProposal(loserOffer.proposal.id);
          if (loser === null || loser.status !== "open") {
            return {
              outcome: "fail",
              reason: "the losing proposal did not stay open",
              detail: loser === null ? "gone" : loser.status,
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace-authority.stale-base",
      area: "workspace-authority",
      summary: "A head that moved past a proposal's base refuses the acceptance.",
      effects: { external: true },
      async run(context) {
        const state = bench();
        try {
          const attached = await attachEnvironment(state.store, state.sessionId, "policy://conformance", {
            adapter: context.adapter,
            request: { name: "worker", providerId: context.adapter.id, requires: {} },
            requestKey: `conf-${randomUUID()}`,
            principal: "conformance",
            authority: policyOf(context),
          });
          const src = state.directory();
          writeFileSync(join(src, "app.txt"), "one");
          const base = checkpoint(state, `conf-${randomUUID()}`, src, {
            stability: { kind: "locked" },
          });
          const copyRoot = join(state.directory(), "copy");
          const copy = materializeRevision(
            state.store,
            state.sessionId,
            state.blobs,
            base.revision.id,
            copyRoot,
            { authority: LOCAL_AUTHORITY, mode: "proposal" },
          );
          writeFileSync(join(copyRoot, "app.txt"), "proposed");
          const offered = proposeWorkspaceChange(
            state.store,
            state.sessionId,
            state.blobs,
            {
              requestKey: `prop-${randomUUID()}`,
              copyId: copy.record.id,
              attachment: {
                sessionId: state.sessionId,
                attachmentId: attached.attachmentId,
                generation: attached.generation,
              },
            },
            { stability: { kind: "locked" } },
          );
          // The bridge moves the head while the proposal is open.
          writeFileSync(join(src, "app.txt"), "raced");
          const raced = checkpoint(
            state,
            `conf-${randomUUID()}`,
            src,
            { stability: { kind: "locked" } },
            base.revision.id,
          );
          const answer = await expectCode(
            () => acceptProposal(state.store, state.sessionId, offered.proposal.id),
            "WorkspaceConflict",
          );
          if (answer !== undefined) {
            return answer;
          }
          const head = state.store.getWorkspaceHead(state.workspaceId);
          if (head !== raced.revision.id) {
            return {
              outcome: "fail",
              reason: "the refused acceptance still moved the head",
              detail: `${head} != ${raced.revision.id}`,
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace-authority.stale-generation",
      area: "workspace-authority",
      summary: "A proposal from a replaced attachment generation never accepts.",
      effects: { external: true },
      async run(context) {
        const state = bench();
        try {
          const attached = await attachEnvironment(state.store, state.sessionId, "policy://conformance", {
            adapter: context.adapter,
            request: { name: "worker", providerId: context.adapter.id, requires: {} },
            requestKey: `conf-${randomUUID()}`,
            principal: "conformance",
            authority: policyOf(context),
          });
          const src = state.directory();
          writeFileSync(join(src, "app.txt"), "one");
          const base = checkpoint(state, `conf-${randomUUID()}`, src, {
            stability: { kind: "locked" },
          });
          const copyRoot = join(state.directory(), "copy");
          const copy = materializeRevision(
            state.store,
            state.sessionId,
            state.blobs,
            base.revision.id,
            copyRoot,
            { authority: LOCAL_AUTHORITY, mode: "proposal" },
          );
          writeFileSync(join(copyRoot, "app.txt"), "proposed");
          const reference = {
            sessionId: state.sessionId,
            attachmentId: attached.attachmentId,
            generation: attached.generation,
          };
          const offered = proposeWorkspaceChange(
            state.store,
            state.sessionId,
            state.blobs,
            {
              requestKey: `prop-${randomUUID()}`,
              copyId: copy.record.id,
              attachment: reference,
            },
            { stability: { kind: "locked" } },
          );
          // The attachment moves to a new generation: a replacement
          // switched the environment under this session.
          const moved = state.store.casAttachment(
            attached.attachmentId,
            { generation: attached.generation },
            { ...attached, generation: attached.generation + 1 },
          );
          if (moved === null) {
            return {
              outcome: "fail",
              reason: "the generation bump of the test attachment failed",
            };
          }
          const answer = await expectCode(
            () => acceptProposal(state.store, state.sessionId, offered.proposal.id),
            "StaleHandle",
          );
          if (answer !== undefined) {
            return answer;
          }
          const head = state.store.getWorkspaceHead(state.workspaceId);
          if (head !== base.revision.id) {
            return {
              outcome: "fail",
              reason: "the stale acceptance still moved the head",
              detail: `${head} != ${base.revision.id}`,
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace-authority.local-edits-during-export",
      area: "workspace-authority",
      summary: "Local edits under an export base conflict and are never overwritten.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          writeFileSync(join(src, "app.txt"), "one");
          const first = checkpoint(state, `conf-${randomUUID()}`, src, {
            stability: { kind: "locked" },
          });
          const target = join(state.directory(), "out");
          exportRevision(
            state.store,
            state.sessionId,
            state.blobs,
            { revisionId: first.revision.id, destination: target },
            { authority: LOCAL_AUTHORITY },
          );
          writeFileSync(join(src, "app.txt"), "two");
          const second = checkpoint(
            state,
            `conf-${randomUUID()}`,
            src,
            { stability: { kind: "locked" } },
            first.revision.id,
          );
          writeFileSync(join(target, "app.txt"), "precious local edit");
          const answer = await expectCode(
            () =>
              exportRevision(
                state.store,
                state.sessionId,
                state.blobs,
                { revisionId: second.revision.id, destination: target },
                { authority: LOCAL_AUTHORITY },
              ),
            "WorkspaceConflict",
          );
          if (answer !== undefined) {
            return answer;
          }
          if (readFileSync(join(target, "app.txt"), "utf8") !== "precious local edit") {
            return {
              outcome: "fail",
              reason: "the conflicting export overwrote the local edit",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace-authority.stability-declaration",
      area: "workspace-authority",
      summary: "A checkpoint without a stability declaration refuses to run.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          writeFileSync(join(src, "app.txt"), "one");
          const key = `conf-${randomUUID()}`;
          const answer = await expectCode(
            () => checkpoint(state, key, src),
            "WorkspaceUnstable",
          );
          if (answer !== undefined) {
            return answer;
          }
          if (state.store.getWorkspaceHead(state.workspaceId) !== null) {
            return {
              outcome: "fail",
              reason: "the undeclared checkpoint still created a revision",
            };
          }
          const declared = checkpoint(state, key, src, {
            stability: { kind: "snapshot" },
          });
          if (declared.created !== true) {
            return {
              outcome: "fail",
              reason: "the declared checkpoint did not run",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace-authority.checkpoint-lock",
      area: "workspace-authority",
      summary: "A held bridge lock refuses the import; a stale one is taken over.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          writeFileSync(join(src, "app.txt"), "one");
          const lockPath = join(src, ".portable-bridge.lock");
          writeFileSync(lockPath, "999999 now");
          const answer = await expectCode(
            () =>
              checkpoint(state, `conf-${randomUUID()}`, src, {
                stability: { kind: "locked" },
              }),
            "WorkspaceUnstable",
          );
          if (answer !== undefined) {
            return answer;
          }
          // The lock ages past the takeover threshold; the import runs.
          const aged = new Date(Date.now() - 60_000);
          utimesSync(lockPath, aged, aged);
          const taken = checkpoint(
            state,
            `conf-${randomUUID()}`,
            src,
            { stability: { kind: "locked" }, staleLockMs: 1 },
          );
          if (taken.created !== true) {
            return {
              outcome: "fail",
              reason: "the stale lock was not taken over",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "workspace-authority.interrupted-export",
      area: "workspace-authority",
      summary: "A crash mid-apply recovers before the next bridge operation runs.",
      async run() {
        const state = bench();
        try {
          const src = state.directory();
          writeFileSync(join(src, "app.txt"), "one");
          const first = checkpoint(state, `conf-${randomUUID()}`, src, {
            stability: { kind: "locked" },
          });
          const target = join(state.directory(), "out");
          exportRevision(
            state.store,
            state.sessionId,
            state.blobs,
            { revisionId: first.revision.id, destination: target },
            { authority: LOCAL_AUTHORITY },
          );
          writeFileSync(join(src, "app.txt"), "two");
          writeFileSync(join(src, "new.txt"), "fresh");
          const second = checkpoint(
            state,
            `conf-${randomUUID()}`,
            src,
            { stability: { kind: "locked" } },
            first.revision.id,
          );
          // Reproduce one crashed exporter: a staged tree, an applying
          // journal, and one file of the apply already landed.
          const entries = entriesOf(state, second.revision.id);
          const stageRoot = join(target, STAGE_DIR);
          materializeTree(entries, stageRoot, (digest) => state.blobs.get(digest));
          const recorded = JSON.parse(readFileSync(join(target, STATE_FILE), "utf8")) as {
            revisionId: string;
          };
          writeFileSync(
            join(target, JOURNAL_FILE),
            JSON.stringify({
              schemaVersion: 1,
              phase: "applying",
              revisionId: second.revision.id,
              rootHash: treeRootHash(entries),
              fileCount: entries.filter((entry) => entry.kind === "file").length,
              baseRevisionId: recorded.revisionId,
              updatedAt: "2026-01-01T00:00:00Z",
            }),
          );
          copyFileSync(join(stageRoot, "new.txt"), join(target, "new.txt"));
          const recovered = recoverBridgeExport(
            state.store,
            state.sessionId,
            state.blobs,
            target,
            { authority: LOCAL_AUTHORITY },
          );
          if (
            recovered.recovered !== true ||
            recovered.restored !== false ||
            recovered.revisionId !== second.revision.id
          ) {
            return {
              outcome: "fail",
              reason: "the interrupted apply did not complete from the stage",
              detail: `${recovered.revisionId} recovered ${recovered.recovered}`,
            };
          }
          if (readFileSync(join(target, "app.txt"), "utf8") !== "two") {
            return {
              outcome: "fail",
              reason: "the recovered destination holds the wrong content",
            };
          }
          if (existsSync(join(target, JOURNAL_FILE)) || existsSync(stageRoot)) {
            return {
              outcome: "fail",
              reason: "the recovery left bridge files behind",
            };
          }
          // The next bridge operation runs clean, with no recovery.
          writeFileSync(join(src, "app.txt"), "three");
          const third = checkpoint(
            state,
            `conf-${randomUUID()}`,
            src,
            { stability: { kind: "locked" } },
            second.revision.id,
          );
          const next = exportRevision(
            state.store,
            state.sessionId,
            state.blobs,
            { revisionId: third.revision.id, destination: target },
            { authority: LOCAL_AUTHORITY },
          );
          if (next.recovered !== false || next.restored !== false) {
            return {
              outcome: "fail",
              reason: "the follow-up export still needed recovery",
              detail: `recovered ${next.recovered}, restored ${next.restored}`,
            };
          }
          if (readFileSync(join(target, "app.txt"), "utf8") !== "three") {
            return {
              outcome: "fail",
              reason: "the follow-up export wrote the wrong content",
            };
          }
          return {
            outcome: "pass",
            detail: "A mid-apply crash completed from the stage; the next export ran clean.",
          };
        } finally {
          state.done();
        }
      },
    },
  ];
}
