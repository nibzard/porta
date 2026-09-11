import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  invalidRequestError,
  requestConflictError,
  unsupportedOperationError,
  workspaceConflictError,
  workspaceUnstableError,
} from "../core/errors.js";
import { nowUtcTimestamp } from "../core/time.js";
import type { Sha256Hex } from "../schema/defs.js";
import type { WorkspaceRevision } from "../schema/workspace.js";
import { assertValid } from "../schema/validate.js";
import { checkpointRequestSchema } from "../schema/workspace.js";
import type { CheckpointRequest } from "../schema/workspace.js";
import type { BlobLimits, BlobRef, BlobStore } from "../store/blob-store.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";
import type { EventRedactor } from "../store/event-stream.js";
import { SessionEventStream } from "../store/event-stream.js";
import { buildTreeFromDirectory, validateWorkspacePath } from "../store/workspace-tree.js";
import type { ImportedTree } from "../store/workspace-tree.js";

/**
 * Workspace import and checkpoints over the local directory bridge
 * (SPEC.md sections 11.3, 11.4, and 11.6).
 *
 * An import turns one locked or snapshotted local directory into an
 * immutable revision. The first import creates the workspace's first
 * revision; every later import names the head it expects, and a head
 * that moved fails with `WorkspaceConflict` without changing anything.
 *
 * A checkpoint needs a stable source. The caller declares how writers
 * were made quiescent: a lock it holds, or a filesystem snapshot it
 * will read. Without a declaration the runtime refuses the
 * consistency-guaranteed checkpoint with `WorkspaceUnstable`, because
 * reading the files twice proves nothing about atomicity. Concurrent
 * Portable imports of one source serialize through a bridge lock file
 * inside that source; a lock left behind by a crashed importer is
 * taken over after it goes stale.
 */

/** How the caller made the source's writers quiescent (SPEC.md 11.4). */
export type SourceStability =
  | { kind: "locked"; detail?: string }
  | { kind: "snapshot"; detail?: string };

