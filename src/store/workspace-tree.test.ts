import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  lstatSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "./control-store.js";
import { BlobStore } from "./blob-store.js";
import {
  buildTreeFromDirectory,
  canonicalTreeJson,
  checkTreeManifest,
  compareTreePaths,
  materializeTree,
  treeRootHash,
  validateWorkspacePath,
} from "./workspace-tree.js";
import type { TreeEntry } from "./workspace-tree.js";
import type { Sha256Hex } from "../schema/defs.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return null;
}

const HELLO_HASH: Sha256Hex =
  "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";

/** One blob store over a fresh directory and an in-memory control store. */
function fixture(): { blobs: InstanceType<typeof BlobStore>; root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "porta-tree-"));
  const blobs = new BlobStore(root, ControlStore.inMemory());
  return { blobs, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fresh empty directory outside the blob tree. */
function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "porta-scratch-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("digest vectors match the canonical encoding", () => {
  // The expected digests were computed by an independent
  // implementation (Python hashlib) over the canonical form.
  const vectorOne: TreeEntry[] = [
    { path: "a.txt", kind: "file", executable: false, contentHash: HELLO_HASH },
  ];
  assert.equal(
    canonicalTreeJson(vectorOne),
    `[{"path":"a.txt","kind":"file","executable":false,"contentHash":"${HELLO_HASH}"}]`,
  );
  assert.equal(
    treeRootHash(vectorOne),
    "773b7dfae50579ce364b403ae398bd30b1ae42f28d226468f8e448966f0adb70",
  );

  // Unicode sequences keep their original characters; executable bits
  // and directories take their fixed shapes.
  const blobFixture = fixture();
  const olaBytes = new TextEncoder().encode("olá, mundo — déjà\n");
  const ola = blobFixture.blobs.put(olaBytes).digest;
  const vectorTwo: TreeEntry[] = [
    { path: "café", kind: "directory", executable: false, contentHash: null },
    { path: "café/naïve.txt", kind: "file", executable: true, contentHash: ola },
  ];
  assert.equal(
    treeRootHash(vectorTwo),
    "f856fbe6195cf57f362bca6d6423e2a97d4abfd45f8ac571873d50f1cbf46a33",
  );

  // Binary content with every byte value round-trips into the manifest.
  const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
  const allBytes = blobFixture.blobs.put(binary).digest;
  const vectorThree: TreeEntry[] = [
    { path: "bin", kind: "directory", executable: false, contentHash: null },
    { path: "bin/all-bytes.bin", kind: "file", executable: false, contentHash: allBytes },
  ];
  assert.equal(
    treeRootHash(vectorThree),
    "e2d70a609ecc255366e4bf85a99b07353b1787bc83496ac1c4b0aee10e47fe5c",
  );

  // The empty tree hashes the empty array encoding.
  assert.equal(
    treeRootHash([]),
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  );
  blobFixture.done();
});

test("manifests sort by UTF-8 path bytes, and the hash ignores input order", () => {
  const paths = ["😀.bin", "z.txt", "a/b", "café.txt", "A.txt", "ab"];
  const sorted = [...paths].sort(compareTreePaths);
  // Byte order: "A" (0x41) < "a/" (0x61 0x2F) < "ab" (0x61 0x62) < "c"
  // (0x63) < "z" (0x7A) < "é" (0xC3 0xA9) < emoji (0xF0 ...).
  assert.deepEqual(sorted, ["A.txt", "a/b", "ab", "café.txt", "z.txt", "😀.bin"]);

  const hashes = paths.map((path) =>
    treeRootHash([{ path, kind: "file", executable: false, contentHash: HELLO_HASH }]),
  );
  const entries: TreeEntry[] = paths.map((path) => ({
    path,
    kind: "file",
    executable: false,
    contentHash: HELLO_HASH,
  }));
  // One combined manifest with entries in any input order still hashes
  // the sorted form.
  const forward = treeRootHash(entries);
  const reversed = treeRootHash([...entries].reverse());
  assert.equal(forward, reversed);
  assert.notEqual(forward, hashes[0]);
});

