import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PolicyAuthority } from "../core/policy.js";
import { checkRawTransfer } from "../core/secrets.js";
import { integrityFailureError, invalidRequestError } from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import { requireExtensions } from "../core/compatibility.js";
import { ValidationError, validateAgainstSchema } from "../schema/validate.js";
import { nowUtcTimestamp } from "../core/time.js";
import type { ControlStore, ResourceBindingRecord } from "../store/control-store.js";
import type { BlobStore, BlobRef } from "../store/blob-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import { canonicalTreeJson, checkTreeManifest, treeRootHash } from "../store/workspace-tree.js";
import type { TreeEntry } from "../store/workspace-tree.js";
import type {
  BundleArtifact,
  BundleManifest,
  BundleRetrievalLocation,
} from "../schema/bundle.js";
import { bundleManifestSchema } from "../schema/bundle.js";
import type { AttachmentSummary, SessionRecord } from "../schema/session.js";
import type { PortableEvent } from "../schema/event.js";

/**
 * Portable state bundle import (SPEC.md sections 19 and 20).
 *
 * Import validates a bundle completely before it materializes
 * anything: manifest schema, artifact paths, digests, sizes, the
 * workspace tree, the declared blob coverage, and the required
 * extensions this consumer must understand. Only then does one
 * transaction create the new session, publish the revision, and
 * record the attachments.
 *
 * Import claims no authority it does not have. It never executes
 * reconstruction recipes, never continues the source session, and
 * never assumes the destination harness can interpret the opaque
 * harness context reference. A bundle has no authority over its
 * source session: import creates a new session under the importer's
 * own policy, and continuing the same session requires the original
 * authoritative control store and its locks. Imported resource
 * bindings arrive invalidated, each naming the disposition action it
 * waits for; handles become valid only through the ordinary
 * reattachment or reconstruction flows.
 */

/** What one import asks for. */
export interface BundleImportRequest {
  /** The identifier of the new session. Defaults to a fresh one. */
  sessionId?: string;
  /** The identifier of the new workspace. Defaults to a fresh one. */
  workspaceId?: string;
  /** The policy the new session runs under. The bundle carries none. */
  policyRef: string;
}

/** Options of one bundle import. */
export interface BundleImportOptions {
  /** The blob store that holds the new session's workspace content. */
  blobs: BlobStore;
  /** The bundle root directory, as written by `exportBundle`. */
  rootPath: string;
  /** The policy authority in force for the transfer. */
  authority: PolicyAuthority;
  /** Extensions this consumer understands, against `requiredExtensions`. */
  supportedExtensions?: string[];
  /**
   * Produces the bytes of one retrieval location, for a reference-only
   * bundle. The location was screened for credential-shaped material
   * before this runs.
   */
  fetchBytes?: (location: string) => Uint8Array;
}

/** The report of one bundle import. */
export interface BundleImportReport {
  /** The new session the bundle became. Never the source session. */
  sessionId: string;
  /** The new workspace that holds the imported revision. */
  workspaceId: string;
  /** The imported revision. It keeps the bundle's revision identity. */
  revisionId: string;
  /** The manifest the import validated against. */
  manifest: BundleManifest;
  /** File entries the imported tree carries. */
  fileCount: number;
  /** Combined size of the blobs the import stored. */
  totalBytes: number;
  /** Attachments recorded, re-keyed to the new session. */
  attachments: AttachmentSummary[];
  /** Bindings recorded, invalidated pending their disposition action. */
  resources: ResourceBindingRecord[];
  /** Journal events replayed into the new session. */
  journalEvents: number;
  /** Opaque harness context reference, carried verbatim, never interpreted. */
  harnessContextRef?: string;
}

/** One reserved document of the bundle, as parsed for import. */
interface BundleDocuments {
  manifest: BundleManifest;
  entries: TreeEntry[];
  state: StateFile;
  resources: ResourcesFile;
  events: PortableEvent[];
}

/** The shape `state.json` carries, as the exporter writes it. */
interface StateFile {
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
  harnessContextRef?: string;
}

/** The shape `resources.json` carries, as the exporter writes it. */
interface ResourcesFile {
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
    expiresAt?: string;
    extensions?: Record<string, unknown>;
  }>;
}

const MANIFEST_PATH = "manifest.json";
const TREE_PATH = "workspace/tree.json";
const STATE_PATH = "state.json";
const RESOURCES_PATH = "resources.json";
const JOURNAL_PATH = "journal.jsonl";
const BLOB_DIR = "blobs/sha256";

