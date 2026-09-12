import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { integrityFailureError, portableError } from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import { nowUtcTimestamp } from "../core/time.js";
import type { PolicyAuthority } from "../core/policy.js";
import { checkRawTransfer } from "../core/secrets.js";
import type { BlobStore } from "../store/blob-store.js";
import type { ControlStore } from "../store/control-store.js";
import {
  checkTreeManifest,
  materializeTree,
  scanTreeFromDirectory,
  treeRootHash,
} from "../store/workspace-tree.js";
import type { TreeEntry } from "../store/workspace-tree.js";
import {
  DEFAULT_LOCK_FILE,
  DEFAULT_STALE_LOCK_MS,
  acquireBridgeLock,
  requireOpenSession,
} from "./workspace.js";

/**
 * Local export and crash recovery over the directory bridge
 * (SPEC.md section 11.4).
 *
 * Export writes one accepted revision into a local directory. Before
 * one destination file changes, the bridge scans the directory and
 * compares it with the base the destination last exported: files that
 * moved on fail with `WorkspaceConflict`, never an overwrite. New
 * content first lands in a staging tree inside the destination, and a
 * recovery journal records the in-flight apply. A crash at any point
 * lets the next bridge operation complete the apply from the stage or
 * restore the recorded base, before it does anything else.
 *
 * Export, recovery, and import serialize on the same exclusive lock
 * file inside the destination.
 */

/** Request for one export call. */
export interface ExportRequest {
  /** The accepted revision to write into the destination. */
  revisionId: string;
  /** The local directory that receives the revision. */
  destination: string;
}

/** Input of one export or recovery call. */
export interface ExportFlowOptions {
  /** The policy authority that governs the transfer destination. */
  authority: PolicyAuthority;
  /** The base revision the destination must currently hold, when checked. */
  expectedBaseRevisionId?: string;
  /** Lock file name inside the destination. Default `.portable-bridge.lock`. */
  lockFileName?: string;
  /** Age at which a held bridge lock is taken over, in milliseconds. Default 300000. */
  staleLockMs?: number;
}

/** The outcome of one export or recovery call. */
export interface ExportOutcome {
  /** The revision the destination now holds. */
  revisionId: string;
  /** Digest of the tree the destination now holds. */
  rootHash: string;
  /** Number of file entries written. */
  fileCount: number;
  /** `true` when this call recovered an interrupted apply. */
  recovered: boolean;
  /** `true` when recovery restored the base instead of completing. */
  restored: boolean;
}

/** One verified manifest ready to apply. */
interface VerifiedTree {
  revisionId: string;
  rootHash: string;
  entries: TreeEntry[];
}

/** State file the bridge keeps inside one destination directory. */
interface BridgeState {
  schemaVersion: 1;
  revisionId: string;
  rootHash: string;
  updatedAt: string;
}

/** Recovery journal of one in-flight export apply. */
interface BridgeJournal {
  schemaVersion: 1;
  phase: "applying";
  revisionId: string;
  rootHash: string;
  fileCount: number;
  baseRevisionId: string | null;
  updatedAt: string;
}

const STATE_FILE = ".portable-bridge.state";
const JOURNAL_FILE = ".portable-bridge.journal";
const STAGE_DIR = ".portable-bridge.stage";

/**
 * Export one revision into a local directory (SPEC.md section 11.4).
 *
 * The call validates destination policy first, then takes the
 * exclusive bridge lock, completes or restores any interrupted export,
 * verifies the directory against its recorded base, stages the new
 * tree, and applies it under the journal. Any failure before the
 * apply leaves the destination exactly as it was.
 */