test("path validation rejects the forbidden forms", () => {
  const invalid = [
    "",
    "/etc/passwd",
    "a/../b",
    "a/./b",
    "a//b",
    "a/",
    "./a",
    "..",
    ".",
    "a\\b",
    "a\0b",
    "\uD800surrogate",
    "x\uD800y",
  ];
  for (const path of invalid) {
    const problem = validateWorkspacePath(path);
    assert.ok(isPortableCode(problem) && problem.code === "InvalidRequest", `rejects ${JSON.stringify(path)}`);
    const reason = (problem.details as { reason?: unknown } | undefined)?.reason;
    assert.equal(typeof reason, "string");
  }

  const valid = ["a", "café/naïve.txt", "dir/sub/f.bin", "😀.txt", "a/b/c/d/e.txt"];
  for (const path of valid) {
    assert.equal(validateWorkspacePath(path), null, `accepts ${path}`);
  }
});

test("manifest validation rejects duplicates, wrong metadata, and kind conflicts", () => {
  const file = (path: string): TreeEntry => ({
    path,
    kind: "file",
    executable: false,
    contentHash: HELLO_HASH,
  });

  const duplicate = thrownBy(() =>
    canonicalTreeJson([file("a.txt"), file("a.txt")]),
  );
  assert.ok(isPortableCode(duplicate) && duplicate.code === "InvalidRequest");

  const dirWithHash = checkTreeManifest([
    { path: "d", kind: "directory", executable: false, contentHash: HELLO_HASH },
  ]);
  assert.ok(isPortableCode(dirWithHash) && dirWithHash.code === "InvalidRequest");

  const dirExecutable = checkTreeManifest([
    { path: "d", kind: "directory", executable: true, contentHash: null },
  ]);
  assert.ok(isPortableCode(dirExecutable) && dirExecutable.code === "InvalidRequest");

  const fileWithoutHash = checkTreeManifest([
    { path: "a", kind: "file", executable: false, contentHash: null },
  ]);
  assert.ok(isPortableCode(fileWithoutHash) && fileWithoutHash.code === "InvalidRequest");

  const kindConflict = checkTreeManifest([file("a"), file("a/b")]);
  assert.ok(isPortableCode(kindConflict) && kindConflict.code === "InvalidRequest");

  assert.equal(checkTreeManifest([file("a.txt"), { path: "d", kind: "directory", executable: false, contentHash: null }]), null);
});

test("import stores blobs, records executable bits, and keeps directory shape", () => {
  const { blobs, done } = fixture();
  const source = scratch();
  try {
    const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
    mkdirSync(join(source.dir, "bin"));
    writeFileSync(join(source.dir, "readme.txt"), "hello\n");
    writeFileSync(join(source.dir, "bin", "all-bytes.bin"), binary);
    chmodSync(join(source.dir, "bin", "all-bytes.bin"), 0o755);
    mkdirSync(join(source.dir, "bin", "nested"));

    const imported = buildTreeFromDirectory(source.dir, blobs);
    const byPath = new Map(imported.entries.map((entry) => [entry.path, entry]));
    assert.deepEqual(
      imported.entries.map((entry) => entry.path),
      ["bin", "bin/all-bytes.bin", "bin/nested", "readme.txt"],
    );
    const readme = byPath.get("readme.txt")!;
    assert.equal(readme.kind, "file");
    assert.equal(readme.executable, false);
    assert.equal(readme.contentHash, HELLO_HASH);
    const allBytes = byPath.get("bin/all-bytes.bin")!;
    assert.equal(allBytes.executable, true);
    assert.deepEqual(new Uint8Array(blobs.get(allBytes.contentHash!)!), binary);
    const nested = byPath.get("bin/nested")!;
    assert.equal(nested.kind, "directory");
    assert.equal(nested.executable, false);
    assert.equal(nested.contentHash, null);
    assert.equal(imported.rootHash, treeRootHash(imported.entries));
    assert.equal(imported.blobRefs.length, 2);

    // Importing the same directory again yields the identical manifest.
    const again = buildTreeFromDirectory(source.dir, blobs);
    assert.equal(again.rootHash, imported.rootHash);
  } finally {
    done();
    source.done();
  }
});