/** The provenance extension the imported revision carries. */
const BUNDLE_SOURCE_EXTENSION = "portable.bundle.source";

/**
 * Import one validated bundle as a new session.
 *
 * Validation and materialization are sequential: every check runs
 * before the first store write, so a refused import changes nothing.
 */
export function importBundle(
  store: ControlStore,
  request: BundleImportRequest,
  options: BundleImportOptions,
): BundleImportReport {
  const denied = checkRawTransfer(options.authority, "local");
  if (denied !== null) {
    throw denied;
  }
  const documents = validateBundle(options);

  // A consumer that lacks a required extension rejects the bundle.
  const unsupported = requireExtensions(
    documents.manifest.requiredExtensions ?? [],
    options.supportedExtensions ?? [],
  );
  if (unsupported !== null) {
    throw unsupported;
  }

  // A bundle holds no authority over its source session: when this
  // store already holds that session, only the authoritative store
  // can continue it, and never through a bundle import.
  if (store.getSession(documents.manifest.sourceSessionId) !== null) {
    throw invalidRequestError(
      "This store already holds the bundle's source session; continuing it requires the authoritative control store and its locks, not an import.",
      { sourceSessionId: documents.manifest.sourceSessionId },
    );
  }
  if (store.getRevision(documents.manifest.workspaceRevisionId) !== null) {
    throw invalidRequestError("This store already holds the bundle's revision.", {
      workspaceRevisionId: documents.manifest.workspaceRevisionId,
    });
  }

  const sessionId = request.sessionId ?? `sess-${randomUUID()}`;
  const workspaceId = request.workspaceId ?? `ws-${randomUUID()}`;
  if (store.getSession(sessionId) !== null) {
    throw invalidRequestError(`Session ${sessionId} already exists in this store.`, {
      sessionId,
    });
  }

  // The blobs cross first: a revision may only reference digests the
  // store holds as verified content.
  const referenced = referencedDigests(documents.entries);
  const stored = storeBlobs(options, documents.manifest, referenced);

  const session: SessionRecord = {
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId,
    eventSequence: 0,
    policyRef: request.policyRef,
    createdAt: nowUtcTimestamp(),
  };
  const attachments = documents.state.attachments.map((attachment) => ({
    ...attachment,
    sessionId,
  }));
  const resources = documents.resources.resources.map((resource) =>
    importedBinding(resource, sessionId),
  );
  const stream = new SessionEventStream(store, sessionId);
  const revision = {
    id: documents.manifest.workspaceRevisionId,
    workspaceId,
    rootHash: documents.manifest.rootHash,
    createdAt: nowUtcTimestamp(),
    extensions: {
      [BUNDLE_SOURCE_EXTENSION]: {
        sourceSessionId: documents.manifest.sourceSessionId,
        sourceWorkspaceId: documents.state.session.workspaceId,
        sourceCreatedAt: documents.state.revision.createdAt,
        selfContained: documents.manifest.selfContained,
      },
    },
  };
  const fileCount = documents.entries.filter((entry) => entry.kind === "file").length;
  const totalBytes = stored.reduce((sum, blob) => sum + blob.sizeBytes, 0);

  store.transaction(() => {
    store.createSession(session);
    options.blobs.publishRevision(revision, stored);
    if (!store.casWorkspaceHead(workspaceId, null, revision.id)) {
      throw invalidRequestError(`Workspace ${workspaceId} already holds a head.`, {
        workspaceId,
      });
    }
    store.insertRevisionTree(revision.id, revision.rootHash, canonicalTreeJson(documents.entries));
    for (const attachment of attachments) {
      store.insertAttachment(attachment);
    }
    for (const binding of resources) {
      store.insertResourceBinding(binding);
    }
    // The journal replays as history: each event passed the same
    // payload validation here that it passed at record time.
    for (const event of documents.events) {
      stream.append(event.type, event.subjectId, event.data);
    }
  });

  return {
    sessionId,
    workspaceId,
    revisionId: revision.id,
    manifest: documents.manifest,
    fileCount,
    totalBytes,
    attachments,
    resources,
    journalEvents: documents.events.length,
    ...(documents.manifest.harnessContextRef !== undefined
      ? { harnessContextRef: documents.manifest.harnessContextRef }
      : {}),
  };
}

