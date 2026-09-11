import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PolicyAuthority } from "../core/policy.js";
import { checkRawTransfer, checkRetrievalLocation } from "../core/secrets.js";
import { integrityFailureError, invalidRequestError, scrubValue } from "../core/errors.js";
import { nowUtcTimestamp } from "../core/time.js";
import type { ControlStore, ResourceBindingRecord } from "../store/control-store.js";
import type { BlobStore } from "../store/blob-store.js";
import type { EventRedactor } from "../store/event-stream.js";
import {
  canonicalTreeJson,
  checkTreeManifest,
  treeRootHash,
} from "../store/workspace-tree.js";
import type { TreeEntry } from "../store/workspace-tree.js";
import { classifyResourceStates } from "./reconstruction.js";
import type { BundleArtifact, BundleManifest, BundleRetrievalLocation } from "../schema/bundle.js";
import type { WorkspaceRevision } from "../schema/workspace.js";
import type { AttachmentSummary, SessionRecord } from "../schema/session.js";
import type { PortableEvent } from "../schema/event.js";

/**
 * Portable state bundle export (SPEC.md section 19).
 *
 * A bundle exports explicit work state and references: the workspace
 * tree, the journal, the resource bindings with their dispositions,
 * and the attachment generations that own them. It is not a process
 * image and not a harness checkpoint, and it carries no authority over
 * its source session: import into another runtime creates a new
 * session, and copying a bundle never creates a second authoritative
 * controller.
 *
 * The manifest declares whether every referenced blob travels along. A
 * self-contained export copies each blob and refuses when the store
 * cannot produce it or produces bytes that do not hash to their
 * address. A reference-only export copies nothing and must name an
 * authorized retrieval location for every referenced blob; a location
 * that carries credential-shaped material refuses.
 *
 * Secrets and reusable credentials stay absent: the record files scrub
 * credential-shaped extension values, the journal passes through the
 * caller's redactor, and the workspace blobs cross only under the
 * raw-transfer grant the caller's policy already vouchsafed. The
 * optional harness context reference crosses as an opaque string;
 * nothing here interprets it.
 */

/** What one export writes. */
export interface BundleExportRequest {
  /** The revision to export. Defaults to the workspace head. */
  revisionId?: string;
  /** Include every referenced blob in the bundle. */
  selfContained: boolean;
  /** Authorized retrieval locations, for a reference-only export. */
  retrievalLocations?: BundleRetrievalLocation[];
  /** Opaque harness context reference, carried verbatim. */
  harnessContextRef?: string;
}