test("import rejects symbolic links and special files explicitly", () => {
  const { blobs, done } = fixture();
  const source = scratch();
  try {
    writeFileSync(join(source.dir, "real.txt"), "data");
    symlinkSync("real.txt", join(source.dir, "link.txt"));
    const link = thrownBy(() => buildTreeFromDirectory(source.dir, blobs));
    assert.ok(isPortableCode(link) && link.code === "UnsupportedOperation");
    const linkDetails = (link as { details: { path?: string; entryType?: string } }).details;
    assert.equal(linkDetails.path, "link.txt");
    assert.equal(linkDetails.entryType, "symbolic-link");

    // A directory reached only through a symlinked path is refused too.
    const through = scratch();
    try {
      mkdirSync(join(through.dir, "d"));
      symlinkSync(join(through.dir, "d"), join(source.dir, "dirlink"));
      rmSync(join(source.dir, "link.txt"));
      const nestedLink = thrownBy(() => buildTreeFromDirectory(source.dir, blobs));
      assert.ok(isPortableCode(nestedLink) && nestedLink.code === "UnsupportedOperation");
      rmSync(join(source.dir, "dirlink"));
    } finally {
      through.done();
    }

    // A FIFO is a special file, not content.
    const fifo = spawnSync("mkfifo", [join(source.dir, "pipe")]);
    if (fifo.status !== 0) {
      assert.fail("mkfifo failed; the fixture cannot build a special file");
    }
    const special = thrownBy(() => buildTreeFromDirectory(source.dir, blobs));
    assert.ok(isPortableCode(special) && special.code === "UnsupportedOperation");
    assert.equal((special as { details: { entryType?: string } }).details.entryType, "fifo");
    assert.equal((special as { details: { path?: string } }).details.path, "pipe");
  } finally {
    done();
    source.done();
  }
});

test("exclusions skip named paths entirely", () => {
  const { blobs, done } = fixture();
  const source = scratch();
  try {
    mkdirSync(join(source.dir, "node_modules"));
    writeFileSync(join(source.dir, "app.txt"), "kept");
    writeFileSync(join(source.dir, "node_modules", "dep.txt"), "skipped");
    const imported = buildTreeFromDirectory(source.dir, blobs, {
      exclusions: ["node_modules"],
    });
    assert.deepEqual(
      imported.entries.map((entry) => entry.path),
      ["app.txt"],
    );
    assert.equal(imported.blobRefs.length, 1);
  } finally {
    done();
    source.done();
  }
});

test("materialization writes exact paths and executable bits", () => {
  const { blobs, done } = fixture();
  const target = scratch();
  try {
    const binary = Uint8Array.from({ length: 256 }, (_, i) => 255 - i);
    const hash = blobs.put(binary).digest;
    const entries: TreeEntry[] = [
      { path: "bin", kind: "directory", executable: false, contentHash: null },
      { path: "bin/tool", kind: "file", executable: true, contentHash: hash },
      { path: "bin/data", kind: "file", executable: false, contentHash: hash },
      { path: "café", kind: "directory", executable: false, contentHash: null },
      { path: "café/naïve.txt", kind: "file", executable: false, contentHash: hash },
    ];
    materializeTree(entries, target.dir, (digest) => blobs.get(digest));

    assert.deepEqual(new Uint8Array(readFileSync(join(target.dir, "bin", "tool"))), binary);
    assert.equal(statSync(join(target.dir, "bin", "tool")).mode & 0o111, 0o111);
    assert.equal(statSync(join(target.dir, "bin", "data")).mode & 0o111, 0);
    assert.equal(statSync(join(target.dir, "café", "naïve.txt")).isFile(), true);

    // Materializing again over occupied paths fails and renames nothing.
    const again = thrownBy(() => materializeTree(entries, target.dir, (digest) => blobs.get(digest)));
    assert.ok(isPortableCode(again) && again.code === "InvalidRequest");
    assert.equal(JSON.stringify((again as { details?: { reason?: string } }).details).includes("target-collision"), true);
    assert.deepEqual(readdirSync(target.dir).sort(), ["bin", "café"]);
  } finally {
    done();
    target.done();
  }
});