// -- Validation -------------------------------------------------------------------

/**
 * Validate one bundle against its own bytes.
 *
 * Every check reads the files the inventory declares and measures
 * them: a manifest that lies about size or digest refuses, a file the
 * inventory never named refuses, and a tree that does not hash to the
 * declared root refuses.
 */
function validateBundle(options: BundleImportOptions): BundleDocuments {
  const root = options.rootPath;
  let manifestText: string;
  try {
    manifestText = readFileSync(join(root, MANIFEST_PATH), "utf8");
  } catch {
    throw invalidRequestError(`Bundle directory ${root} holds no ${MANIFEST_PATH}.`, { root });
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch {
    throw integrityFailureError(MANIFEST_PATH, "parseable JSON", "invalid content");
  }
  const issues = validateAgainstSchema(bundleManifestSchema, manifestJson);
  if (issues.length > 0) {
    const failure = new ValidationError(issues);
    throw invalidRequestError(`The bundle manifest failed schema validation: ${failure.message}`, {
      issues: issues.map((issue) => ({
        path: issue.instancePath || "/",
        keyword: issue.keyword,
        message: issue.message,
      })),
    });
  }
  const manifest = manifestJson as BundleManifest;

  // Every inventory path must be a safe relative path inside the bundle.
  const declared = new Map<string, BundleArtifact>();
  for (const artifact of manifest.artifactInventory) {
    const unsafe = checkBundlePath(artifact.path);
    if (unsafe !== null) {
      throw unsafe;
    }
    if (declared.has(artifact.path)) {
      throw invalidRequestError(`The inventory declares ${artifact.path} twice.`, {
        path: artifact.path,
      });
    }
    declared.set(artifact.path, artifact);
  }

  // Every declared artifact must exist and measure up, and nothing
  // undeclared may ride along. A reference-only bundle declares the
  // blobs it deliberately does not carry; those stay measured only.
  const bytesOnDisk = new Map<string, Uint8Array>();
  for (const [path, artifact] of declared) {
    const measuredOnly = !manifest.selfContained && path.startsWith(`${BLOB_DIR}/`);
    if (measuredOnly) {
      continue;
    }
    const target = join(root, path);
    let size: number;
    try {
      size = statSync(target).size;
    } catch {
      throw integrityFailureError(`artifact ${path}`, "present", "absent");
    }
    if (size !== artifact.sizeBytes) {
      throw integrityFailureError(
        `artifact ${path}`,
        `${artifact.sizeBytes} bytes`,
        `${size} bytes`,
      );
    }
    const bytes = readFileSync(target);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.digest) {
      throw integrityFailureError(`artifact ${path}`, artifact.digest, digest);
    }
    bytesOnDisk.set(path, bytes);
  }
  refuseUndeclaredContent(root, declared);

  // The tree anchors every claim about workspace state.
  const treeBytes = requiredBytes(bytesOnDisk, TREE_PATH);
  let entriesJson: string;
  try {
    entriesJson = new TextDecoder().decode(treeBytes);
  } catch {
    throw integrityFailureError(TREE_PATH, "UTF-8 text", "invalid encoding");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entriesJson);
  } catch {
    throw integrityFailureError(TREE_PATH, "parseable JSON", "invalid content");
  }
  if (!Array.isArray(parsed)) {
    throw integrityFailureError(TREE_PATH, "an entry array", "another shape");
  }
  const entries = parsed as TreeEntry[];
  const structural = checkTreeManifest(entries);
  if (structural !== null) {
    throw structural;
  }
  if (canonicalTreeJson(entries) !== entriesJson) {
    throw integrityFailureError(TREE_PATH, "canonical form", "non-canonical content");
  }
  const computed = treeRootHash(entries);
  if (computed !== manifest.rootHash) {
    throw integrityFailureError("workspace tree", manifest.rootHash, computed);
  }

  const state = parseDocument<StateFile>(bytesOnDisk, STATE_PATH, "portable.state");
  const resources = parseDocument<ResourcesFile>(bytesOnDisk, RESOURCES_PATH, "portable.resources");
  const events = parseJournal(bytesOnDisk, JOURNAL_PATH);

  // The documents must agree with the manifest they travel with.
  if (state.session.id !== manifest.sourceSessionId) {
    throw integrityFailureError(
      `${STATE_PATH} session id`,
      manifest.sourceSessionId,
      state.session.id,
    );
  }
  if (state.revision.id !== manifest.workspaceRevisionId) {
    throw integrityFailureError(
      `${STATE_PATH} revision id`,
      manifest.workspaceRevisionId,
      state.revision.id,
    );
  }
  if (state.revision.rootHash !== manifest.rootHash) {
    throw integrityFailureError(`${STATE_PATH} root hash`, manifest.rootHash, state.revision.rootHash);
  }
  mapAttachmentGenerations(manifest, state);
  checkResourceOwners(state, resources);
  return { manifest, entries, state, resources, events };
}