export function exportRevision(
  store: ControlStore,
  sessionId: string,
  blobs: BlobStore,
  request: ExportRequest,
  options: ExportFlowOptions,
): ExportOutcome {
  const denied = checkRawTransfer(options.authority, "local");
  if (denied !== null) {
    throw denied;
  }
  const session = requireOpenSession(store, sessionId);
  const tree = loadVerifiedTree(store, session.workspaceId, request.revisionId);
  const lockFileName = options.lockFileName ?? DEFAULT_LOCK_FILE;

  return withBridgeLock(request.destination, lockFileName, options, () => {
    recoverBridgeLocked(store, sessionId, blobs, request.destination, lockFileName);
    const state = readState(request.destination);
    if (
      options.expectedBaseRevisionId !== undefined &&
      state?.revisionId !== options.expectedBaseRevisionId
    ) {
      throw exportConflict(
        `The destination is not at the expected base revision ${options.expectedBaseRevisionId}.`,
        {
          expectedBaseRevisionId: options.expectedBaseRevisionId,
          recordedRevisionId: state?.revisionId ?? null,
        },
      );
    }
    const current = scanTreeFromDirectory(request.destination, {
      exclusions: [...reservedNames(lockFileName)],
    });
    if (state === null) {
      if (current.entries.length > 0) {
        throw exportConflict(
          "The destination holds files with no recorded base; export refuses to overwrite them.",
          { reason: "unverified-destination", destination: request.destination },
        );
      }
    } else if (current.rootHash !== state.rootHash) {
      throw exportConflict("Local files differ from the recorded base tree.", {
        reason: "changed-local-files",
        recordedRootHash: state.rootHash,
        currentRootHash: current.rootHash,
        destination: request.destination,
      });
    }
    return applyExport(
      blobs,
      request.destination,
      tree,
      lockFileName,
      state?.revisionId ?? null,
    );
  });
}

/**
 * Recover one destination after an interrupted export.
 *
 * An apply journal that still has its staging tree completes; a
 * journal whose staging tree is gone restores the recorded base. The
 * call takes the exclusive bridge lock, so it serializes against
 * imports and exports of the same directory.
 */
export function recoverBridgeExport(
  store: ControlStore,
  sessionId: string,
  blobs: BlobStore,
  destination: string,
  options: ExportFlowOptions,
): ExportOutcome {
  requireOpenSession(store, sessionId);
  const lockFileName = options.lockFileName ?? DEFAULT_LOCK_FILE;
  return withBridgeLock(destination, lockFileName, options, () =>
    recoverBridgeLocked(store, sessionId, blobs, destination, lockFileName),
  );
}

/**
 * Apply one staged export: stage, journal, copy, state, cleanup.
 *
 * Each step is idempotent, so an apply interrupted anywhere completes
 * correctly when it runs again.
 */
function applyExport(
  blobs: BlobStore,
  destination: string,
  tree: VerifiedTree,
  lockFileName: string,
  baseRevisionId: string | null,
): ExportOutcome {
  const stageRoot = join(destination, STAGE_DIR);
  rmSync(stageRoot, { recursive: true, force: true });
  materializeTree(tree.entries, stageRoot, (digest) => blobs.get(digest));
  const fileCount = tree.entries.filter((entry) => entry.kind === "file").length;
  const journal: BridgeJournal = {
    schemaVersion: 1,
    phase: "applying",
    revisionId: tree.revisionId,
    rootHash: tree.rootHash,
    fileCount,
    baseRevisionId,
    updatedAt: nowUtcTimestamp(),
  };
  writeAtomic(join(destination, JOURNAL_FILE), JSON.stringify(journal));
  applyStaged(stageRoot, tree.entries, destination, reservedNames(lockFileName));
  verifyApplied(destination, tree.rootHash, lockFileName);
  writeState(destination, tree.revisionId, tree.rootHash);
  rmSync(stageRoot, { recursive: true, force: true });
  rmSync(join(destination, JOURNAL_FILE), { force: true });
  return {
    revisionId: tree.revisionId,
    rootHash: tree.rootHash,
    fileCount,
    recovered: false,
    restored: false,
  };
}

/**
 * Complete or restore one interrupted apply, if any.
 *
 * A journal whose staging tree still hashes to it completes the apply.
 * A journal with no staging tree, or one the scan cannot verify,
 * restores the base the export started from: recovery never publishes
 * content it did not verify. A stray staging tree with no journal is
 * garbage from a crash before the journal existed; it is removed.
 */