test("materialization rejects collisions without overwriting or renaming", () => {
  const { blobs, done } = fixture();
  const target = scratch();
  try {
    const hash = blobs.put(new TextEncoder().encode("one")).digest;
    const other = blobs.put(new TextEncoder().encode("two")).digest;

    // An existing file at a target path stays untouched.
    writeFileSync(join(target.dir, "existing.txt"), "precious");
    const occupied = thrownBy(() =>
      materializeTree(
        [{ path: "existing.txt", kind: "file", executable: false, contentHash: hash }],
        target.dir,
        (digest) => blobs.get(digest),
      ),
    );
    assert.ok(isPortableCode(occupied) && occupied.code === "InvalidRequest");
    assert.equal(readFileSync(join(target.dir, "existing.txt"), "utf8"), "precious");

    // A directory entry cannot land on an existing file.
    const onFile = thrownBy(() =>
      materializeTree(
        [{ path: "existing.txt", kind: "directory", executable: false, contentHash: null }],
        target.dir,
        () => null,
      ),
    );
    assert.ok(isPortableCode(onFile) && onFile.code === "InvalidRequest");
    assert.equal(readFileSync(join(target.dir, "existing.txt"), "utf8"), "precious");

    // Distinct paths that differ only by Unicode normalization collide:
    // no second file appears under either spelling.
    const nfc = "café.txt".normalize("NFC");
    const nfd = "café.txt".normalize("NFD");
    assert.notEqual(nfc, nfd);
    const normalized = thrownBy(() =>
      materializeTree(
        [
          { path: nfc, kind: "file", executable: false, contentHash: hash },
          { path: nfd, kind: "file", executable: false, contentHash: other },
        ],
        target.dir,
        (digest) => blobs.get(digest),
      ),
    );
    assert.ok(isPortableCode(normalized) && normalized.code === "InvalidRequest");
    assert.equal(JSON.stringify((normalized as { details?: { reason?: string } }).details).includes("normalized-collision"), true);
    assert.deepEqual(
      readdirSync(target.dir).filter((name) => name.startsWith("caf")),
      [],
      "neither normalization spelling was written",
    );

    // A missing blob is an integrity failure, never empty content.
    const absent = thrownBy(() =>
      materializeTree(
        [{ path: "gone.txt", kind: "file", executable: false, contentHash: "ab".repeat(32) as Sha256Hex }],
        target.dir,
        () => null,
      ),
    );
    assert.ok(isPortableCode(absent) && absent.code === "IntegrityFailure");
    assert.equal(exists(target.dir, "gone.txt"), false);
  } finally {
    done();
    target.done();
  }
});

/** Whether one path exists below a scratch directory. */
function exists(dir: string, relative: string): boolean {
  try {
    statSync(join(dir, relative));
    return true;
  } catch {
    return false;
  }
}