/** Check one attachment map against the state document. */
function mapAttachmentGenerations(
  manifest: BundleManifest,
  state: StateFile,
): void {
  const recorded = new Map(state.attachments.map((entry) => [entry.name, entry.generation]));
  for (const [name, generation] of Object.entries(manifest.attachmentGenerations)) {
    if (recorded.get(name) !== generation) {
      throw integrityFailureError(
        `attachment generation of ${name}`,
        String(generation),
        String(recorded.get(name)),
      );
    }
    recorded.delete(name);
  }
  if (recorded.size > 0) {
    throw invalidRequestError("The state document names attachments the manifest does not.", {
      unaccounted: [...recorded.keys()],
    });
  }
}

/** Every resource binding must name an attachment the state carries. */
function checkResourceOwners(state: StateFile, resources: ResourcesFile): void {
  const owners = new Map(
    state.attachments.map((entry) => [entry.attachmentId, entry.generation]),
  );
  for (const resource of resources.resources) {
    const generation = owners.get(resource.owner.attachmentId);
    if (generation === undefined) {
      throw invalidRequestError(
        `Resource ${resource.id} names attachment ${resource.owner.attachmentId}, which the state document does not carry.`,
        { resourceId: resource.id, attachmentId: resource.owner.attachmentId },
      );
    }
    if (generation !== resource.owner.generation) {
      throw integrityFailureError(
        `owner generation of ${resource.id}`,
        String(generation),
        String(resource.owner.generation),
      );
    }
  }
}

/** Parse one JSON document the inventory must carry. */
function parseDocument<T>(bytesOnDisk: Map<string, Uint8Array>, path: string, kind: string): T {
  const bytes = requiredBytes(bytesOnDisk, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw integrityFailureError(path, "parseable JSON", "invalid content");
  }
  const shape = parsed as { kind?: unknown };
  if (shape === null || typeof shape !== "object" || shape.kind !== kind) {
    throw integrityFailureError(path, `kind ${kind}`, String(shape?.kind));
  }
  return parsed as T;
}

/** Parse the journal, one event per line, in order. */
function parseJournal(bytesOnDisk: Map<string, Uint8Array>, path: string): PortableEvent[] {
  const bytes = requiredBytes(bytesOnDisk, path);
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) {
    return [];
  }
  const events: PortableEvent[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index === lines.length - 1 && line === "") {
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw integrityFailureError(`${path} line ${index + 1}`, "parseable JSON", "invalid content");
    }
    const shape = parsed as Partial<PortableEvent>;
    if (
      typeof shape.type !== "string" ||
      typeof shape.subjectId !== "string" ||
      shape.data === null ||
      typeof shape.data !== "object"
    ) {
      throw integrityFailureError(
        `${path} line ${index + 1}`,
        "an event with a type, a subject, and data",
        "another shape",
      );
    }
    events.push({
      schemaVersion: 1,
      sessionId: shape.sessionId ?? "",
      sequence: shape.sequence ?? index,
      occurredAt: shape.occurredAt ?? "",
      type: shape.type,
      subjectId: shape.subjectId,
      data: shape.data as Record<string, unknown>,
      ...(shape.extensions !== undefined ? { extensions: shape.extensions } : {}),
    });
  }
  return events;
}

/** Reject one path that is not a safe relative path inside the bundle. */
function checkBundlePath(path: string): PortableError | null {
  const problem = (reason: string) =>
    invalidRequestError(`The bundle path is not valid: ${reason}.`, { path, reason });
  if (path.length === 0) {
    return problem("the path is empty");
  }
  if (path.startsWith("/") || path.includes("\\")) {
    return problem("the path is absolute or uses a backslash");
  }
  if (path.includes("\0")) {
    return problem("the path contains a null byte");
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return problem("the path has an empty, dot, or parent segment");
    }
    if (/^[a-zA-Z]:$/.test(segment)) {
      return problem("the path names a drive");
    }
  }
  return null;
}

