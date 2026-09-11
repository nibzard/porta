import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  integrityFailureError,
  invalidRequestError,
  unsupportedOperationError,
} from "../core/errors.js";
import type { Sha256Hex } from "../schema/defs.js";
import type { PortableError } from "../schema/error.js";
import type { BlobRef, BlobStore } from "./blob-store.js";

/**
 * Canonical workspace trees and paths (SPEC.md sections 11.1 and 11.2).
 *
 * A tree manifest is a flat, sorted array of entries. Each entry carries
 * exactly `path`, `kind`, `executable`, and `contentHash`; directories
 * use `executable: false` and `contentHash: null`. The root digest is
 * the SHA-256 of the UTF-8 JSON encoding of the sorted array, in that
 * field order and without whitespace, with paths keeping their original
 * Unicode sequence.
 *
 * Paths are relative, use `/` separators, and contain no empty, `.`,
 * or `..` segments. Absolute paths, null bytes, and unpaired surrogates
 * are rejected. Importing a directory rejects symbolic links, device
 * files, sockets, and FIFOs with explicit errors instead of
 * dereferencing them. Materialization rejects colliding and
 * unrepresentable names without renaming anything.
 */

/** Kind of one tree entry. Version one has files and directories. */
export type TreeEntryKind = "file" | "directory";

/** One entry of a canonical tree manifest. */
export interface TreeEntry {
  path: string;
  kind: TreeEntryKind;
  executable: boolean;
  contentHash: Sha256Hex | null;
}

/** Options for importing one local directory. */
export interface ImportOptions {
  /** Relative paths to skip, recorded by the caller as exclusions. */
  exclusions?: readonly string[];
}

/** The outcome of importing one local directory. */
export interface ImportedTree {
  /** Canonical, sorted manifest entries. */
  entries: TreeEntry[];
  /** Digest of the canonical manifest encoding. */
  rootHash: Sha256Hex;
  /** Every blob the manifest references, for publication. */
  blobRefs: BlobRef[];
}

/**
 * Check one workspace path against the rules of SPEC.md section 11.1.
 *
 * Returns null for a valid path and a `InvalidRequest` error naming the
 * rule otherwise.
 */
export function validateWorkspacePath(path: string): PortableError | null {
  const problem = (reason: string): PortableError =>
    invalidRequestError(`The workspace path is not valid: ${reason}.`, {
      path,
      reason,
    });
  if (path.length === 0) {
    return problem("the path is empty");
  }
  if (path.includes("\0")) {
    return problem("the path contains a null byte");
  }
  if (path.startsWith("/")) {
    return problem("the path is absolute");
  }
  if (path.includes("\\")) {
    return problem("the path uses a backslash instead of a slash");
  }
  // A lone surrogate cannot survive a UTF-8 round trip, so a name that
  // contains one cannot be represented on any target filesystem.
  if (Buffer.from(path, "utf8").toString("utf8") !== path) {
    return problem("the path contains an unpaired surrogate");
  }
  for (const segment of path.split("/")) {
    if (segment === "") {
      return problem("the path has an empty segment");
    }
    if (segment === "." || segment === "..") {
      return problem(`the segment ${segment} is not allowed`);
    }
  }
  return null;
}

/** Order two paths by their UTF-8 bytes (SPEC.md section 11.2). */
export function compareTreePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Check one manifest for structural problems.
 *
 * Every path must be valid and unique, directory entries must carry no
 * file metadata, file entries must carry a digest, and no file entry may
 * sit where another entry needs a directory.
 */
export function checkTreeManifest(entries: readonly TreeEntry[]): PortableError | null {
  const kinds = new Map<string, TreeEntryKind>();
  for (const entry of entries) {
    const invalid = validateWorkspacePath(entry.path);
    if (invalid !== null) {
      return invalid;
    }
    const previous = kinds.get(entry.path);
    if (previous !== undefined) {
      return invalidRequestError(`Two tree entries share the path ${entry.path}.`, {
        path: entry.path,
        reason: "duplicate-path",
      });
    }
    if (entry.kind === "directory") {
      if (entry.executable || entry.contentHash !== null) {
        return invalidRequestError(
          `Directory entry ${entry.path} carries file metadata.`,
          { path: entry.path, reason: "directory-metadata" },
        );
      }
    } else if (entry.kind === "file") {
      if (entry.contentHash === null) {
        return invalidRequestError(`File entry ${entry.path} has no content hash.`, {
          path: entry.path,
          reason: "missing-content-hash",
        });
      }
    } else {
      return invalidRequestError(`Tree entry ${entry.path} has an unknown kind.`, {
        path: entry.path,
        reason: "unknown-kind",
        kind: entry.kind,
      });
    }
    kinds.set(entry.path, entry.kind);
  }
  // A file cannot sit where another entry needs a directory.
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let cut = 1; cut < segments.length; cut += 1) {
      const ancestor = segments.slice(0, cut).join("/");
      if (kinds.get(ancestor) === "file") {
        return invalidRequestError(
          `File entry ${ancestor} sits where ${entry.path} needs a directory.`,
          { path: entry.path, reason: "file-directory-conflict", conflict: ancestor },
        );
      }
    }
  }
  return null;
}