test("materialization refuses symbolic links in the destination and its path", () => {
  const { blobs, done } = fixture();
  const outside = scratch();
  const holder = scratch();
  try {
    const hash = blobs.put(new TextEncoder().encode("data")).digest;
    const linkFailure = (error: unknown): void => {
      assert.ok(
        isPortableCode(error) && error.code === "UnsupportedOperation",
        `expected a link refusal, got ${String(error)}`,
      );
      assert.equal(
        JSON.stringify((error as { details?: { reason?: string } }).details).includes(
          "destination-link",
        ),
        true,
      );
    };
    const fileEntry: TreeEntry = {
      path: "file.txt",
      kind: "file",
      executable: false,
      contentHash: hash,
    };

    // A destination root that is itself a symbolic link is refused.
    symlinkSync(outside.dir, join(holder.dir, "linked-root"));
    linkFailure(
      thrownBy(() => materializeTree([fileEntry], join(holder.dir, "linked-root"), (d) => blobs.get(d))),
    );
    assert.deepEqual(readdirSync(outside.dir), []);

    // A symbolic link on the way to the destination is refused.
    mkdirSync(join(holder.dir, "way"));
    symlinkSync(outside.dir, join(holder.dir, "way", "stop"));
    linkFailure(
      thrownBy(() =>
        materializeTree([fileEntry], join(holder.dir, "way", "stop", "dest"), (d) => blobs.get(d)),
      ),
    );
    assert.deepEqual(readdirSync(outside.dir), []);

    // A manifest directory entry that names a link is refused: the
    // review's reproduction redirects link/file.txt outside otherwise.
    const dest = join(holder.dir, "dest");
    mkdirSync(dest);
    symlinkSync(outside.dir, join(dest, "link"));
    linkFailure(
      thrownBy(() =>
        materializeTree(
          [
            { path: "link", kind: "directory", executable: false, contentHash: null },
            { path: "link/file.txt", kind: "file", executable: false, contentHash: hash },
          ],
          dest,
          (d) => blobs.get(d),
        ),
      ),
    );
    assert.deepEqual(readdirSync(outside.dir), []);

    // A file entry whose only parent is a link is refused too.
    linkFailure(
      thrownBy(() =>
        materializeTree(
          [{ path: "link/only.txt", kind: "file", executable: false, contentHash: hash }],
          dest,
          (d) => blobs.get(d),
        ),
      ),
    );
    assert.deepEqual(readdirSync(outside.dir), []);

    // A dangling symbolic link on a file target never receives content.
    symlinkSync(join(outside.dir, "gone"), join(dest, "file.txt"));
    linkFailure(thrownBy(() => materializeTree([fileEntry], dest, (d) => blobs.get(d))));
    assert.equal(exists(outside.dir, "gone"), false);
  } finally {
    done();
    outside.done();
    holder.done();
  }
});

test("a path replaced during blob retrieval never redirects the write", () => {
  const { blobs, done } = fixture();
  const outside = scratch();
  const target = scratch();
  try {
    const hash = blobs.put(new TextEncoder().encode("payload")).digest;
    const dest = target.dir;
    mkdirSync(join(dest, "sub"));

    // The blob callback replaces the validated directory with a link
    // between the check and the write. The writer must refuse.
    const replaced = thrownBy(() =>
      materializeTree(
        [{ path: "sub/data.txt", kind: "file", executable: false, contentHash: hash }],
        dest,
        (digest) => {
          rmSync(join(dest, "sub"), { recursive: true });
          symlinkSync(outside.dir, join(dest, "sub"));
          return blobs.get(digest);
        },
      ),
    );
    assert.ok(isPortableCode(replaced) && replaced.code === "UnsupportedOperation");
    assert.equal(exists(outside.dir, "data.txt"), false);
    assert.equal(lstatSync(join(dest, "sub")).isSymbolicLink(), true);
  } finally {
    done();
    outside.done();
    target.done();
  }
});

test("an exclusive create refuses a target installed while blobs are read", () => {
  const { blobs, done } = fixture();
  const target = scratch();
  try {
    const hash = blobs.put(new TextEncoder().encode("payload")).digest;
    const raced = thrownBy(() =>
      materializeTree(
        [{ path: "data.txt", kind: "file", executable: false, contentHash: hash }],
        target.dir,
        (digest) => {
          // A file appears at the target while the blob is read.
          writeFileSync(join(target.dir, "data.txt"), "raced");
          return blobs.get(digest);
        },
      ),
    );
    assert.ok(isPortableCode(raced) && raced.code === "InvalidRequest");
    assert.equal(
      JSON.stringify((raced as { details?: { reason?: string } }).details).includes(
        "target-collision",
      ),
      true,
    );
    assert.equal(readFileSync(join(target.dir, "data.txt"), "utf8"), "raced");
  } finally {
    done();
    target.done();
  }
});