/** Refuse any file the manifest never declared. */
function refuseUndeclaredContent(root: string, declared: Map<string, BundleArtifact>): void {
  const allowed = new Set<string>([MANIFEST_PATH, ...declared.keys()]);
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (!allowed.has(path)) {
        throw invalidRequestError(
          `The bundle carries ${path}, which its manifest never declared.`,
          { path },
        );
      }
    }
  };
  walk("");
}

/** The bytes of one required artifact, refusing its absence. */
function requiredBytes(bytesOnDisk: Map<string, Uint8Array>, path: string): Uint8Array {
  const bytes = bytesOnDisk.get(path);
  if (bytes === undefined) {
    throw invalidRequestError(`The bundle inventory omits the required ${path}.`, { path });
  }
  return bytes;
}

/** Every digest the tree references, deduplicated. */
function referencedDigests(entries: readonly TreeEntry[]): string[] {
  return [
    ...new Set(
      entries.flatMap((entry) => (entry.contentHash !== null ? [entry.contentHash] : [])),
    ),
  ];
}

/**
 * Store every referenced blob.
 *
 * A self-contained bundle must carry each one; a reference-only
 * bundle must name an authorized location for each, and the fetcher
 * produces bytes that pass the same write-and-verify path as any
 * other blob.
 */
function storeBlobs(
  options: BundleImportOptions,
  manifest: BundleManifest,
  referenced: string[],
): BlobRef[] {
  const refs: BlobRef[] = [];
  if (manifest.selfContained) {
    for (const digest of referenced) {
      const path = `${BLOB_DIR}/${digest}`;
      const target = join(options.rootPath, path);
      let data: Uint8Array | null = null;
      try {
        data = readFileSync(target);
      } catch {
        data = null;
      }
      if (data === null) {
        throw integrityFailureError(`blob ${digest}`, "present in the bundle", "absent");
      }
      refs.push(options.blobs.put(data));
    }
    return refs;
  }
  if (options.fetchBytes === undefined) {
    throw invalidRequestError(
      "A reference-only bundle needs a blob fetcher; the import cannot invent its locations.",
      { referenced: referenced.length },
    );
  }
  const locations = new Map<string, BundleRetrievalLocation>();
  for (const location of manifest.retrievalLocations ?? []) {
    locations.set(location.digest, location);
  }
  for (const digest of referenced) {
    const location = locations.get(digest);
    if (location === undefined) {
      throw invalidRequestError(
        `The bundle names no authorized retrieval location for blob ${digest}.`,
        { digest },
      );
    }
    refs.push(options.blobs.putFromRetrieval(location.location, options.fetchBytes));
  }
  return refs;
}

/** One imported binding: invalidated, pending its disposition action. */
function importedBinding(
  resource: ResourcesFile["resources"][number],
  sessionId: string,
): ResourceBindingRecord {
  const action = actionOfRecovery(resource.recovery);
  return {
    id: resource.id,
    sessionId,
    type: resource.type,
    capability: resource.capability,
    owner: {
      sessionId,
      attachmentId: resource.owner.attachmentId,
      generation: resource.owner.generation,
    },
    lifetime: resource.lifetime as ResourceBindingRecord["lifetime"],
    recovery: resource.recovery as ResourceBindingRecord["recovery"],
    status: "invalidated",
    ...(resource.providerResourceId !== undefined
      ? { providerResourceId: resource.providerResourceId }
      : {}),
    ...(resource.expiresAt !== undefined ? { expiresAt: resource.expiresAt } : {}),
    ...(resource.extensions !== undefined ? { extensions: resource.extensions } : {}),
    boundAt: nowUtcTimestamp(),
    invalidatedAt: nowUtcTimestamp(),
    invalidationReason: `imported-pending-${action}`,
  };
}

/** The disposition action one recovery mode waits for. */
function actionOfRecovery(recovery: string): string {
  if (recovery === "reconstruct" || recovery === "reattach" || recovery === "native" || recovery === "none") {
    const action = { reconstruct: "reconstruct", reattach: "reattach", native: "invalidate", none: "invalidate" } as const;
    return action[recovery as keyof typeof action];
  }
  throw invalidRequestError(`The bundle carries a resource of unknown recovery ${recovery}.`, {
    recovery,
  });
}