/**
 * The canonical UTF-8 JSON encoding of one manifest (SPEC.md 11.2).
 *
 * Entries sort by UTF-8 path bytes; each entry serializes with the
 * fields in the order `path`, `kind`, `executable`, `contentHash` and
 * no whitespace. A structurally invalid manifest throws.
 */
export function canonicalTreeJson(entries: readonly TreeEntry[]): string {
  const problem = checkTreeManifest(entries);
  if (problem !== null) {
    throw problem;
  }
  const sorted = [...entries].sort((a, b) => compareTreePaths(a.path, b.path));
  return JSON.stringify(
    sorted.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      executable: entry.executable,
      contentHash: entry.contentHash,
    })),
  );
}

/** The root digest of one manifest: SHA-256 of its canonical encoding. */
export function treeRootHash(entries: readonly TreeEntry[]): Sha256Hex {
  return createHash("sha256").update(canonicalTreeJson(entries), "utf8").digest("hex") as Sha256Hex;
}

/**
 * Import one local directory into a canonical manifest plus blobs.
 *
 * Every file's bytes go through the blob store, so imported content is
 * deduplicated and integrity-checked before any revision can reference
 * it. Symbolic links, device files, sockets, and FIFOs are rejected
 * with explicit errors; nothing is dereferenced. Ownership, access
 * control lists, and modification times are not portable metadata and
 * are not recorded.
 */
export function buildTreeFromDirectory(
  sourceRoot: string,
  blobs: BlobStore,
  options: ImportOptions = {},
): ImportedTree {
  const entries: TreeEntry[] = [];
  const blobRefs: BlobRef[] = [];
  const exclusions = new Set(options.exclusions ?? []);
  collect(sourceRoot, "", exclusions, blobs, entries, blobRefs);
  const problem = checkTreeManifest(entries);
  if (problem !== null) {
    throw problem;
  }
  return { entries, rootHash: treeRootHash(entries), blobRefs };
}

/** Options for materializing one manifest. */
export interface MaterializeOptions {
  /** Write files and directories without write permission. */
  readOnly?: boolean;
}

/**
 * Materialize one manifest into a local directory.
 *
 * Files land under exactly the paths the manifest names: nothing is
 * renamed. A path that already exists, that another entry needs as a
 * directory, or that cannot be represented on the target filesystem
 * fails with an explicit error before that file is written. Two paths
 * that differ only by Unicode normalization collide, because the
 * target filesystem cannot be assumed to keep them apart.
 *
 * With `readOnly`, every written file and directory lands without
 * write permission: the result is a snapshot, advisory on platforms
 * that let the owner override permissions.
 */
export function materializeTree(
  entries: readonly TreeEntry[],
  destination: string,
  readBlob: (digest: Sha256Hex) => Uint8Array | null,
  options: MaterializeOptions = {},
): void {
  const problem = checkTreeManifest(entries);
  if (problem !== null) {
    throw problem;
  }
  rejectNormalizationCollisions(entries);
  mkdirSync(destination, { recursive: true });
  const sorted = [...entries].sort((a, b) => compareTreePaths(a.path, b.path));
  for (const entry of sorted) {
    materializeEntry(entry, destination, readBlob);
  }
  if (options.readOnly === true) {
    // Restrict permissions only after every entry exists: a directory
    // locked before its children are written refuses them.
    for (const entry of sorted) {
      chmodSync(join(destination, entry.path), fileMode(entry, true));
    }
  }
}

