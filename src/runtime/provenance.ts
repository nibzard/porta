import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { invalidRequestError, unsupportedOperationError } from "../core/errors.js";
import { nowUtcTimestamp } from "../core/time.js";
import type { PolicyAuthority } from "../core/policy.js";
import type { EnvironmentManifest } from "../schema/capability.js";
import type { Sha256Hex } from "../schema/defs.js";
import type { WorkspaceRevision } from "../schema/workspace.js";
import {
  provenanceCaptureRequestSchema,
  provenanceSettleRequestSchema,
} from "../schema/workspace.js";
import type {
  ExecutionProvenance,
  ProvenanceCaptureRequest,
  ProvenanceSettleRequest,
  TrackedPathChange,
  WorkingCopyRecord,
} from "../schema/workspace.js";
import { assertValid } from "../schema/validate.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";
import type { BlobStore } from "../store/blob-store.js";
import type { EventRedactor } from "../store/event-stream.js";
import { SessionEventStream } from "../store/event-stream.js";
import {
  buildTreeFromDirectory,
  canonicalTreeJson,
} from "../store/workspace-tree.js";
import type { TreeEntry } from "../store/workspace-tree.js";
import { acquireBridgeLock, checkImportLimits, materializeRevision, requireCurrentAttachment, requireOpenSession } from "./workspace.js";
import { DEFAULT_LOCK_FILE, DEFAULT_STALE_LOCK_MS } from "./workspace.js";
import type { BlobLimits } from "../store/blob-store.js";
import type { SourceStability } from "./workspace.js";

/**
 * Execution provenance (SPEC.md section 11.5).
 *
 * Every workspace-backed invocation records its base revision and working
 * copy, the arguments it dispatched, and the environment facts it ran
 * under: adapter version, manifest digest, and the dependency or image
 * identifiers the environment reported.
 *
 * A verification run goes further. Its copy is checkpointed immediately
 * before the run, so a command on a modified copy never claims it tested
 * the unmodified base revision: the tested revision is the checkpoint
 * when the copy differs, the base revision only when the trees hash the
 * same. The run itself executes in a private copy materialized from the
 * tested revision, which excludes unrelated writers from both hashes.
 * Settling measures the output tree and reports every tracked path the
 * run changed.
 *
 * These records describe what ran. They do not guarantee identical
 * results across providers.
 */

