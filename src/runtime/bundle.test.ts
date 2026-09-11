import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyAuthority } from "../core/policy.js";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import { checkpointWorkspace } from "./workspace.js";
import { bindResource } from "./resources.js";
import type { BindTransport } from "./resources.js";
import { exportBundle } from "./bundle.js";
import type { BundleManifest } from "../schema/bundle.js";
import type { TreeEntry } from "../store/workspace-tree.js";

/** The authority raw transfers run under in these tests. */
const AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["local"],
});

/** A transport that always reports the reference bound unchanged. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource };
  },
};

/** One seeded session: a workspace with files, an attachment, resources. */
interface Seeded {
  store: ControlStore;
  blobs: BlobStore;
  sessionId: string;
  attachmentId: string;
  revisionId: string;
  root: string;
  done(): void;
}

function seed(): Seeded {
  const root = mkdtempSync(join(tmpdir(), "porta-bundle-"));
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(join(root, "blobs"), store);
  const sessionId = `sess-bundle`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId: "ws-bundle",
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: new Date().toISOString(),
  });
  const src = join(root, "src");
  mkdirSync(join(src, "nested"), { recursive: true });
  writeFileSync(join(src, "app.txt"), "the application file");
  writeFileSync(join(src, "nested", "run.sh"), "#!/bin/sh\necho hi\n");
  const checkpoint = checkpointWorkspace(
    store,
    sessionId,
    blobs,
    { requestKey: "import-1", source: { kind: "bridge", rootPath: src } },
    { stability: { kind: "locked" } },
  );
  store.insertAttachment({
    sessionId,
    attachmentId: "att-worker",
    name: "worker",
    generation: 4,
    status: "active",
    capabilityIds: ["exec.process@1"],
  });
  const stream = new SessionEventStream(store, sessionId);
  stream.append("attachment.attached", "att-worker", {
    attachmentId: "att-worker",
    name: "worker",
    generation: 4,
  });
  return {
    store,
    blobs,
    sessionId,
    attachmentId: "att-worker",
    revisionId: checkpoint.revision.id,
    root,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Bind one resource under the seeded attachment. */
async function bindOne(state: Seeded, type: string, recovery: "reconstruct" | "reattach" | "native") {
  return bindResource(
    state.store,
    state.sessionId,
    {
      type,
      owner: { sessionId: state.sessionId, attachmentId: state.attachmentId, generation: 4 },
      capability: "exec.process@1",
      lifetime: "attachment",
      recovery,
    },
    okTransport,
    { authority: PolicyAuthority.fromPolicy({ schemaVersion: 1, operations: ["exec.process@1"] }) },
  );
}

test("a self-contained bundle carries every referenced blob and an honest inventory", async () => {
  const state = seed();
  try {
    await bindOne(state, "process.group", "reconstruct");
    await bindOne(state, "browser.session", "reattach");
    const out = join(state.root, "bundle");
    const report = exportBundle(
      state.store,
      state.sessionId,
      { selfContained: true, harnessContextRef: "harness://opaque/context-ref-1" },
      { blobs: state.blobs, rootPath: out, authority: AUTHORITY },
    );

    // The layout SPEC.md section 19 names.
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    assert.deepEqual(sortedWalk(out, out), [
      "blobs",
      "blobs/sha256",
      `blobs/sha256/${sha("#!/bin/sh\necho hi\n")}`,
      `blobs/sha256/${sha("the application file")}`,
      "extensions",
      "journal.jsonl",
      "manifest.json",
      "resources.json",
      "state.json",
      "workspace",
      "workspace/tree.json",
    ]);

    // Every inventory entry matches the bytes on disk, digest and size.
    const manifest: BundleManifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.kind, "portable.bundle");
    assert.equal(manifest.selfContained, true);
    assert.equal(manifest.sourceSessionId, state.sessionId);
    assert.equal(manifest.workspaceRevisionId, state.revisionId);
    assert.equal(manifest.rootHash, report.manifest.rootHash);
    assert.equal(manifest.retrievalLocations, undefined);
    assert.deepEqual(manifest.attachmentGenerations, { worker: 4 });
    assert.equal(manifest.harnessContextRef, "harness://opaque/context-ref-1");
    for (const artifact of manifest.artifactInventory) {
      const bytes = readFileSync(join(out, artifact.path));
      assert.equal(bytes.byteLength, artifact.sizeBytes, artifact.path);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        artifact.digest,
        artifact.path,
      );
    }
    // The two workspace blobs are in the bundle, byte for byte.
    const tree = JSON.parse(readFileSync(join(out, "workspace/tree.json"), "utf8")) as TreeEntry[];
    const digests = tree
      .filter((entry) => entry.contentHash !== null)
      .map((entry) => entry.contentHash!);
    const expectedContents = new Set(["the application file", "#!/bin/sh\necho hi\n"]);
    assert.equal(digests.length, 2);
    for (const digest of digests) {
      const blob = manifest.artifactInventory.find(
        (artifact) => artifact.path === `blobs/sha256/${digest}`,
      );
      assert.ok(blob !== undefined, digest);
      const content = readFileSync(join(out, "blobs/sha256", digest), "utf8");
      assert.ok(expectedContents.has(content), content);
      expectedContents.delete(content);
    }
    assert.equal(expectedContents.size, 0);

    // Dispositions classify both resources by their recovery mode.
    assert.deepEqual(
      manifest.stateDispositions.map((entry) => [entry.class, entry.action]).sort(),
      [
        ["reattachable", "reattach"],
        ["reconstructable", "reconstruct"],
      ],
    );

    // The journal carries every event, the attachment one included;
    // the state document carries the opaque harness reference verbatim.
    const journal = readFileSync(join(out, "journal.jsonl"), "utf8").trim().split("\n");
    assert.equal(journal.length, report.journalEvents);
    assert.ok(journal.some((line) => JSON.parse(line).type === "attachment.attached"));
    const stateDoc = JSON.parse(readFileSync(join(out, "state.json"), "utf8"));
    assert.equal(stateDoc.harnessContextRef, "harness://opaque/context-ref-1");
    assert.equal(stateDoc.attachments[0].name, "worker");

    // Resources carry their binding facts, scrubbed of nothing here.
    const resourcesDoc = JSON.parse(readFileSync(join(out, "resources.json"), "utf8"));
    assert.equal(resourcesDoc.resources.length, 2);
    assert.ok(resourcesDoc.resources.every((entry: { status: string }) => entry.status === "bound"));

    assert.ok(report.journalEvents >= 1);
    assert.equal(report.artifactCount, manifest.artifactInventory.length);
  } finally {
    state.done();
  }
});

