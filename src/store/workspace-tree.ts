import { createHash } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
 * dereferencing them. Materialization refuses symbolic links in the
 * destination and its path, rejects colliding and unrepresentable
 * names, and renames nothing.
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
  collect(sourceRoot, "", exclusions, (absolute) => {
    const stored = blobs.put(readFileSync(absolute));
    blobRefs.push({ digest: stored.digest, sizeBytes: stored.sizeBytes });
    return stored;
  }, entries);
  const problem = checkTreeManifest(entries);
  if (problem !== null) {
    throw problem;
  }
  return { entries, rootHash: treeRootHash(entries), blobRefs };
}

/** The outcome of hashing one directory without storing anything. */
export interface ScannedTree {
  /** Canonical, sorted manifest entries. */
  entries: TreeEntry[];
  /** Digest of the canonical manifest encoding. */
  rootHash: Sha256Hex;
  /** Combined size of the scanned files in bytes. */
  totalBytes: number;
}

/**
 * Hash one local directory into a manifest, writing nothing.
 *
 * The scanner serves export validation: it computes the tree a
 * directory holds right now, so the caller can compare it with a
 * recorded base before changing anything. It applies the same entry
 * rules as an import, including the rejection of symbolic links and
 * special files.
 */
export function scanTreeFromDirectory(
  sourceRoot: string,
  options: ImportOptions = {},
): ScannedTree {
  const entries: TreeEntry[] = [];
  let totalBytes = 0;
  const exclusions = new Set(options.exclusions ?? []);
  collect(sourceRoot, "", exclusions, (absolute) => {
    const data = readFileSync(absolute);
    totalBytes += data.byteLength;
    return {
      digest: createHash("sha256").update(data).digest("hex") as Sha256Hex,
      sizeBytes: data.byteLength,
    };
  }, entries);
  const problem = checkTreeManifest(entries);
  if (problem !== null) {
    throw problem;
  }
  return { entries, rootHash: treeRootHash(entries), totalBytes };
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
 * Destination contract: every component of the destination path that
 * already exists must be a real directory, never a symbolic link, and
 * the same rule holds for every directory the manifest creates below
 * it. Files are created exclusively and take their permissions through
 * the open descriptor. These checks stop an accidental redirect of the
 * write through a link, including a link installed while blobs are
 * being read. They do not stop a hostile writer that controls the
 * destination's parent directory and races the checks: the caller must
 * own the parent exclusively.
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
  checkDestinationChain(destination);
  mkdirSync(destination, { recursive: true });
  const root = lstatOrNull(destination);
  if (root === null) {
    throw destinationChanged(destination);
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw linkTraversal(destination, "the destination itself is not a real directory");
  }
  const sorted = [...entries].sort((a, b) => compareTreePaths(a.path, b.path));
  for (const entry of sorted) {
    materializeEntry(entry, destination, readBlob);
  }
  if (options.readOnly === true) {
    // Restrict permissions only after every entry exists: a directory
    // locked before its children are written refuses them.
    for (const entry of sorted) {
      const target = join(destination, entry.path);
      const current = lstatOrNull(target);
      if (
        current === null ||
        current.isSymbolicLink() ||
        (entry.kind === "directory") !== current.isDirectory()
      ) {
        throw destinationChanged(entry.path);
      }
      chmodThroughDescriptor(target, fileMode(entry, true));
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

/** Hash one file into its digest and size, storing it or not. */
type FileHasher = (absolute: string) => { digest: Sha256Hex; sizeBytes: number };

/** Walk one source directory, collecting entries through one hasher. */
function collect(
  root: string,
  relative: string,
  exclusions: ReadonlySet<string>,
  hashFile: FileHasher,
  entries: TreeEntry[],
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
      collect(root, path, exclusions, hashFile, entries);
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
    const hashed = hashFile(absolute);
    entries.push({
      path,
      kind: "file",
      executable: (statSync(absolute).mode & 0o111) !== 0,
      contentHash: hashed.digest,
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
    const existing = lstatOrNull(target);
    if (entry.kind === "directory") {
      if (existing !== null) {
        if (existing.isSymbolicLink()) {
          throw linkTraversal(entry.path, "a symbolic link already occupies it");
        }
        if (!existing.isDirectory()) {
          throw collision(entry.path, "a non-directory already occupies it");
        }
      } else {
        ensureDirectoryChain(destination, dirname(entry.path));
        mkdirSync(target);
        const created = lstatOrNull(target);
        if (created === null || !created.isDirectory()) {
          throw destinationChanged(entry.path);
        }
      }
      chmodThroughDescriptor(target, 0o755);
      return;
    }
    if (existing !== null) {
      if (existing.isSymbolicLink()) {
        throw linkTraversal(entry.path, "a symbolic link already occupies it");
      }
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
    // The blob callback runs outside this writer's control, so the
    // whole chain is checked again after it: a directory replaced with
    // a link during retrieval cannot redirect the write.
    ensureDirectoryChain(destination, dirname(entry.path));
    // Exclusive create: refuses a symbolic link at the target, a file
    // installed meanwhile, and a dangling link alike.
    const descriptor = openSync(target, "wx");
    try {
      writeAll(descriptor, data);
      // Permissions through the descriptor: the mode of an exclusive
      // create is masked by the process umask, materialization states
      // exact permissions, and a later path swap cannot redirect the
      // chmod.
      fchmodSync(descriptor, fileMode(entry, false));
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "EEXIST") {
      throw collision(entry.path, "an entry already occupies it");
    }
    if (code === "ENAMETOOLONG" || code === "EINVAL") {
      throw invalidRequestError(
        `The path ${entry.path} cannot be represented on this filesystem.`,
        { path: entry.path, reason: "unrepresentable-name", systemCode: code },
      );
    }
    throw error;
  }
}

/**
 * Check every existing component of the destination path (SPEC.md 11.3).
 *
 * Each existing component must be a real directory; a symbolic link
 * anywhere on the way refuses the whole write before anything is read.
 */
function checkDestinationChain(destination: string): void {
  const absolute = resolve(destination);
  const parts = absolute.split(sep).filter((part) => part.length > 0);
  let prefix = absolute.startsWith(sep) ? sep : parts.shift() ?? absolute;
  for (const part of parts) {
    prefix = join(prefix, part);
    const state = lstatOrNull(prefix);
    if (state === null) {
      // Nothing can exist below a missing component; the writer
      // creates the rest itself.
      return;
    }
    if (state.isSymbolicLink()) {
      throw linkTraversal(prefix, "an existing component of the destination is a symbolic link");
    }
    if (!state.isDirectory()) {
      throw invalidRequestError(
        `The destination ${destination} passes through the non-directory ${prefix}.`,
        { destination, component: prefix, reason: "destination-blocked" },
      );
    }
  }
}

/**
 * Validate the manifest directory chain below the destination, creating
 * missing directories. Called after any callback the writer does not
 * control, so a link installed while a blob was read is caught here.
 */
function ensureDirectoryChain(destination: string, relative: string): void {
  const root = lstatOrNull(destination);
  if (root === null) {
    throw destinationChanged(destination);
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw linkTraversal(destination, "the destination itself is not a real directory");
  }
  if (relative === "" || relative === ".") {
    return;
  }
  let current = destination;
  let relativeSoFar = "";
  for (const part of relative.split("/")) {
    current = join(current, part);
    relativeSoFar = relativeSoFar === "" ? part : `${relativeSoFar}/${part}`;
    let state = lstatOrNull(current);
    if (state === null) {
      mkdirSync(current);
      state = lstatOrNull(current);
      if (state === null) {
        throw destinationChanged(relativeSoFar);
      }
    }
    if (state.isSymbolicLink()) {
      throw linkTraversal(relativeSoFar, "a symbolic link occupies a directory of the manifest");
    }
    if (!state.isDirectory()) {
      throw collision(relativeSoFar, "a non-directory already occupies it");
    }
  }
}

/** The structured link-traversal refusal of one materialization path. */
function linkTraversal(path: string, detail: string): PortableError {
  return unsupportedOperationError("workspace.tree@1", "materialize-link", {
    path,
    reason: "destination-link",
    detail,
  });
}

/** The structured refusal for a path that changed under the writer. */
function destinationChanged(path: string): PortableError {
  return invalidRequestError(
    `The materialization path ${path} changed while the writer was working.`,
    { path, reason: "destination-changed" },
  );
}

/** The `lstat` of one path, or null when nothing is there. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Apply permissions through one open descriptor, never a path. */
function chmodThroughDescriptor(path: string, mode: number): void {
  const descriptor = openSync(path, "r");
  try {
    fchmodSync(descriptor, mode);
  } finally {
    closeSync(descriptor);
  }
}

/** Write one buffer fully through one descriptor. */
function writeAll(descriptor: number, data: Uint8Array): void {
  let written = 0;
  while (written < data.byteLength) {
    written += writeSync(descriptor, data, written);
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