/** Environment facts recorded beside one invocation. */
export interface ProvenanceEnvironmentOptions {
  /** Manifest of the executing environment; digested and version-stamped. */
  manifest?: EnvironmentManifest;
  /** Dependency identifiers the environment reported as available. */
  dependencyIds?: string[];
  /** Image identifier the environment reported, when it runs from one. */
  imageId?: string;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** Options of one verification preparation. */
export interface VerificationRunOptions extends ProvenanceEnvironmentOptions {
  /** Policy authority that governs the private copy's destination. */
  authority: PolicyAuthority;
  /**
   * Empty directory the private verification copy materializes into.
   * Follows the `materializeTree` destination contract: no symbolic
   * links, and a parent directory the caller owns exclusively.
   */
  destination: string;
  /** Paths excluded from the pre-run checkpoint (SPEC.md section 11.6). */
  exclusions?: string[];
  /** How the caller made the copy's writers quiescent for the checkpoint. */
  stability?: SourceStability;
  /** Import limits enforced before the checkpoint publishes. */
  limits?: BlobLimits;
  /** Lock file name inside the source copy. Default `.portable-bridge.lock`. */
  lockFileName?: string;
  /** Age at which a held bridge lock is taken over, in milliseconds. */
  staleLockMs?: number;
}

/** Options of one verification settle. */
export interface VerificationSettleOptions {
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** What one verification preparation returned. */
export interface VerificationRunPreparation {
  provenance: ExecutionProvenance;
  /** Private copy the command runs in; unrelated writers cannot reach it. */
  verificationCopy: WorkingCopyRecord;
  /** The revision the run actually tests. */
  testedRevision: WorkspaceRevision;
}

const CAPTURED_EXTENSION = "provenance.captured";
const RECORDED_EXTENSION = "provenance.recorded";
const CHECKPOINT_EXTENSION = "portable.runtime.verification-checkpoint";

/**
 * Record one workspace-backed invocation's provenance (SPEC.md 11.5).
 *
 * The capture associates the operation with its base revision and working
 * copy, the arguments it dispatched, and the environment facts supplied.
 * It claims nothing about tree state: only verification runs measure
 * what was tested.
 */
export function recordInvocationProvenance(
  store: ControlStore,
  sessionId: string,
  request: ProvenanceCaptureRequest,
  options: ProvenanceEnvironmentOptions = {},
): ExecutionProvenance {
  assertValid(provenanceCaptureRequestSchema, request);
  requireOpenSession(store, sessionId);
  checkAttachmentAndCopy(store, sessionId, request);
  const record = captureRecord(store, sessionId, request, options);
  const stream = new SessionEventStream(store, sessionId, options.redactor);
  try {
    store.transaction(() => {
      store.insertExecutionProvenance(record);
      stream.append(CAPTURED_EXTENSION, record.operationId, {
        operationId: record.operationId,
        baseRevisionId: record.baseRevisionId,
        workingCopyId: record.workingCopyId,
        capability: record.capability,
        operation: record.operation,
        ...(record.manifestDigest !== undefined
          ? { manifestDigest: record.manifestDigest }
          : {}),
      });
    });
  } catch (error) {
    throw portable(error);
  }
  return record;
}

/**
 * Prepare one verification run (SPEC.md sections 11.5 and 11.3).
 *
 * The working copy is checkpointed immediately before the run. A copy
 * that differs from its base publishes that checkpoint as the tested
 * revision — the record then names the checkpoint, never the base it
 * did not test. A clean copy tests the base revision, proven by equal
 * tree hashes. The command runs in a private copy materialized from the
 * tested revision, so unrelated writers of the original copy stay
 * outside both hashes.
 */
export function prepareVerificationRun(
  store: ControlStore,
  sessionId: string,
  blobs: BlobStore,
  request: ProvenanceCaptureRequest,
  options: VerificationRunOptions,
): VerificationRunPreparation {
  assertValid(provenanceCaptureRequestSchema, request);
  const session = requireOpenSession(store, sessionId);

  // A repeated preparation returns the recorded answer: the private
  // copy it staged is the copy the run owns, and a second staging
  // would duplicate the checkpoint and the copy before the store
  // refused the duplicate record (SPEC.md section 11.5).
  const existing = store.getExecutionProvenance(request.operationId);
  if (existing !== null) {
    if (existing.sessionId !== sessionId) {
      throw invalidRequestError(
        `The provenance of ${request.operationId} belongs to another session.`,
        { operationId: request.operationId, sessionId },
      );
    }
    if (existing.testedRevisionId === undefined || existing.verificationCopyId === undefined) {
      throw invalidRequestError(
        `Operation ${request.operationId} already holds a provenance record without a verification run.`,
        { operationId: request.operationId },
      );
    }
    return recordedPreparation(store, existing);
  }

  const { copy, base } = checkAttachmentAndCopy(store, sessionId, request);

  const lockFileName = options.lockFileName ?? DEFAULT_LOCK_FILE;
  const exclusions = [...new Set([...(options.exclusions ?? []), lockFileName])].sort();
  acquireBridgeLock(copy.rootPath, lockFileName, options.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
  let imported;
  try {
    imported = buildTreeFromDirectory(copy.rootPath, blobs, { exclusions });
  } finally {
    rmSync(join(copy.rootPath, lockFileName), { force: true });
  }
  checkImportLimits(imported.blobRefs, options.limits);

  const copyModified = imported.rootHash !== base.rootHash;
  const testedRevision: WorkspaceRevision = copyModified
    ? {
        id: `rev-${randomUUID()}`,
        workspaceId: session.workspaceId,
        parentId: base.id,
        rootHash: imported.rootHash,
        createdAt: nowUtcTimestamp(),
        extensions: {
          [CHECKPOINT_EXTENSION]: {
            operationId: request.operationId,
            copyId: copy.id,
            attachment: {
              attachmentId: request.attachment.attachmentId,
              generation: request.attachment.generation,
            },
            exclusions,
          },
        },
      }
    : base;

  // The checkpoint publishes before the private copy materializes from
  // it; it never moves the head, so the workspace keeps its lineage.
  if (copyModified) {
    try {
      store.transaction(() => {
        blobs.publishRevision(testedRevision, imported.blobRefs);
        store.insertRevisionTree(
          testedRevision.id,
          imported.rootHash,
          canonicalTreeJson(imported.entries),
        );
      });
    } catch (error) {
      throw portable(error);
    }
  }

  const { record: verificationCopy } = materializeRevision(
    store,
    sessionId,
    blobs,
    testedRevision.id,
    options.destination,
    { authority: options.authority, mode: "proposal" },
  );

  const record: ExecutionProvenance = {
    ...captureRecord(store, sessionId, request, options),
    testedRevisionId: testedRevision.id,
    copyModified,
    verificationCopyId: verificationCopy.id,
    inputRootHash: testedRevision.rootHash,
  };
  const stream = new SessionEventStream(store, sessionId, options.redactor);
  try {
    store.transaction(() => {
      store.insertExecutionProvenance(record);
      stream.append(CAPTURED_EXTENSION, record.operationId, {
        operationId: record.operationId,
        baseRevisionId: record.baseRevisionId,
        workingCopyId: record.workingCopyId,
        testedRevisionId: record.testedRevisionId,
        copyModified,
        inputRootHash: record.inputRootHash,
        verificationCopyId: record.verificationCopyId,
      });
    });
  } catch (error) {
    throw portable(error);
  }
  return { provenance: record, verificationCopy, testedRevision };
}

/** The recorded answer of one preparation that already ran. */
function recordedPreparation(
  store: ControlStore,
  record: ExecutionProvenance,
): VerificationRunPreparation {
  const verificationCopy = store.getWorkingCopy(record.verificationCopyId!);
  if (verificationCopy === null) {
    throw invalidRequestError(
      `The recorded verification copy ${record.verificationCopyId} is gone.`,
      { workingCopyId: record.verificationCopyId },
    );
  }
  const testedRevision = store.getRevision(record.testedRevisionId!);
  if (testedRevision === null) {
    throw invalidRequestError(
      `The tested revision ${record.testedRevisionId} is gone.`,
      { revisionId: record.testedRevisionId },
    );
  }
  return { provenance: record, verificationCopy, testedRevision };
}

/**
 * Measure one verification run's output (SPEC.md section 11.5).
 *
 * Settling hashes the private copy after the run, reports every tracked
 * path that changed against the tested revision, and stamps the record
 * settled. A repeated settle returns the recorded answer unchanged: the
 * measurement belongs to the run, not to whoever asks next.
 */
export function settleVerificationRun(
  store: ControlStore,
  sessionId: string,
  blobs: BlobStore,
  request: ProvenanceSettleRequest,
  options: VerificationSettleOptions = {},
): ExecutionProvenance {
  assertValid(provenanceSettleRequestSchema, request);
  requireOpenSession(store, sessionId);
  if (request.attachment.sessionId !== sessionId) {
    throw invalidRequestError("The provenance names an attachment of another session.", {
      attachmentId: request.attachment.attachmentId,
      sessionId,
    });
  }
  requireCurrentAttachment(store, request.attachment);
  const current = store.getExecutionProvenance(request.operationId);
  if (current === null) {
    throw invalidRequestError(
      `No provenance record exists for operation ${request.operationId}.`,
      { operationId: request.operationId },
    );
  }
  if (current.sessionId !== sessionId) {
    throw invalidRequestError(
      `The provenance of ${request.operationId} belongs to another session.`,
      { operationId: request.operationId, sessionId },
    );
  }
  if (current.settledAt !== undefined) {
    return current;
  }
  if (
    current.verificationCopyId === undefined ||
    current.testedRevisionId === undefined ||
    current.inputRootHash === undefined
  ) {
    throw unsupportedOperationError("workspace.provenance@1", "settle", {
      reason: "not-a-verification-run",
      operationId: request.operationId,
    });
  }
  const verificationCopy = store.getWorkingCopy(current.verificationCopyId);
  if (verificationCopy === null) {
    throw invalidRequestError(
      `Working copy ${current.verificationCopyId} does not exist.`,
      { copyId: current.verificationCopyId },
    );
  }
  const inputTree = store.getRevisionTree(current.testedRevisionId);
  if (inputTree === null) {
    throw invalidRequestError(
      `The tested revision ${current.testedRevisionId} has no recorded tree.`,
      { revisionId: current.testedRevisionId },
    );
  }
  const imported = buildTreeFromDirectory(verificationCopy.rootPath, blobs);
  const changed = diffTrees(
    JSON.parse(inputTree.entriesJson) as TreeEntry[],
    imported.entries,
  );
  const settled: ExecutionProvenance = {
    ...current,
    outputRootHash: imported.rootHash,
    changedPaths: changed,
    settledAt: nowUtcTimestamp(),
  };
  const stream = new SessionEventStream(store, sessionId, options.redactor);
  try {
    store.transaction(() => {
      store.saveExecutionProvenance(settled);
      stream.append(RECORDED_EXTENSION, settled.operationId, {
        operationId: settled.operationId,
        inputRootHash: settled.inputRootHash,
        outputRootHash: settled.outputRootHash,
        changedCount: changed.length,
      });
    });
  } catch (error) {
    throw portable(error);
  }
  return settled;
}

// -- Internals ------------------------------------------------------------------

/** Validate the request's attachment and copy, returning both. */
function checkAttachmentAndCopy(
  store: ControlStore,
  sessionId: string,
  request: ProvenanceCaptureRequest,
): { copy: WorkingCopyRecord; base: WorkspaceRevision } {
  if (request.attachment.sessionId !== sessionId) {
    throw invalidRequestError(
      "The provenance names an attachment of another session.",
      { attachmentId: request.attachment.attachmentId, sessionId },
    );
  }
  requireCurrentAttachment(store, request.attachment);
  const copy = store.getWorkingCopy(request.workingCopyId);
  if (copy === null) {
    throw invalidRequestError(
      `Working copy ${request.workingCopyId} does not exist.`,
      { copyId: request.workingCopyId },
    );
  }
  if (copy.sessionId !== sessionId) {
    throw invalidRequestError(
      `Working copy ${request.workingCopyId} belongs to another session.`,
      { copyId: request.workingCopyId, sessionId },
    );
  }
  const base = store.getRevision(copy.baseRevisionId);
  if (base === null) {
    throw invalidRequestError(
      `The copy's base revision ${copy.baseRevisionId} does not exist.`,
      { baseRevisionId: copy.baseRevisionId },
    );
  }
  return { copy, base };
}

/** Build the capture record from one validated request. */
function captureRecord(
  store: ControlStore,
  sessionId: string,
  request: ProvenanceCaptureRequest,
  options: ProvenanceEnvironmentOptions,
): ExecutionProvenance {
  const manifest = options.manifest;
  const copy = store.getWorkingCopy(request.workingCopyId);
  if (copy === null) {
    throw invalidRequestError(
      `Working copy ${request.workingCopyId} does not exist.`,
      { copyId: request.workingCopyId },
    );
  }
  return {
    operationId: request.operationId,
    sessionId,
    attachment: request.attachment,
    capability: request.capability,
    operation: request.operation,
    arguments: request.arguments,
    baseRevisionId: copy.baseRevisionId,
    workingCopyId: request.workingCopyId,
    ...(manifest !== undefined
      ? {
          adapterVersion: manifest.adapterVersion,
          manifestDigest: digestOfValue(manifest),
        }
      : {}),
    ...(options.dependencyIds !== undefined
      ? { dependencyIds: [...options.dependencyIds] }
      : {}),
    ...(options.imageId !== undefined ? { imageId: options.imageId } : {}),
    capturedAt: nowUtcTimestamp(),
  };
}

/** Compare input and output trees into sorted tracked-path changes. */
function diffTrees(input: TreeEntry[], output: TreeEntry[]): TrackedPathChange[] {
  const inputByPath = new Map(input.map((entry) => [entry.path, entry]));
  const outputByPath = new Map(output.map((entry) => [entry.path, entry]));
  const changes: TrackedPathChange[] = [];
  for (const [path, entry] of outputByPath) {
    const before = inputByPath.get(path);
    if (before === undefined) {
      changes.push({ path, change: "added" });
    } else if (!sameEntry(before, entry)) {
      changes.push({ path, change: "modified" });
    }
  }
  for (const path of inputByPath.keys()) {
    if (!outputByPath.has(path)) {
      changes.push({ path, change: "removed" });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Whether two entries of one path carry the same content. */
function sameEntry(a: TreeEntry, b: TreeEntry): boolean {
  return a.kind === b.kind && a.executable === b.executable && a.contentHash === b.contentHash;
}

/** Map one store error to its portable form; pass others through. */
function portable(error: unknown): unknown {
  if (error instanceof StoreError) {
    return error.toPortableError();
  }
  return error;
}

/** Canonical JSON with recursively sorted keys. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Digest of one environment manifest under canonical JSON. */
export function manifestDigestOf(manifest: EnvironmentManifest): Sha256Hex {
  return digestOfValue(manifest);
}

function digestOfValue(value: unknown): Sha256Hex {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
