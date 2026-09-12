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
import { checkpointWorkspace, materializeRevision } from "./workspace.js";
import { bindResource } from "./resources.js";
import type { BindTransport } from "./resources.js";
import { exportBundle } from "./bundle.js";
import { importBundle } from "./bundle-import.js";
import type { BundleImportReport } from "./bundle-import.js";
import type { BundleManifest } from "../schema/bundle.js";
import type { TreeEntry } from "../store/workspace-tree.js";

/** The authority raw transfers run under in these tests. */
const AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["local"],
  locations: ["local", "remote"],
  networkEgress: "unrestricted",
  hostFilesystemAccess: true,
  maxEnvironmentLifetimeMs: 86_400_000,
  maxResources: {
    memoryBytes: 4 * 1024 ** 3,
    storageBytes: 4 * 1024 ** 3,
    gpuMemoryBytes: 4 * 1024 ** 3,
  },
});

/** A transport that always reports the reference bound unchanged. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource };
  },
};

/** One exported bundle on disk, with the store that produced it. */
interface Exported {
  bundlePath: string;
  root: string;
  revisionId: string;
  manifest: BundleManifest;
  sourceSessionId: string;
  done(): void;
}

/** Seed a session and export it, self-contained by default. */
async function exportedBundle(selfContained = true): Promise<Exported> {
  const root = mkdtempSync(join(tmpdir(), "porta-import-"));
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(join(root, "blobs"), store);
  const sessionId = "sess-source";
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId: "ws-source",
    eventSequence: 0,
    policyRef: "policy://source",
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
  new SessionEventStream(store, sessionId).append("attachment.attached", "att-worker", {
    attachmentId: "att-worker",
    name: "worker",
    generation: 4,
  });
  for (const recovery of ["reconstruct", "reattach"] as const) {
    await bindResource(
      store,
      sessionId,
      {
        type: recovery === "reconstruct" ? "process.group" : "browser.session",
        owner: { sessionId, attachmentId: "att-worker", generation: 4 },
        capability: "exec.process@1",
        lifetime: "attachment",
        recovery,
      },
      okTransport,
      {
        authority: PolicyAuthority.fromPolicy({
          schemaVersion: 1,
          operations: ["exec.process@1"],
          locations: ["local", "remote"],
          networkEgress: "unrestricted",
          hostFilesystemAccess: true,
          maxEnvironmentLifetimeMs: 86_400_000,
          maxResources: {
            memoryBytes: 4 * 1024 ** 3,
            storageBytes: 4 * 1024 ** 3,
            gpuMemoryBytes: 4 * 1024 ** 3,
          },
        }),
      },
    );
  }
  const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
  const bundlePath = join(root, "bundle");
  const tree = JSON.parse(
    store.getRevisionTree(checkpoint.revision.id)!.entriesJson,
  ) as TreeEntry[];
  const report = exportBundle(
    store,
    sessionId,
    {
      selfContained,
      harnessContextRef: "harness://opaque/context-ref-1",
      ...(selfContained
        ? {}
        : {
            retrievalLocations: tree
              .filter((entry) => entry.contentHash !== null)
              .map((entry) => ({
                digest: entry.contentHash!,
                location: `https://blobs.example.test/${digestOf("the application file") === entry.contentHash ? "app" : "run"}/${entry.contentHash}`,
              })),
          }),
    },
    { blobs, rootPath: bundlePath, authority: AUTHORITY },
  );
  return {
    bundlePath,
    root,
    revisionId: checkpoint.revision.id,
    manifest: report.manifest,
    sourceSessionId: sessionId,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One fresh destination: an empty store beside a fresh blob root. */
function destination(root: string): { store: ControlStore; blobs: BlobStore } {
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(join(root, "destination-blobs"), store);
  return { store, blobs };
}

/** Import with the standard options of these tests. */
function standardImport(
  state: Exported,
  store: ControlStore,
  blobs: BlobStore,
  overrides: {
    supportedExtensions?: string[];
    fetchBytes?: (location: string) => Uint8Array;
    authority?: PolicyAuthority;
  } = {},
): BundleImportReport {
  return importBundle(
    store,
    { policyRef: "policy://destination" },
    {
      blobs,
      rootPath: state.bundlePath,
      authority: overrides.authority ?? AUTHORITY,
      ...(overrides.supportedExtensions !== undefined
        ? { supportedExtensions: overrides.supportedExtensions }
        : {}),
      ...(overrides.fetchBytes !== undefined ? { fetchBytes: overrides.fetchBytes } : {}),
    },
  );
}

test("a validated bundle imports as a new session the source never authorized", async () => {
  const state = await exportedBundle();
  try {
    const { store, blobs } = destination(state.root);
    const report = standardImport(state, store, blobs);

    // The new session is its own session, under the importer's policy.
    assert.notEqual(report.sessionId, state.sourceSessionId);
    const session = store.getSession(report.sessionId)!;
    assert.equal(session.status, "open");
    assert.equal(session.policyRef, "policy://destination");
    assert.equal(store.getWorkspaceHead(report.workspaceId), report.revisionId);
    assert.equal(store.getSession(state.sourceSessionId), null);

    // The workspace carried over, file for file.
    assert.equal(report.fileCount, 2);
    assert.equal(
      report.totalBytes,
      "the application file".length + "#!/bin/sh\necho hi\n".length,
    );
    const copy = materializeRevision(
      store,
      report.sessionId,
      blobs,
      report.revisionId,
      join(state.root, "materialized"),
      { authority: AUTHORITY, mode: "proposal" },
    );
    assert.equal(copy.entryCount, 3);
    assert.equal(
      readFileSync(join(state.root, "materialized", "app.txt"), "utf8"),
      "the application file",
    );
    assert.equal(
      readFileSync(join(state.root, "materialized", "nested", "run.sh"), "utf8"),
      "#!/bin/sh\necho hi\n",
    );

    // Attachments re-keyed to the new session; generations kept.
    assert.deepEqual(
      report.attachments.map((entry) => [entry.name, entry.generation, entry.sessionId]),
      [["worker", 4, report.sessionId]],
    );
    assert.equal(store.getAttachment("att-worker")!.sessionId, report.sessionId);
    assert.equal(store.listAttachments(report.sessionId).length, 1);

    // Resources arrive invalidated, naming the action they wait for;
    // nothing claims a provider session the destination never had.
    assert.deepEqual(
      report.resources.map((entry) => [entry.status, entry.invalidationReason]).sort(),
      [
        ["invalidated", "imported-pending-reattach"],
        ["invalidated", "imported-pending-reconstruct"],
      ],
    );
    for (const binding of store.listResourceBindings(report.sessionId)) {
      assert.equal(binding.status, "invalidated");
      assert.equal(binding.owner.sessionId, report.sessionId);
    }
    // Import promised no cleanup and executed no recipe.
    assert.equal(store.listCleanup(report.sessionId, "pending").length, 0);

    // The journal replayed, and the opaque reference crossed verbatim.
    assert.ok(report.journalEvents >= 1);
    const events = store.listEvents(report.sessionId, 0, 500);
    assert.ok(events.some((event) => event.type === "attachment.attached"));
    assert.equal(report.harnessContextRef, "harness://opaque/context-ref-1");
  } finally {
    state.done();
  }
});

test("a corrupt or missing blob refuses the import", async () => {
  const state = await exportedBundle();
  try {
    const digest = createHash("sha256").update("the application file").digest("hex");
    const blobPath = join(state.bundlePath, "blobs", "sha256", digest);

    const corrupt = destination(state.root);
    writeFileSync(blobPath, "tampered but same-length!");
    assert.throws(
      () => standardImport(state, corrupt.store, corrupt.blobs),
      (error: unknown) => (error as { code?: string }).code === "IntegrityFailure",
    );

    rmSync(blobPath);
    const missing = destination(state.root);
    assert.throws(
      () => standardImport(state, missing.store, missing.blobs),
      (error: unknown) => (error as { code?: string }).code === "IntegrityFailure",
    );
  } finally {
    state.done();
  }
});

test("an unsafe inventory path refuses before anything is read", async () => {
  const state = await exportedBundle();
  try {
    rewriteManifest(state, (manifest) => {
      manifest.artifactInventory[0]!.path = "../escape.txt";
    });
    const { store, blobs } = destination(state.root);
    assert.throws(
      () => standardImport(state, store, blobs),
      (error: unknown) => {
        const code = (error as { code?: string }).code;
        return code === "InvalidRequest";
      },
    );
  } finally {
    state.done();
  }
});

test("a lying size in the manifest refuses", async () => {
  const state = await exportedBundle();
  try {
    rewriteManifest(state, (manifest) => {
      manifest.artifactInventory[0]!.sizeBytes += 1;
    });
    const { store, blobs } = destination(state.root);
    assert.throws(
      () => standardImport(state, store, blobs),
      (error: unknown) => (error as { code?: string }).code === "IntegrityFailure",
    );
  } finally {
    state.done();
  }
});

test("publication limits refuse an oversized import", async () => {
  const state = await exportedBundle();
  try {
    const store = ControlStore.inMemory();
    const blobs = new BlobStore(join(state.root, "limited-blobs"), store, {
      maxFileBytes: 4,
    });
    assert.throws(
      () => standardImport(state, store, blobs),
      (error: unknown) => (error as { code?: string }).code === "InvalidRequest",
    );
  } finally {
    state.done();
  }
});

test("an unknown required extension refuses the bundle", async () => {
  const state = await exportedBundle();
  try {
    rewriteManifest(state, (manifest) => {
      manifest.requiredExtensions = ["vendor.unknown@1"];
    });
    const refused = destination(state.root);
    assert.throws(
      () => standardImport(state, refused.store, refused.blobs),
      (error: unknown) => {
        const shaped = error as { code?: string; details?: { missingExtensions?: string[] } };
        return (
          shaped.code === "InvalidRequest" &&
          shaped.details?.missingExtensions?.[0] === "vendor.unknown@1"
        );
      },
    );
    // A consumer that knows the extension imports.
    const aware = destination(state.root);
    const report = standardImport(state, aware.store, aware.blobs, {
      supportedExtensions: ["vendor.unknown@1"],
    });
    assert.equal(aware.store.getSession(report.sessionId)!.status, "open");
  } finally {
    state.done();
  }
});

test("undeclared content riding in the bundle refuses", async () => {
  const state = await exportedBundle();
  try {
    writeFileSync(join(state.bundlePath, "stowaway.txt"), "not declared");
    const { store, blobs } = destination(state.root);
    assert.throws(
      () => standardImport(state, store, blobs),
      (error: unknown) => (error as { code?: string }).code === "InvalidRequest",
    );
  } finally {
    state.done();
  }
});

test("a store holding the source session is never continued through a bundle", async () => {
  const state = await exportedBundle();
  try {
    // The exporting store itself holds the source session.
    const store = ControlStore.inMemory();
    store.createSession({
      id: state.sourceSessionId,
      schemaVersion: 1,
      status: "open",
      workspaceId: "ws-original",
      eventSequence: 0,
      policyRef: "policy://source",
      createdAt: new Date().toISOString(),
    });
    const blobs = new BlobStore(join(state.root, "same-store-blobs"), store);
    assert.throws(
      () => standardImport(state, store, blobs),
      (error: unknown) =>
        (error as { code?: string }).code === "InvalidRequest" &&
        (error as { message?: string }).message!.includes("authoritative"),
    );
    // A second import into one destination store also refuses: one
    // revision identity, one controller.
    const once = destination(state.root);
    standardImport(state, once.store, once.blobs);
    assert.throws(
      () => standardImport(state, once.store, once.blobs),
      (error: unknown) => (error as { code?: string }).code === "InvalidRequest",
    );
  } finally {
    state.done();
  }
});

test("the raw transfer needs the policy's local destination grant", async () => {
  const state = await exportedBundle();
  try {
    const { store, blobs } = destination(state.root);
    assert.throws(
      () =>
        standardImport(state, store, blobs, {
          authority: PolicyAuthority.fromPolicy({ schemaVersion: 1 }),
        }),
      (error: unknown) => (error as { code?: string }).code === "PolicyDenied",
    );
  } finally {
    state.done();
  }
});

test("a reference-only bundle imports through its authorized locations", async () => {
  const state = await exportedBundle(false);
  try {
    const contents = new Map<string, Uint8Array>([
      ["app", new TextEncoder().encode("the application file")],
      ["run", new TextEncoder().encode("#!/bin/sh\necho hi\n")],
    ]);
    const fetchBytes = (location: string): Uint8Array => {
      const kind = location.split("/").at(-2) ?? "";
      const data = contents.get(kind);
      if (data === undefined) {
        throw new Error(`unknown location ${location}`);
      }
      return data;
    };
    const { store, blobs } = destination(state.root);
    const report = standardImport(state, store, blobs, { fetchBytes });
    assert.equal(report.fileCount, 2);
    assert.ok(readdirSync(join(state.root, "destination-blobs", "objects")).length > 0);
    const materialized = materializeRevision(
      store,
      report.sessionId,
      blobs,
      report.revisionId,
      join(state.root, "fetched-copy"),
      { authority: AUTHORITY, mode: "proposal" },
    );
    assert.equal(materialized.entryCount, 3);

    // Without a fetcher, the same bundle refuses.
    const bare = destination(state.root);
    assert.throws(
      () => standardImport(state, bare.store, bare.blobs),
      (error: unknown) => (error as { code?: string }).code === "InvalidRequest",
    );
  } finally {
    state.done();
  }
});

/** Rewrite the manifest through one edit, restoring inventory honesty. */
function rewriteManifest(state: Exported, edit: (manifest: BundleManifest) => void): void {
  const path = join(state.bundlePath, "manifest.json");
  const manifest: BundleManifest = JSON.parse(readFileSync(path, "utf8"));
  edit(manifest);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(path, text);
  // Keep the inventory entry of the manifest itself consistent is
  // unnecessary: the manifest never carries its own digest.
  void text;
}