/** Input of one bridge checkpoint call. */
export interface CheckpointOptions {
  /**
   * The stability guarantee behind the source. Omitting it refuses the
   * checkpoint: an undeclared source cannot be proven atomic.
   */
  stability?: SourceStability;
  /** Import limits enforced before a revision publishes. */
  limits?: BlobLimits;
  /** Lock file name inside the source. Default `.portable-bridge.lock`. */
  lockFileName?: string;
  /** Age at which a held bridge lock is taken over, in milliseconds. Default 300000. */
  staleLockMs?: number;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** The outcome of one bridge checkpoint call. */
export interface CheckpointOutcome {
  revision: WorkspaceRevision;
  /** `false` when a repeated request key returned the recorded import. */
  created: boolean;
  /** Number of file entries in the imported tree. */
  fileCount: number;
  /** Combined size of the imported files in bytes. */
  totalBytes: number;
  /** Effective exclusion list recorded with the import provenance. */
  exclusions: string[];
}

const DEFAULT_LOCK_FILE = ".portable-bridge.lock";
const DEFAULT_STALE_LOCK_MS = 300_000;
const IMPORT_EXTENSION = "portable.runtime.import";

/**
 * Import one local directory as a workspace revision (SPEC.md 11.4).
 *
 * The call validates the request, deduplicates by request key, refuses
 * undeclared stability, checks the expected head, and only then reads
 * the source under the bridge lock. The revision, the head move, the
 * journal event, and the request key record commit in one transaction:
 * a failed import leaves no revision and never moves the head.
 */
export function checkpointWorkspace(
  store: ControlStore,
  sessionId: string,
  blobs: BlobStore,
  request: CheckpointRequest,
  options: CheckpointOptions = {},
): CheckpointOutcome {
  assertValid(checkpointRequestSchema, request);
  if (request.source.kind !== "bridge") {
    throw unsupportedOperationError("workspace.bridge@1", "checkpoint-attachment", {
      detail: "Version one checkpoints a local directory bridge, not an attachment copy.",
      sourceKind: request.source.kind,
    });
  }
  const session = store.getSession(sessionId);
  if (session === null) {
    throw invalidRequestError(`Session ${sessionId} does not exist.`, { sessionId });
  }
  if (session.status !== "open") {
    throw invalidRequestError(
      `Session ${sessionId} is ${session.status}; it accepts no new imports.`,
      { sessionId, status: session.status },
    );
  }
  const rootPath = request.source.rootPath;
  const exclusions = [...new Set(request.exclusions ?? [])].sort();
  for (const exclusion of exclusions) {
    const problem = validateWorkspacePath(exclusion);
    if (problem !== null) {
      throw problem;
    }
  }
  const stability = options.stability;
  const inputHash = hashOf({
    rootPath,
    exclusions,
    stability: stability === undefined ? null : stability.kind,
    expectedHead: request.expectedHead ?? null,
  });

  // A repeated key returns the recorded import; changed input conflicts.
  const recorded = store.getBridgeImport(sessionId, request.requestKey);
  if (recorded !== null) {
    if (recorded.inputHash !== inputHash) {
      throw requestConflictError(
        request.requestKey,
        "The request key was reused with different import input.",
        { inputHash, recordedInputHash: recorded.inputHash },
      );
    }
    const revision = store.getRevision(recorded.revisionId);
    if (revision === null) {
      throw invalidRequestError(
        `The recorded import of ${request.requestKey} names a missing revision.`,
        { requestKey: request.requestKey, revisionId: recorded.revisionId },
      );
    }
    return {
      revision,
      created: false,
      fileCount: 0,
      totalBytes: 0,
      exclusions,
    };
  }

  // No lock and no snapshot: the runtime refuses to claim consistency
  // it cannot prove (SPEC.md section 11.4).
  if (stability === undefined) {
    throw workspaceUnstableError(
      "The checkpoint has no stability guarantee: no lock is declared and no snapshot exists.",
      { rootPath, requestKey: request.requestKey },
    );
  }

  const workspaceId = session.workspaceId;
  const currentHead = store.getWorkspaceHead(workspaceId);
  if (currentHead === null && request.expectedHead !== undefined) {
    throw invalidRequestError("The workspace has no head yet; import without one.", {
      workspaceId,
      expectedHead: request.expectedHead,
    });
  }
  if (currentHead !== null && request.expectedHead === undefined) {
    throw invalidRequestError("A later import requires the expected workspace head.", {
      workspaceId,
      currentHead,
    });
  }
  if (
    currentHead !== null &&
    request.expectedHead !== undefined &&
    currentHead !== request.expectedHead
  ) {
    throw workspaceConflictError(request.expectedHead, currentHead);
  }

  const lockFileName = options.lockFileName ?? DEFAULT_LOCK_FILE;
  acquireBridgeLock(rootPath, lockFileName, options.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
  // The lock file lives inside the source, so it never enters the tree.
  const effectiveExclusions = [...new Set([...exclusions, lockFileName])].sort();
  let imported: ImportedTree;
  try {
    imported = buildTreeFromDirectory(rootPath, blobs, { exclusions: effectiveExclusions });
    checkImportLimits(imported.blobRefs, options.limits);
  } finally {
    rmSync(join(rootPath, lockFileName), { force: true });
  }

  const revision: WorkspaceRevision = {
    id: `rev-${randomUUID()}`,
    workspaceId,
    ...(currentHead !== null ? { parentId: currentHead } : {}),
    rootHash: imported.rootHash,
    createdAt: nowUtcTimestamp(),
    extensions: {
      [IMPORT_EXTENSION]: {
        requestKey: request.requestKey,
        rootPath,
        stability: { kind: stability.kind },
        exclusions: effectiveExclusions,
        fileCount: imported.entries.filter((entry) => entry.kind === "file").length,
      },
    },
  };
  const fileCount = imported.entries.filter((entry) => entry.kind === "file").length;
  const totalBytes = imported.blobRefs.reduce((sum, ref) => sum + ref.sizeBytes, 0);

  const stream = new SessionEventStream(store, sessionId, options.redactor);
  try {
    store.transaction(() => {
      blobs.publishRevision(revision, imported.blobRefs);
      if (!store.casWorkspaceHead(workspaceId, currentHead, revision.id)) {
        const moved = store.getWorkspaceHead(workspaceId);
        throw workspaceConflictError(
          currentHead === null ? "none" : currentHead,
          moved === null ? "none" : moved,
        );
      }
      store.insertBridgeImport(sessionId, request.requestKey, revision.id, inputHash);
      stream.append("workspace.checkpointed", revision.id, {
        revisionId: revision.id,
        requestKey: request.requestKey,
        ...(currentHead !== null ? { parentRevisionId: currentHead } : {}),
        fileCount,
        totalBytes,
        exclusions: effectiveExclusions,
      });
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
  return { revision, created: true, fileCount, totalBytes, exclusions: effectiveExclusions };
}

// -- Internals ----------------------------------------------------------------

/** Enforce the configured import limits before anything publishes. */
function checkImportLimits(blobRefs: readonly BlobRef[], limits: BlobLimits | undefined): void {
  if (limits === undefined) {
    return;
  }
  const total = blobRefs.reduce((sum, ref) => sum + ref.sizeBytes, 0);
  const measurements: Array<[keyof BlobLimits, number]> = [
    ["maxFileCount", blobRefs.length],
    ["maxTotalBytes", total],
  ];
  for (const ref of blobRefs) {
    measurements.push(["maxFileBytes", ref.sizeBytes]);
  }
  for (const [name, actual] of measurements) {
    const limit = limits[name];
    if (limit !== undefined && actual > limit) {
      throw invalidRequestError(`The import exceeds the ${name} limit of ${limit}.`, {
        limit,
        actual,
        limitName: name,
      });
    }
  }
}

/**
 * Take the bridge lock of one source directory.
 *
 * The lock is one exclusively created file; a lock that exists and is
 * younger than the stale age refuses the import, and a stale lock is
 * taken over from a crashed importer.
 */
function acquireBridgeLock(rootPath: string, lockFileName: string, staleLockMs: number): void {
  const lockPath = join(rootPath, lockFileName);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try {
        writeSync(descriptor, `${process.pid} ${nowUtcTimestamp()}`);
      } finally {
        closeSync(descriptor);
      }
      return;
    } catch (error) {
      if (!isSystemCode(error, "EEXIST")) {
        throw error;
      }
      if (attempt > 0) {
        throw workspaceUnstableError(
          "Another import holds the bridge lock of the source directory.",
          { rootPath, lockFileName },
        );
      }
      const held = Date.now() - statSync(lockPath).mtimeMs;
      if (held <= staleLockMs) {
        throw workspaceUnstableError(
          "Another import holds the bridge lock of the source directory.",
          { rootPath, lockFileName, heldMs: held },
        );
      }
      rmSync(lockPath, { force: true });
    }
  }
}

/** Whether one error carries a Node system error code. */
function isSystemCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** The deduplication hash of one import request's identity. */
function hashOf(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
