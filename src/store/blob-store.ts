import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  integrityFailureError,
  invalidRequestError,
  staleHandleError,
} from "../core/errors.js";
import type { PolicyAuthority } from "../core/policy.js";
import { checkRawTransfer, checkRetrievalLocation } from "../core/secrets.js";
import type { Sha256Hex } from "../schema/defs.js";
import type { WorkspaceRevision } from "../schema/workspace.js";
import { StoreError } from "./control-store.js";
import type { ControlStore } from "./control-store.js";

/**
 * Content-addressed blob storage (SPEC.md sections 11.2 and 11.6).
 *
 * Blob bytes live on the filesystem, keyed by their SHA-256 digest. The
 * control store's registry tracks which digests are durably present and
 * integrity-checked; a revision may reference only verified blobs. Every
 * write lands through a temporary file and an atomic rename, so an
 * interrupted write never becomes a readable blob, and a repeated write
 * of the same content shares one digest and one file.
 *
 * Publication re-validates the bytes behind every referenced digest
 * before the revision commits: a blob that is missing, truncated, or
 * corrupt on disk cannot be published, whatever the registry says.
 * Transfers validate destination policy before any byte is produced,
 * and retrieval locations that carry credential-shaped material are
 * rejected before they are used.
 */

/** Limits an importer enforces before publishing a revision. */
export interface BlobLimits {
  /** Maximum number of files one publication may reference. */
  maxFileCount?: number;
  /** Maximum size of one blob in bytes. */
  maxFileBytes?: number;
  /** Maximum combined size of one publication's blobs in bytes. */
  maxTotalBytes?: number;
}

/** The outcome of one stored blob. */
export interface BlobPutResult {
  digest: Sha256Hex;
  sizeBytes: number;
}

/** One blob a publication references. */
export interface BlobRef {
  digest: Sha256Hex;
  sizeBytes: number;
}

/**
 * Durable, content-addressed blob storage over one directory tree.
 *
 * Layout: `<root>/objects/<first two hex>/<digest>`. Temporary files
 * are written beside the objects and renamed into place, so a crash
 * leaves at most an unreferenced temporary file, never a half-written
 * blob under its final name.
 */
export class BlobStore {
  private readonly root: string;
  private readonly store: ControlStore;
  private readonly limits: BlobLimits;

  constructor(root: string, store: ControlStore, limits: BlobLimits = {}) {
    this.root = root;
    this.store = store;
    this.limits = limits;
    mkdirSync(join(root, "objects"), { recursive: true });
  }

  /** Open a blob store beside a control store file, for convenience. */
  static beside(controlStorePath: string, store: ControlStore, limits?: BlobLimits): BlobStore {
    const separator = controlStorePath.lastIndexOf(".");
    const base =
      separator > 0 ? controlStorePath.slice(0, separator) : controlStorePath;
    return new BlobStore(`${base}-blobs`, store, limits);
  }

  /**
   * Store one blob.
   *
   * The content is hashed, written through a temporary file, read back
   * and re-hashed, and only then registered as verified. Duplicate
   * content returns the same digest without rewriting anything.
   */
  put(data: Uint8Array): BlobPutResult {
    this.checkLimit("maxFileBytes", data.byteLength);
    const digest = digestOf(data);
    const sizeBytes = data.byteLength;
    if (this.verifiedOnDisk(digest, sizeBytes)) {
      return { digest, sizeBytes };
    }
    const target = this.objectPath(digest);
    const holding = join(this.root, "objects", digest.slice(0, 2));
    mkdirSync(holding, { recursive: true });
    const staged = join(holding, `tmp-${randomUUID()}`);
    try {
      writeFileSync(staged, data);
      // Read the staged bytes back and hash them: only proven content
      // moves under its final name.
      const actual = digestOf(readFileSync(staged));
      if (actual !== digest) {
        throw integrityFailureError(`blob ${digest}`, digest, actual);
      }
      renameSync(staged, target);
    } catch (error) {
      rmSync(staged, { force: true });
      throw error;
    }
    this.store.registerBlob(digest, sizeBytes);
    this.store.markBlobVerified(digest);
    return { digest, sizeBytes };
  }

  /**
   * Fetch and store one blob through a checked retrieval location.
   *
   * The location is screened for credential-shaped material before the
   * fetcher runs; the fetched bytes then pass the same write-and-verify
   * path as `put`.
   */
  putFromRetrieval(location: string, fetchBytes: (location: string) => Uint8Array): BlobPutResult {
    const problem = checkRetrievalLocation(location);
    if (problem !== null) {
      throw problem;
    }
    return this.put(fetchBytes(location));
  }