function recoverBridgeLocked(
  store: ControlStore,
  sessionId: string,
  blobs: BlobStore,
  destination: string,
  lockFileName: string,
): ExportOutcome {
  const journalPath = join(destination, JOURNAL_FILE);
  const stageRoot = join(destination, STAGE_DIR);
  const reserved = reservedNames(lockFileName);
  const state = readState(destination);
  if (!existsSync(journalPath)) {
    rmSync(stageRoot, { recursive: true, force: true });
    if (state === null) {
      // Nothing was ever exported here; there is nothing to recover.
      return {
        revisionId: "none",
        rootHash: "none",
        fileCount: 0,
        recovered: false,
        restored: false,
      };
    }
    return {
      revisionId: state.revisionId,
      rootHash: state.rootHash,
      fileCount: 0,
      recovered: false,
      restored: false,
    };
  }
  const journal = parseJsonFile<BridgeJournal>(journalPath, "recovery journal");
  if (journal.revisionId === state?.revisionId) {
    // The apply finished and only the cleanup was interrupted.
    rmSync(stageRoot, { recursive: true, force: true });
    rmSync(journalPath, { force: true });
    return {
      revisionId: journal.revisionId,
      rootHash: journal.rootHash,
      fileCount: journal.fileCount,
      recovered: true,
      restored: false,
    };
  }
  const staged = readStagedTree(stageRoot, journal.rootHash);
  if (staged !== null) {
    // The staging tree is intact and still hashes to the journal:
    // complete the apply from it.
    applyStaged(stageRoot, staged, destination, reserved);
    verifyApplied(destination, journal.rootHash, lockFileName);
    writeState(destination, journal.revisionId, journal.rootHash);
    rmSync(stageRoot, { recursive: true, force: true });
    rmSync(journalPath, { force: true });
    return {
      revisionId: journal.revisionId,
      rootHash: journal.rootHash,
      fileCount: journal.fileCount,
      recovered: true,
      restored: false,
    };
  }
  // The staging tree is gone or no longer matches the journal. The
  // recorded base is the only verified tree left: restore it so the
  // destination holds exactly one revision again.
  rmSync(stageRoot, { recursive: true, force: true });
  if (journal.baseRevisionId === null) {
    for (const path of walkFiles(destination, reserved)) {
      rmSync(path, { force: true });
    }
    pruneDirectories(destination, new Map(), reserved);
    rmSync(journalPath, { force: true });
    return { revisionId: "none", rootHash: "none", fileCount: 0, recovered: true, restored: true };
  }
  const base = loadVerifiedTree(
    store,
    requireOpenSession(store, sessionId).workspaceId,
    journal.baseRevisionId,
  );
  const restored = applyExport(blobs, destination, base, lockFileName, null);
  return { ...restored, recovered: true, restored: true };
}

/**
 * Copy one staged tree into a destination and drop what it does not
 * name with the same kind. A file whose path the target needs as a
 * directory leaves before the directory lands, and an emptied
 * directory whose path the target needs as a file leaves before the
 * file copies over it. The apply is idempotent: running it again
 * writes the same result. Reserved bridge files are never touched.
 */
function applyStaged(
  stageRoot: string,
  entries: readonly TreeEntry[],
  destination: string,
  reserved: ReadonlySet<string>,
): void {
  const target = new Map(entries.map((entry) => [entry.path, entry] as const));
  for (const path of walkFiles(destination, reserved)) {
    if (target.get(relativeTo(destination, path))?.kind !== "file") {
      rmSync(path, { force: true });
    }
  }
  pruneDirectories(destination, target, reserved);
  for (const entry of entries) {
    const to = join(destination, entry.path);
    if (entry.kind === "directory") {
      mkdirSync(to, { recursive: true });
      chmodSync(to, 0o755);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(stageRoot, entry.path), to);
    chmodSync(to, entry.executable ? 0o755 : 0o644);
  }
}