/** The permission bits one entry takes. */
function fileMode(entry: TreeEntry, readOnly: boolean): number {
  if (entry.kind === "directory") {
    return readOnly ? 0o555 : 0o755;
  }
  return readOnly ? (entry.executable ? 0o555 : 0o444) : entry.executable ? 0o755 : 0o644;
}

// -- Internals ----------------------------------------------------------------

/** Walk one source directory, collecting entries and storing blobs. */
function collect(
  root: string,
  relative: string,
  exclusions: ReadonlySet<string>,
  blobs: BlobStore,
  entries: TreeEntry[],
  blobRefs: BlobRef[],
): void {
  for (const dirent of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative === "" ? dirent.name : `${relative}/${dirent.name}`;
    if (exclusions.has(path)) {
      continue;
    }
    if (dirent.isSymbolicLink()) {
      throw unsupportedOperationError("workspace.tree@1", "import-link", {
        path,
        entryType: "symbolic-link",
        detail: "Version one rejects symbolic links; it never dereferences them.",
      });
    }
    if (dirent.isDirectory()) {
      entries.push({ path, kind: "directory", executable: false, contentHash: null });
      collect(root, path, exclusions, blobs, entries, blobRefs);
      continue;
    }
    if (!dirent.isFile()) {
      throw unsupportedOperationError("workspace.tree@1", "import-special-file", {
        path,
        entryType: specialTypeOf(dirent),
        detail: "Version one rejects device files, sockets, and FIFOs.",
      });
    }
    const absolute = join(root, path);
    const stored = blobs.put(readFileSync(absolute));
    blobRefs.push({ digest: stored.digest, sizeBytes: stored.sizeBytes });
    entries.push({
      path,
      kind: "file",
      executable: (statSync(absolute).mode & 0o111) !== 0,
      contentHash: stored.digest,
    });
  }
}

/** Name one non-file, non-directory entry type. */
function specialTypeOf(dirent: { isBlockDevice(): boolean; isCharacterDevice(): boolean; isFIFO(): boolean }): string {
  if (dirent.isBlockDevice()) {
    return "block-device";
  }
  if (dirent.isCharacterDevice()) {
    return "character-device";
  }
  if (dirent.isFIFO()) {
    return "fifo";
  }
  return "socket";
}

/** Reject paths that collide under Unicode normalization. */
function rejectNormalizationCollisions(entries: readonly TreeEntry[]): void {
  const byNormalized = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.path.normalize("NFC");
    const first = byNormalized.get(key);
    if (first !== undefined && first !== entry.path) {
      throw invalidRequestError(
        `Paths ${first} and ${entry.path} collide under Unicode normalization.`,
        { path: entry.path, collidesWith: first, reason: "normalized-collision" },
      );
    }
    byNormalized.set(key, entry.path);
  }
}

/** Materialize one entry, mapping filesystem limits to explicit errors. */
function materializeEntry(
  entry: TreeEntry,
  destination: string,
  readBlob: (digest: Sha256Hex) => Uint8Array | null,
): void {
  const target = join(destination, entry.path);
  try {
    if (entry.kind === "directory") {
      if (existsSync(target) && !statSync(target).isDirectory()) {
        throw collision(entry.path, "a non-directory already occupies it");
      }
      mkdirSync(target, { recursive: true });
      chmodSync(target, 0o755);
      return;
    }
    if (existsSync(target)) {
      throw collision(entry.path, "a file already occupies it");
    }
    const hash = entry.contentHash;
    if (hash === null) {
      throw invalidRequestError(`File entry ${entry.path} has no content hash.`, {
        path: entry.path,
        reason: "missing-content-hash",
      });
    }
    const data = readBlob(hash);
    if (data === null) {
      throw integrityFailureError(`blob ${hash}`, hash, "absent");
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    // Chmod after the write: the mode option of a create is masked by
    // the process umask, and materialization states exact permissions.
    chmodSync(target, fileMode(entry, false));
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "ENAMETOOLONG" || code === "EINVAL") {
      throw invalidRequestError(
        `The path ${entry.path} cannot be represented on this filesystem.`,
        { path: entry.path, reason: "unrepresentable-name", systemCode: code },
      );
    }
    throw error;
  }
}

/** The collision error for one materialization path. */
function collision(path: string, detail: string): PortableError {
  return invalidRequestError(`The target path ${path} collides: ${detail}.`, {
    path,
    reason: "target-collision",
  });
}

/** The `code` property of a Node filesystem error, when present. */
function fsErrorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}