  /**
   * Read one stored blob.
   *
   * Returns null when the digest is unknown here. A blob whose bytes no
   * longer hash to its digest throws `IntegrityFailure`: corruption is
   * reported, never returned as data.
   */
  get(digest: Sha256Hex): Uint8Array | null {
    const path = this.objectPath(digest);
    if (!existsSync(path)) {
      return null;
    }
    const data = readFileSync(path);
    const actual = digestOf(data);
    if (actual !== digest) {
      throw integrityFailureError(`blob ${digest}`, digest, actual);
    }
    return data;
  }

  /** Whether a digest is present and hashes to itself. */
  verify(digest: Sha256Hex): boolean {
    return this.get(digest) !== null;
  }

  /**
   * Produce the bytes of one blob for transfer.
   *
   * Destination policy is checked before anything is read, so an
   * unauthorized transfer never touches blob content.
   */
  transferOut(digest: Sha256Hex, destination: "local" | "remote", authority: PolicyAuthority): Uint8Array {
    const problem = checkRawTransfer(authority, destination);
    if (problem !== null) {
      throw problem;
    }
    const data = this.get(digest);
    if (data === null) {
      throw staleHandleError({ kind: "blob", value: digest }, { kind: "blob", value: null });
    }
    return data;
  }

  /**
   * Publish one revision over validated blobs (SPEC.md sections 11.2
   * and 11.6).
   *
   * Count, individual size, and total size limits are enforced first.
   * Every referenced blob is then read and re-hashed: a missing,
   * truncated, or corrupt blob fails the publication. Only then does
   * the revision commit in the control store.
   */
  publishRevision(revision: WorkspaceRevision, blobs: readonly BlobRef[]): void {
    this.checkPublicationLimits(blobs);
    for (const blob of blobs) {
      const path = this.objectPath(blob.digest);
      if (!existsSync(path)) {
        throw integrityFailureError(`blob ${blob.digest}`, blob.digest, "absent");
      }
      const size = statSync(path).size;
      if (size !== blob.sizeBytes) {
        throw integrityFailureError(`blob ${blob.digest}`, `${blob.sizeBytes} bytes`, `${size} bytes`);
      }
      const data = readFileSync(path);
      const actual = digestOf(data);
      if (actual !== blob.digest) {
        throw integrityFailureError(`blob ${blob.digest}`, blob.digest, actual);
      }
    }
    try {
      this.store.insertRevision(revision, blobs.map((blob) => blob.digest));
    } catch (error) {
      if (error instanceof StoreError) {
        throw error.toPortableError();
      }
      throw error;
    }
  }

  /**
   * Drop staging leftovers of interrupted writes.
   *
   * Only `tmp-` files inside the object tree are removed. A resumed
   * `put` of the same content succeeds regardless: staging never
   * occupies a digest name.
   */
  sweepStaging(): number {
    const objects = join(this.root, "objects");
    let removed = 0;
    for (const entry of readdirSync(objects, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      for (const file of readdirSync(join(objects, entry.name))) {
        if (file.startsWith("tmp-")) {
          rmSync(join(objects, entry.name, file), { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  // -- Internals ---------------------------------------------------------------

  private objectPath(digest: Sha256Hex): string {
    return join(this.root, "objects", digest.slice(0, 2), digest);
  }

  /** Whether a verified, correctly sized object already exists. */
  private verifiedOnDisk(digest: Sha256Hex, sizeBytes: number): boolean {
    if (!this.store.isBlobVerified(digest)) {
      return false;
    }
    const path = this.objectPath(digest);
    if (!existsSync(path) || statSync(path).size !== sizeBytes) {
      return false;
    }
    return digestOf(readFileSync(path)) === digest;
  }

  /** Enforce one limit against a measured value. */
  private checkLimit(name: keyof BlobLimits, value: number): void {
    const limit = this.limits[name];
    if (limit !== undefined && value > limit) {
      throw invalidRequestError(
        `The blob exceeds the ${name} limit of ${limit}.`,
        { limit, actual: value, limitName: name },
      );
    }
  }

  /** Enforce the publication limits of SPEC.md section 11.6. */
  private checkPublicationLimits(blobs: readonly BlobRef[]): void {
    this.checkLimit("maxFileCount", blobs.length);
    const total = blobs.reduce((sum, blob) => sum + blob.sizeBytes, 0);
    this.checkLimit("maxTotalBytes", total);
    for (const blob of blobs) {
      this.checkLimit("maxFileBytes", blob.sizeBytes);
    }
  }
}

/** SHA-256 digest of one byte string. */
function digestOf(data: Uint8Array): Sha256Hex {
  return createHash("sha256").update(data).digest("hex") as Sha256Hex;
}