test("a reference-only bundle omits the blobs and names their authorized locations", async () => {
  const state = seed();
  try {
    const tree = JSON.parse(
      state.store.getRevisionTree(state.revisionId)!.entriesJson,
    ) as TreeEntry[];
    const digests = tree
      .filter((entry) => entry.contentHash !== null)
      .map((entry) => entry.contentHash!);
    const out = join(state.root, "bundle");
    exportBundle(
      state.store,
      state.sessionId,
      {
        selfContained: false,
        retrievalLocations: digests.map((digest) => ({
          digest,
          location: `https://blobs.example.test/${digest}`,
        })),
      },
      { blobs: state.blobs, rootPath: out, authority: AUTHORITY },
    );
    const manifest: BundleManifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.selfContained, false);
    assert.equal(manifest.retrievalLocations?.length, digests.length);
    assert.deepEqual(readdirSync(join(out, "blobs", "sha256")), []);
    // The inventory still measures the blobs it did not carry.
    for (const digest of digests) {
      assert.ok(
        manifest.artifactInventory.some(
          (artifact) => artifact.path === `blobs/sha256/${digest}`,
        ),
      );
    }
  } finally {
    state.done();
  }
});

test("a reference-only export refuses a blob with no authorized location", async () => {
  const state = seed();
  try {
    assert.throws(
      () =>
        exportBundle(
          state.store,
          state.sessionId,
          { selfContained: false },
          { blobs: state.blobs, rootPath: join(state.root, "bundle"), authority: AUTHORITY },
        ),
      (error: unknown) => (error as { code?: string }).code === "InvalidRequest",
    );
  } finally {
    state.done();
  }
});

test("a retrieval location that smells like a credential refuses", async () => {
  const state = seed();
  try {
    const tree = JSON.parse(
      state.store.getRevisionTree(state.revisionId)!.entriesJson,
    ) as TreeEntry[];
    const digest = tree.find((entry) => entry.contentHash !== null)!.contentHash!;
    assert.throws(
      () =>
        exportBundle(
          state.store,
          state.sessionId,
          {
            selfContained: false,
            retrievalLocations: [
              { digest, location: "https://blobs.example.test/?token=sk-live-abcdef" },
            ],
          },
          { blobs: state.blobs, rootPath: join(state.root, "bundle"), authority: AUTHORITY },
        ),
      (error: unknown) => (error as { code?: string }).code === "InvalidRequest",
    );
  } finally {
    state.done();
  }
});