/** Options of one bundle export. */
export interface BundleExportOptions {
  /** The blob store that holds the workspace content. */
  blobs: BlobStore;
  /** The directory the bundle is written to. It must be empty or absent. */
  rootPath: string;
  /** The policy authority in force for the transfer. */
  authority: PolicyAuthority;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** The report of one bundle export. */
export interface BundleExportReport {
  /** The directory the bundle was written to. */
  rootPath: string;
  /** The manifest, as written. */
  manifest: BundleManifest;
  /** Files the inventory records. The manifest itself is not one. */
  artifactCount: number;
  /** Journal events the bundle carries. */
  journalEvents: number;
}

/** One file measured for the inventory; `write` false means measured only. */
interface PlannedArtifact {
  artifact: BundleArtifact;
  bytes: Uint8Array;
  write: boolean;
}

/** The reserved paths of one bundle, as SPEC.md section 19 lays out. */
const MANIFEST_PATH = "manifest.json";
const STATE_PATH = "state.json";
const RESOURCES_PATH = "resources.json";
const JOURNAL_PATH = "journal.jsonl";
const TREE_PATH = "workspace/tree.json";
const BLOB_DIR = "blobs/sha256";
const EXTENSIONS_DIR = "extensions";

const JSON_MEDIA_TYPE = "application/json";
const NDJSON_MEDIA_TYPE = "application/x-ndjson";
const BLOB_MEDIA_TYPE = "application/octet-stream";

/**
 * Export one session's explicit state as a portable bundle.
 *
 * The export writes the layout of SPEC.md section 19 into a fresh
 * directory: the manifest last, so the inventory it declares matches
 * the bytes on disk. Every artifact digest is measured from the
 * serialized bytes, not carried over from the store. The manifest is
 * not part of its own inventory: a file cannot carry its own digest.
 */
export function exportBundle(
  store: ControlStore,
  sessionId: string,
  request: BundleExportRequest,
  options: BundleExportOptions,
): BundleExportReport {
  const denied = checkRawTransfer(options.authority, "local");
  if (denied !== null) {
    throw denied;
  }
  const session = store.getSession(sessionId);
  if (session === null) {
    throw invalidRequestError(`Session ${sessionId} does not exist.`, { sessionId });
  }
  prepareRoot(options.rootPath);

  // The revision and its verified tree anchor everything the bundle
  // claims about workspace state.
  const head = store.getWorkspaceHead(session.workspaceId);
  const revisionId = request.revisionId ?? head;
  if (revisionId === null) {
    throw invalidRequestError(
      `Workspace ${session.workspaceId} holds no revision to export.`,
      { sessionId, workspaceId: session.workspaceId },
    );
  }
  const tree = loadVerifiedTree(store, session.workspaceId, revisionId);
  const attachments = store.listAttachments(sessionId);
  const bindings = store.listResourceBindings(sessionId);
  const events = listAllEvents(store, sessionId);

  // Every blob the tree references, deduplicated.
  const referenced = [
    ...new Set(
      tree.entries.flatMap((entry) =>
        entry.contentHash !== null ? [entry.contentHash] : [],
      ),
    ),
  ];

  // A reference-only export must say where each omitted blob lives,
  // through a location that carries no credential-shaped material.
  const locationsByDigest = new Map<string, BundleRetrievalLocation>();
  if (!request.selfContained) {
    for (const location of request.retrievalLocations ?? []) {
      const refused = checkRetrievalLocation(location.location);
      if (refused !== null) {
        throw refused;
      }
      locationsByDigest.set(location.digest, location);
    }
    const missing = referenced.filter((digest) => !locationsByDigest.has(digest));
    if (missing.length > 0) {
      throw invalidRequestError(
        "A reference-only export must identify an authorized retrieval location for every referenced blob.",
        { missing },
      );
    }
  }

  const planned: PlannedArtifact[] = [
    plan(TREE_PATH, encode(canonicalTreeJson(tree.entries)), JSON_MEDIA_TYPE),
    plan(
      STATE_PATH,
      encode(
        JSON.stringify(
          stateDocument(session, attachments, tree.revision, request.harnessContextRef),
          null,
          2,
        ),
      ),
      JSON_MEDIA_TYPE,
    ),
    plan(
      RESOURCES_PATH,
      encode(JSON.stringify(resourcesDocument(bindings), null, 2)),
      JSON_MEDIA_TYPE,
    ),
    plan(JOURNAL_PATH, journalBytes(events, options.redactor), NDJSON_MEDIA_TYPE),
  ];
  for (const digest of referenced) {
    planned.push(planBlob(options.blobs, digest, request.selfContained));
  }

  const manifest: BundleManifest = {
    schemaVersion: 1,
    kind: "portable.bundle",
    sourceSessionId: sessionId,
    workspaceRevisionId: revisionId,
    rootHash: tree.rootHash,
    attachmentGenerations: Object.fromEntries(
      attachments.map((attachment) => [attachment.name, attachment.generation]),
    ),
    artifactInventory: planned.map((entry) => entry.artifact),
    stateDispositions: classifyResourceStates(
      bindings.map((binding) => ({
        id: binding.id,
        type: binding.type,
        recovery: binding.recovery,
      })),
    ),
    selfContained: request.selfContained,
    ...(request.selfContained
      ? {}
      : { retrievalLocations: referenced.map((digest) => locationsByDigest.get(digest)!) }),
    ...(request.harnessContextRef !== undefined
      ? { harnessContextRef: request.harnessContextRef }
      : {}),
    createdAt: nowUtcTimestamp(),
  };

  mkdirSync(join(options.rootPath, BLOB_DIR), { recursive: true });
  mkdirSync(join(options.rootPath, EXTENSIONS_DIR), { recursive: true });
  for (const entry of planned) {
    if (entry.write) {
      const target = join(options.rootPath, entry.artifact.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.bytes);
    }
  }
  writeFileSync(
    join(options.rootPath, MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    rootPath: options.rootPath,
    manifest,
    artifactCount: manifest.artifactInventory.length,
    journalEvents: events.length,
  };
}

// -- Bundle documents -----------------------------------------------------------

/** The shape of `state.json`: the session, its attachments, its revision. */
interface StateDocument {
  schemaVersion: 1;
  kind: "portable.state";
  session: {
    id: string;
    status: string;
    workspaceId: string;
    policyRef: string;
    createdAt: string;
  };
  revision: {
    id: string;
    workspaceId: string;
    parentId?: string;
    rootHash: string;
    createdAt: string;
  };
  attachments: AttachmentSummary[];
  /** Opaque, verbatim, never interpreted here. */
  harnessContextRef?: string;
}

/** The shape of `resources.json`: the bindings, without session chatter. */
interface ResourcesDocument {
  schemaVersion: 1;
  kind: "portable.resources";
  resources: Array<{
    id: string;
    type: string;
    capability: string;
    lifetime: string;
    recovery: string;
    owner: { attachmentId: string; generation: number };
    status: string;
    providerResourceId?: string;
    extensions?: Record<string, unknown>;
  }>;
}

/** Build `state.json` with credential-shaped extension values scrubbed. */
function stateDocument(
  session: SessionRecord,
  attachments: AttachmentSummary[],
  revision: WorkspaceRevision,
  harnessContextRef: string | undefined,
): StateDocument {
  return {
    schemaVersion: 1,
    kind: "portable.state",
    session: {
      id: session.id,
      status: session.status,
      workspaceId: session.workspaceId,
      policyRef: session.policyRef,
      createdAt: session.createdAt,
    },
    revision: {
      id: revision.id,
      workspaceId: revision.workspaceId,
      ...(revision.parentId !== undefined ? { parentId: revision.parentId } : {}),
      rootHash: revision.rootHash,
      createdAt: revision.createdAt,
    },
    attachments: attachments.map((attachment) =>
      attachment.extensions === undefined
        ? attachment
        : {
            ...attachment,
            extensions: scrubValue(attachment.extensions) as Record<string, unknown>,
          },
    ),
    ...(harnessContextRef !== undefined ? { harnessContextRef } : {}),
  };
}

/** Build `resources.json` with credential-shaped extension values scrubbed. */
function resourcesDocument(bindings: ResourceBindingRecord[]): ResourcesDocument {
  return {
    schemaVersion: 1,
    kind: "portable.resources",
    resources: bindings.map((binding) => ({
      id: binding.id,
      type: binding.type,
      capability: binding.capability,
      lifetime: binding.lifetime,
      recovery: binding.recovery,
      owner: {
        attachmentId: binding.owner.attachmentId,
        generation: binding.owner.generation,
      },
      status: binding.status,
      ...(binding.providerResourceId !== undefined
        ? { providerResourceId: binding.providerResourceId }
        : {}),
      ...(binding.extensions !== undefined
        ? { extensions: scrubValue(binding.extensions) as Record<string, unknown> }
        : {}),
    })),
  };
}

/** Serialize the journal, one event per line, through the redactor. */
function journalBytes(events: PortableEvent[], redactor: EventRedactor | undefined): Uint8Array {
  const lines = events.map((event) =>
    JSON.stringify(redactor === undefined ? event : { ...event, data: redactor(event.data) }),
  );
  return encode(lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

// -- Writer helpers ---------------------------------------------------------------

/** Encode text as UTF-8 bytes. */
function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Plan one artifact that the bundle always writes. */
function plan(path: string, bytes: Uint8Array, mediaType: string): PlannedArtifact {
  return { artifact: measure(path, bytes, mediaType), bytes, write: true };
}

/** Plan one blob: read, hash-verify, and copy only when included. */
function planBlob(blobs: BlobStore, digest: string, selfContained: boolean): PlannedArtifact {
  const data = blobs.get(digest as `sha256-${string}`);
  if (data === null) {
    throw integrityFailureError(`blob ${digest}`, "present in the store", "absent");
  }
  const measured = createHash("sha256").update(data).digest("hex");
  if (measured !== digest) {
    throw integrityFailureError(`blob ${digest}`, digest, measured);
  }
  return {
    artifact: measure(`${BLOB_DIR}/${digest}`, data, BLOB_MEDIA_TYPE),
    bytes: data,
    write: selfContained,
  };
}

/** Measure one artifact's digest and size from its bytes. */
function measure(path: string, data: Uint8Array, mediaType: string): BundleArtifact {
  return {
    path,
    digest: createHash("sha256").update(data).digest("hex") as `sha256-${string}`,
    sizeBytes: data.byteLength,
    mediaType,
  };
}

/** Create the bundle root, refusing to touch anything already there. */
function prepareRoot(rootPath: string): void {
  if (existsSync(rootPath)) {
    const held = readdirSync(rootPath);
    if (held.length > 0) {
      throw invalidRequestError(
        `Bundle directory ${rootPath} is not empty; a bundle never overwrites one.`,
        { rootPath, entries: held.length },
      );
    }
  } else {
    mkdirSync(rootPath, { recursive: true });
  }
}

/** Load one revision and verify its tree against its recorded root hash. */
function loadVerifiedTree(
  store: ControlStore,
  workspaceId: string,
  revisionId: string,
): { revision: WorkspaceRevision; rootHash: string; entries: TreeEntry[] } {
  const revision = store.getRevision(revisionId);
  if (revision === null || revision.workspaceId !== workspaceId) {
    throw invalidRequestError(`Revision ${revisionId} does not exist in the workspace.`, {
      revisionId,
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
  return { revision, rootHash: revision.rootHash, entries };
}

/** Read every journal event of one session, across list windows. */
function listAllEvents(store: ControlStore, sessionId: string): PortableEvent[] {
  const events: PortableEvent[] = [];
  const window = 500;
  for (;;) {
    const batch = store.listEvents(sessionId, events.length, window);
    events.push(...batch);
    if (batch.length < window) {
      return events;
    }
  }
}
