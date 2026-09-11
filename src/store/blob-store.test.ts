import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "./control-store.js";
import { BlobStore } from "./blob-store.js";
import type { BlobRef } from "./blob-store.js";
import { PolicyAuthority } from "../core/policy.js";
import type { WorkspaceRevision } from "../schema/workspace.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the Portable error a call throws, or null when it does not. */
async function thrownBy(call: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return null;
}

const LOCAL_AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["local"],
});

function revision(n: number, rootHash: string): WorkspaceRevision {
  return {
    id: `rev-${n}`,
    workspaceId: "ws-test",
    rootHash: rootHash as WorkspaceRevision["rootHash"],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/** Compare blob bytes without Buffer's distinct prototype. */
function readAs(blobs: BlobStore, digest: string): Uint8Array | null {
  const data = blobs.get(digest as Parameters<typeof blobs.get>[0]);
  return data === null ? null : new Uint8Array(data);
}

/** One blob store over a fresh directory and an in-memory control store. */
function fixture(limits?: ConstructorParameters<typeof BlobStore>[2]): {
  blobs: BlobStore;
  store: ControlStore;
  root: string;
  done: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "porta-blobs-"));
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(root, store, limits);
  return { blobs, store, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("binary data round-trips and duplicate content shares one digest", () => {
  const { blobs, root, done } = fixture();
  try {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const first = blobs.put(bytes);
    assert.equal(first.sizeBytes, 256);
    assert.equal(first.digest, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(readAs(blobs, first.digest), bytes);
    assert.equal(blobs.verify(first.digest), true);

    // The same content stores again over the same tree without a second file.
    const second = blobs.put(Uint8Array.from(bytes));
    assert.equal(second.digest, first.digest);
    const holding = join(root, "objects", first.digest.slice(0, 2));
    assert.deepEqual(readdirSync(holding), [first.digest]);

    // A fresh store over the same tree reads the same bytes back.
    const reopened = new BlobStore(root, ControlStore.inMemory());
    assert.deepEqual(readAs(reopened, first.digest), bytes);

    // Unknown digests read as null, not as an error.
    assert.equal(blobs.get("ab".repeat(32) as typeof first.digest), null);
  } finally {
    done();
  }
});

test("corrupt or missing blobs cannot be published in revisions", async () => {
  const { blobs, store, root, done } = fixture();
  try {
    const bytes = new TextEncoder().encode("artifact bytes");
    const { digest } = blobs.put(bytes);
    const ref: BlobRef = { digest, sizeBytes: bytes.byteLength };
    const objectPath = join(root, "objects", digest.slice(0, 2), digest);

    // A corrupted object fails reads and publication alike.
    appendFileSync(objectPath, "tampered");
    const corruptGet = await thrownBy(() => blobs.get(digest));
    assert.ok(isPortableCode(corruptGet) && corruptGet.code === "IntegrityFailure");
    const corruptPublish = await thrownBy(() => blobs.publishRevision(revision(1, digest), [ref]));
    assert.ok(isPortableCode(corruptPublish) && corruptPublish.code === "IntegrityFailure");
    assert.equal(store.getRevision("rev-1"), null);

    // A registry entry without bytes on disk publishes nothing either.
    writeFileSync(objectPath, bytes);
    rmSync(objectPath);
    store.markBlobVerified(digest);
    const absentPublish = await thrownBy(() => blobs.publishRevision(revision(2, digest), [ref]));
    assert.ok(isPortableCode(absentPublish) && absentPublish.code === "IntegrityFailure");
    assert.equal(store.getRevision("rev-2"), null);

    // A truncated object with a stale size claim also refuses.
    writeFileSync(objectPath, bytes.subarray(0, 4));
    const shortPublish = await thrownBy(() => blobs.publishRevision(revision(3, digest), [ref]));
    assert.ok(isPortableCode(shortPublish) && shortPublish.code === "IntegrityFailure");
    assert.equal(store.getRevision("rev-3"), null);
    assert.equal(store.getWorkspaceHead("ws-test"), null);

    // Restored bytes publish and the revision commits; moving the head
    // is a separate compare-and-set on the workspace.
    writeFileSync(objectPath, bytes);
    blobs.publishRevision(revision(4, digest), [ref]);
    assert.equal(store.getRevision("rev-4")?.rootHash, digest);
    assert.ok(store.casWorkspaceHead("ws-test", null, "rev-4"));
    assert.equal(store.getWorkspaceHead("ws-test"), "rev-4");
  } finally {
    done();
  }
});

test("transfer policy is checked before any byte is produced", async () => {
  const { blobs, root, done } = fixture();
  try {
    const bytes = new TextEncoder().encode("secret-adjacent payload");
    const { digest } = blobs.put(bytes);
    const closed = PolicyAuthority.fromPolicy({ schemaVersion: 1 });

    // A denied destination refuses even for a digest that does not exist:
    // the check runs before the store is read.
    const denied = await thrownBy(() =>
      blobs.transferOut("cd".repeat(32) as typeof digest, "local", closed),
    );
    assert.ok(isPortableCode(denied) && denied.code === "PolicyDenied");

    const remoteDenied = await thrownBy(() =>
      blobs.transferOut(digest, "remote", LOCAL_AUTHORITY),
    );
    assert.ok(isPortableCode(remoteDenied) && remoteDenied.code === "PolicyDenied");

    assert.deepEqual(new Uint8Array(blobs.transferOut(digest, "local", LOCAL_AUTHORITY)), bytes);

    // An allowed transfer of an absent digest is a stale handle, not data.
    const stale = await thrownBy(() =>
      blobs.transferOut("ef".repeat(32) as typeof digest, "local", LOCAL_AUTHORITY),
    );
    assert.ok(isPortableCode(stale) && stale.code === "StaleHandle");
  } finally {
    done();
  }
});

test("retrieval locations carrying credentials are refused before fetch", async () => {
  const { blobs, done } = fixture();
  try {
    let fetched = 0;
    const fetchBytes = (): Uint8Array => {
      fetched += 1;
      return new TextEncoder().encode("fetched");
    };

    const denied = await thrownBy(() =>
      blobs.putFromRetrieval("https://objects.example/file.txt?token=abc123", fetchBytes),
    );
    assert.ok(isPortableCode(denied) && denied.code === "InvalidRequest");
    assert.equal(fetched, 0, "the fetcher never runs for a refused location");

    const clean = blobs.putFromRetrieval("https://objects.example/file.txt", (location) => {
      assert.equal(location, "https://objects.example/file.txt");
      return new TextEncoder().encode("fetched");
    });
    assert.deepEqual(readAs(blobs, clean.digest), new TextEncoder().encode("fetched"));
  } finally {
    done();
  }
});

test("size and count limits refuse before a revision commits", async () => {
  const small = new TextEncoder().encode("small");
  const large = new TextEncoder().encode("deliberately larger payload");

  const capped = fixture({ maxFileBytes: 16 });
  try {
    const refused = await thrownBy(() => capped.blobs.put(large));
    assert.ok(isPortableCode(refused) && refused.code === "InvalidRequest");
    assert.ok(JSON.stringify(refused?.details).includes("maxFileBytes"));
    assert.ok(capped.blobs.put(small).sizeBytes > 0);
  } finally {
    capped.done();
  }

  const counted = fixture({ maxFileCount: 1, maxTotalBytes: 5 });
  try {
    const first = counted.blobs.put(small);
    const second = counted.blobs.put(new TextEncoder().encode("bytes two"));
    const tooMany = await thrownBy(() =>
      counted.blobs.publishRevision(revision(1, first.digest), [
        { digest: first.digest, sizeBytes: first.sizeBytes },
        { digest: second.digest, sizeBytes: second.sizeBytes },
      ]),
    );
    assert.ok(isPortableCode(tooMany) && tooMany.code === "InvalidRequest");
    assert.ok(JSON.stringify(tooMany?.details).includes("maxFileCount"));

    const tooHeavy = await thrownBy(() =>
      counted.blobs.publishRevision(revision(2, second.digest), [
        { digest: second.digest, sizeBytes: second.sizeBytes },
      ]),
    );
    assert.ok(isPortableCode(tooHeavy) && tooHeavy.code === "InvalidRequest");
    assert.ok(JSON.stringify(tooHeavy?.details).includes("maxTotalBytes"));
    assert.equal(counted.store.getRevision("rev-1"), null);
    assert.equal(counted.store.getRevision("rev-2"), null);

    counted.blobs.publishRevision(revision(3, first.digest), [
      { digest: first.digest, sizeBytes: first.sizeBytes },
    ]);
    assert.equal(counted.store.getRevision("rev-3")?.rootHash, first.digest);
  } finally {
    counted.done();
  }
});

test("staging leftovers sweep away without touching objects", () => {
  const { blobs, root, done } = fixture();
  try {
    const bytes = new TextEncoder().encode("survivor");
    const { digest } = blobs.put(bytes);
    const holding = join(root, "objects", digest.slice(0, 2));
    writeFileSync(join(holding, "tmp-interrupted"), "partial");

    // Staging never occupies a digest name, so reads stay clean.
    assert.deepEqual(readAs(blobs, digest), bytes);
    assert.equal(blobs.sweepStaging(), 1);
    assert.deepEqual(readdirSync(holding), [digest]);
    assert.deepEqual(new Uint8Array(readFileSync(join(holding, digest))), bytes);

    // A re-put of the same content still succeeds after the sweep.
    assert.deepEqual(blobs.put(bytes).digest, digest);
  } finally {
    done();
  }
});