test("a missing referenced blob refuses the self-contained export", async () => {
  const state = seed();
  try {
    // A second revision over a blob the store then loses.
    rmSync(join(state.root, "blobs", "objects"), { recursive: true, force: true });
    assert.throws(
      () =>
        exportBundle(
          state.store,
          state.sessionId,
          { selfContained: true },
          { blobs: state.blobs, rootPath: join(state.root, "bundle"), authority: AUTHORITY },
        ),
      (error: unknown) => (error as { code?: string }).code === "IntegrityFailure",
    );
  } finally {
    state.done();
  }
});

test("the raw transfer needs the policy's local destination grant", async () => {
  const state = seed();
  try {
    assert.throws(
      () =>
        exportBundle(
          state.store,
          state.sessionId,
          { selfContained: true },
          {
            blobs: state.blobs,
            rootPath: join(state.root, "bundle"),
            authority: PolicyAuthority.fromPolicy({ schemaVersion: 1 }),
          },
        ),
      (error: unknown) => (error as { code?: string }).code === "PolicyDenied",
    );
  } finally {
    state.done();
  }
});

test("an occupied bundle directory refuses to be overwritten", async () => {
  const state = seed();
  try {
    const out = join(state.root, "bundle");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "precious.txt"), "do not clobber");
    assert.throws(
      () =>
        exportBundle(
          state.store,
          state.sessionId,
          { selfContained: true },
          { blobs: state.blobs, rootPath: out, authority: AUTHORITY },
        ),
      (error: unknown) => (error as { code?: string }).code === "InvalidRequest",
    );
    assert.equal(readFileSync(join(out, "precious.txt"), "utf8"), "do not clobber");
  } finally {
    state.done();
  }
});

test("credential-shaped extension values scrub out of the record files", async () => {
  const state = seed();
  try {
    await bindResource(
      state.store,
      state.sessionId,
      {
        type: "process.group",
        owner: { sessionId: state.sessionId, attachmentId: state.attachmentId, generation: 4 },
        capability: "exec.process@1",
        lifetime: "attachment",
        recovery: "reconstruct",
        extensions: {
          "portable.test.token": "sk-live-abcdefghij",
          "portable.test.plain": "harmless",
        },
      },
      okTransport,
      {
        authority: PolicyAuthority.fromPolicy({
          schemaVersion: 1,
          operations: ["exec.process@1"],
        }),
      },
    );
    const out = join(state.root, "bundle");
    exportBundle(
      state.store,
      state.sessionId,
      { selfContained: true },
      { blobs: state.blobs, rootPath: out, authority: AUTHORITY },
    );
    const text = readFileSync(join(out, "resources.json"), "utf8");
    assert.ok(!text.includes("sk-live-abcdefghij"), text);
    assert.ok(text.includes("harmless"));
    const manifestText = readFileSync(join(out, "manifest.json"), "utf8");
    assert.ok(!manifestText.includes("sk-live-abcdefghij"));
  } finally {
    state.done();
  }
});

test("journal data passes through the caller's redactor", async () => {
  const state = seed();
  try {
    const stream = new SessionEventStream(state.store, state.sessionId);
    stream.append("workspace.checkpointed", "ws-bundle", {
      revisionId: "rev-bundle",
      requestKey: "checkpoint-secret-carrier",
    });
    const out = join(state.root, "bundle");
    exportBundle(
      state.store,
      state.sessionId,
      { selfContained: true },
      {
        blobs: state.blobs,
        rootPath: out,
        authority: AUTHORITY,
        redactor: (data) => ({ ...data, requestKey: "[redacted]" }),
      },
    );
    const journal = readFileSync(join(out, "journal.jsonl"), "utf8");
    assert.ok(!journal.includes("checkpoint-secret-carrier"));
    assert.ok(journal.includes("[redacted]"));
  } finally {
    state.done();
  }
});

/** List every relative path under one root, directories included. */
function sortedWalk(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const rel = dir === root ? name.name : `${dir.slice(root.length + 1)}/${name.name}`;
    if (name.isDirectory()) {
      out.push(rel, ...sortedWalk(root, join(dir, name.name)));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}