/** Run one body under the destination's exclusive bridge lock. */
function withBridgeLock<T>(
  destination: string,
  lockFileName: string,
  options: ExportFlowOptions,
  body: () => T,
): T {
  mkdirSync(destination, { recursive: true });
  acquireBridgeLock(destination, lockFileName, options.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
  try {
    return body();
  } finally {
    rmSync(join(destination, lockFileName), { force: true });
  }
}

/**
 * Load one revision's manifest and verify it end to end.
 *
 * The manifest must exist, parse into valid entries, and hash to the
 * recorded root. Export trusts a revision only through this check.
 */
function loadVerifiedTree(
  store: ControlStore,
  workspaceId: string,
  revisionId: string,
): VerifiedTree {
  const revision = store.getRevision(revisionId);
  if (revision === null || revision.workspaceId !== workspaceId) {
    throw portableError("InvalidRequest", `Revision ${revisionId} does not exist in the workspace.`, {
      details: { revisionId },
    });
  }
  const tree = store.getRevisionTree(revisionId);
  if (tree === null) {
    throw integrityFailureError(`manifest of ${revisionId}`, "recorded", "absent");
  }
  let entries: TreeEntry[];
  try {
    entries = JSON.parse(tree.entriesJson) as TreeEntry[];
  } catch {
    throw integrityFailureError(`manifest of ${revisionId}`, "parseable JSON", "invalid content");
  }
  const structural = checkTreeManifest(entries);
  if (structural !== null) {
    throw integrityFailureError(`manifest of ${revisionId}`, "valid entries", structural.code);
  }
  const computed = treeRootHash(entries);
  if (computed !== revision.rootHash || tree.rootHash !== revision.rootHash) {
    throw integrityFailureError(`manifest of ${revisionId}`, revision.rootHash, computed);
  }
  return { revisionId, rootHash: revision.rootHash, entries };
}

/** The reserved file and directory names of the bridge in one destination. */
function reservedNames(lockFileName: string): Set<string> {
  return new Set([lockFileName, STATE_FILE, JOURNAL_FILE, STAGE_DIR]);
}

/** Read and validate the bridge state file, when present. */
function readState(destination: string): BridgeState | null {
  const path = join(destination, STATE_FILE);
  if (!existsSync(path)) {
    return null;
  }
  return parseJsonFile<BridgeState>(path, "bridge state");
}

/** Write the bridge state file atomically. */
function writeState(destination: string, revisionId: string, rootHash: string): void {
  const state: BridgeState = {
    schemaVersion: 1,
    revisionId,
    rootHash,
    updatedAt: nowUtcTimestamp(),
  };
  writeAtomic(join(destination, STATE_FILE), JSON.stringify(state));
}

/** Parse one JSON file with a named integrity failure on garbage. */
function parseJsonFile<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw integrityFailureError(what, "parseable JSON", `the content of ${path}`);
  }
}

/** One export conflict: the code of a moved head, the words of a file tree. */
function exportConflict(message: string, details: Record<string, unknown>): PortableError {
  return portableError("WorkspaceConflict", message, { details });
}

/** Write one file through a temporary file and an atomic rename. */
function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

/** Every non-reserved file below one root, in walk order. */
function walkFiles(root: string, reserved: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      if (reserved.has(dirent.name)) {
        continue;
      }
      const path = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        visit(path);
      } else {
        found.push(path);
      }
    }
  };
  visit(root);
  return found;
}

/**
 * Remove directories the target tree no longer names as directories,
 * children before parents. A directory with content stays put.
 */
function pruneDirectories(
  root: string,
  target: ReadonlyMap<string, TreeEntry>,
  reserved: ReadonlySet<string>,
): void {
  const seen: string[] = [];
  const visit = (directory: string): void => {
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      if (reserved.has(dirent.name)) {
        continue;
      }
      const path = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        visit(path);
        seen.push(path);
      }
    }
  };
  visit(root);
  // Post order lists children before parents, so an obsolete subtree
  // empties from the bottom and every directory of it can leave.
  for (const path of seen) {
    if (target.get(relativeTo(root, path))?.kind === "directory") {
      continue;
    }
    try {
      // An empty directory removes; one with content stays put.
      if (readdirSync(path).length === 0) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A directory that cannot be read is left for the caller.
    }
  }
}

/**
 * Read one staged tree that still hashes to the journal.
 *
 * Returns null when the staging directory is gone, no longer hashes
 * to the recorded root, or cannot be scanned at all. Recovery never
 * publishes a stage it cannot verify.
 */
function readStagedTree(stageRoot: string, expectedRootHash: string): TreeEntry[] | null {
  if (!existsSync(stageRoot)) {
    return null;
  }
  try {
    const scanned = scanTreeFromDirectory(stageRoot);
    return scanned.rootHash === expectedRootHash ? scanned.entries : null;
  } catch {
    return null;
  }
}

/**
 * Verify the destination now holds one tree, or refuse to record it.
 *
 * The bridge state names a revision only after the applied
 * destination hashes to it, so a state file never claims a tree the
 * directory does not hold.
 */
function verifyApplied(destination: string, rootHash: string, lockFileName: string): void {
  const settled = scanTreeFromDirectory(destination, {
    exclusions: [...reservedNames(lockFileName)],
  });
  if (settled.rootHash !== rootHash) {
    throw integrityFailureError("the applied destination tree", rootHash, settled.rootHash);
  }
}

/** The slash-separated relative path of one absolute path under a root. */
function relativeTo(root: string, path: string): string {
  return path.slice(root.length + 1).split(/[\\/]/).join("/");
}
