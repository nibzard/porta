import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../store/control-store.js";
import { BlobStore } from "../../store/blob-store.js";
import { PolicyAuthority } from "../../core/policy.js";
import type { PolicyAuthority as Authority } from "../../core/policy.js";
import { checkpointWorkspace } from "../../runtime/workspace.js";
import { exportBundle } from "../../runtime/bundle.js";
import type { BundleExportRequest } from "../../runtime/bundle.js";
import { importBundle } from "../../runtime/bundle-import.js";
import { bindResource } from "../../runtime/resources.js";
import type { BindTransport, ResourceFlowOptions } from "../../runtime/resources.js";
import type { ConformanceCase } from "../runner.js";
import type { ConformanceCaseAnswer } from "../runner.js";
import type { BundleManifest } from "../../schema/bundle.js";
import type { BundleImportReport } from "../../runtime/bundle-import.js";

/**
 * Bundle conformance cases (SPEC.md section 21, Bundle row).
 *
 * The pack proves the integrity boundary around a portable bundle: a
 * blob that went missing refuses the transfer, tampered content fails
 * its digest, a required extension this consumer lacks refuses the
 * whole bundle, credential-shaped references never cross, and an
 * import creates one new session without executing anything or
 * competing with the source controller.
 *
 * Every case uses private temporary stores. No case touches the loaded
 * adapter or causes effects outside its own directory.
 */

/** One bench: an in-memory store, its blobs, and one committed revision. */
interface Bench {
  store: ControlStore;
  blobs: BlobStore;
  /** The directory the blob store keeps its objects under. */
  blobRoot: string;
  sessionId: string;
  workspaceId: string;
  revisionId: string;
  blobDigests: string[];
  /** A fresh empty directory under the case's own root. */
  directory(): string;
  done(): void;
}

/** The authority every transfer in this pack runs under. */
const LOCAL_AUTHORITY: Authority = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["local"],
});

function bench(): Bench {
  const root = mkdtempSync(join(tmpdir(), "porta-conf-bundle-"));
  const store = ControlStore.inMemory();
  const blobRoot = join(root, "blobs");
  const blobs = new BlobStore(blobRoot, store);
  const sessionId = `sess-${randomUUID()}`;
  const workspaceId = `ws-${randomUUID()}`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId,
    eventSequence: 0,
    policyRef: "policy://conformance",
    createdAt: new Date().toISOString(),
  });
  const src = join(root, "src");
  mkdirSync(src);
  writeFileSync(join(src, "app.txt"), "bundle content\n");
  writeFileSync(join(src, "data.bin"), Buffer.from([0x00, 0x80, 0xff, 0x10]));
  const { revision } = checkpointWorkspace(
    store,
    sessionId,
    blobs,
    { requestKey: `bench-${randomUUID()}`, source: { kind: "bridge", rootPath: src } },
    { stability: { kind: "locked" } },
  );
  const tree = store.getRevisionTree(revision.id);
  const blobDigests =
    tree === null
      ? []
      : (JSON.parse(tree.entriesJson) as { contentHash: string | null }[])
          .flatMap((entry) => (entry.contentHash !== null ? [entry.contentHash] : []));
  let counter = 0;
  return {
    store,
    blobs,
    blobRoot,
    sessionId,
    workspaceId,
    revisionId: revision.id,
    blobDigests,
    directory() {
      counter += 1;
      const dir = join(root, `dir-${counter}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One export into a fresh directory. */
function exportTo(
  state: Bench,
  overrides: Partial<BundleExportRequest> = {},
): string {
  const root = state.directory();
  exportBundle(
    state.store,
    state.sessionId,
    { selfContained: true, ...overrides },
    { blobs: state.blobs, rootPath: root, authority: LOCAL_AUTHORITY },
  );
  return root;
}

/** The bind transport the seeding uses: every reference reports bound. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource };
  },
};

/** The options the seeding bind calls run under. */
const bindOptions: ResourceFlowOptions = {
  authority: PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    operations: ["exec.process@1"],
    transferDestinations: ["local"],
  }),
};

/** Seed one reconstruct-mode resource bound to one fresh attachment. */
async function seedReconstructable(state: Bench): Promise<string> {
  const attachmentId = `att-${randomUUID()}`;
  state.store.insertAttachment({
    sessionId: state.sessionId,
    attachmentId,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  });
  return (
    await bindResource(
      state.store,
      state.sessionId,
      {
        type: "process.group",
        recovery: "reconstruct",
        owner: { sessionId: state.sessionId, attachmentId, generation: 1 },
        capability: "exec.process@1",
        lifetime: "attachment",
      },
      okTransport,
      bindOptions,
    )
  ).ref.id;
}

/** Import one bundle into a fresh store, through a fresh blob root. */
function importFresh(
  state: Bench,
  root: string,
  options: { supportedExtensions?: string[] } = {},
): { report: BundleImportReport; destination: ControlStore } {
  const destination = ControlStore.inMemory();
  return {
    report: importBundle(
      destination,
      { policyRef: "policy://import" },
      {
        blobs: new BlobStore(state.directory(), destination),
        rootPath: root,
        authority: LOCAL_AUTHORITY,
        ...(options.supportedExtensions !== undefined
          ? { supportedExtensions: options.supportedExtensions }
          : {}),
      },
    ),
    destination,
  };
}

/** The portable error of one thrown value, or null. */
function errorOf(thrown: unknown): { code?: unknown; message?: unknown; details?: unknown } | null {
  return thrown !== null && typeof thrown === "object"
    ? (thrown as { code?: unknown; message?: unknown; details?: unknown })
    : null;
}

/** One observation that must refuse with a code. */
function expectCode(
  run: () => unknown,
  wanted: string,
): ConformanceCaseAnswer | void {
  try {
    run();
  } catch (error) {
    const record = errorOf(error);
    if (record?.code === wanted) {
      return undefined;
    }
    return {
      outcome: "fail",
      reason: `expected ${wanted}, saw ${String(record?.code ?? "no portable error")}`,
      detail: record?.message !== undefined ? String(record.message) : String(error),
    };
  }
  return { outcome: "fail", reason: `expected ${wanted}, the call succeeded` };
}

/** Rewrite one bundle file with edited bytes of the same length. */
function tamper(root: string, path: string, replacement: Buffer): void {
  const target = join(root, path);
  const original = readFileSync(target);
  if (replacement.length !== original.length) {
    throw new Error(`tamper needs equal lengths: ${replacement.length} != ${original.length}`);
  }
  writeFileSync(target, replacement);
}

/** The bundle case pack. */
export function bundleCases(): ConformanceCase[] {
  return [
    {
      id: "bundle.missing-blobs",
      area: "bundle",
      summary: "A blob that vanished from the store or the bundle refuses the transfer.",
      async run() {
        const state = bench();
        try {
          // The store no longer produces a referenced blob.
          const digest = state.blobDigests[0]!;
          unlinkSync(join(state.blobRoot, "objects", digest.slice(0, 2), digest));
          const missing = expectCode(() => exportTo(state), "IntegrityFailure");
          if (missing !== undefined) {
            return missing;
          }

          // A complete export, minus one carried blob, refuses import.
          const second = bench();
          try {
            const root = exportTo(second);
            unlinkSync(join(root, "blobs", "sha256", second.blobDigests[0]!));
            return expectCode(
              () => importFresh(second, root).report,
              "IntegrityFailure",
            );
          } finally {
            second.done();
          }
        } finally {
          state.done();
        }
      },
    },
    {
      id: "bundle.tampered-content",
      area: "bundle",
      summary: "Edited bytes fail their declared digest before anything imports.",
      async run() {
        const state = bench();
        try {
          // Flip bytes inside one carried blob, keeping the length.
          const root = exportTo(state);
          const blobPath = join(root, "blobs", "sha256", state.blobDigests[0]!);
          const bytes = readFileSync(blobPath);
          tamper(
            root,
            `blobs/sha256/${state.blobDigests[0]}`,
            Buffer.from(bytes.map((byte, index) => (index === 0 ? byte ^ 0xff : byte))),
          );
          const blobAnswer = expectCode(
            () => importFresh(state, root).report,
            "IntegrityFailure",
          );
          if (blobAnswer !== undefined) {
            return blobAnswer;
          }

          // The journal is content-addressed like everything else: a
          // swapped event line fails the digest.
          const second = bench();
          try {
            const clean = exportTo(second);
            const journal = readFileSync(join(clean, "journal.jsonl"));
            const swapped = Buffer.from(journal.map((byte, index) => (index === 5 ? byte ^ 0x20 : byte)));
            tamper(clean, "journal.jsonl", swapped);
            return expectCode(
              () => importFresh(second, clean).report,
              "IntegrityFailure",
            );
          } finally {
            second.done();
          }
        } finally {
          state.done();
        }
      },
    },
    {
      id: "bundle.unknown-required-extension",
      area: "bundle",
      summary: "A required extension this consumer does not support refuses the bundle.",
      async run(): Promise<ConformanceCaseAnswer | void> {
        const state = bench();
        try {
          const root = exportTo(state);
          const manifestPath = join(root, "manifest.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BundleManifest;
          manifest.requiredExtensions = ["com.example.unsupported"];
          writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

          let thrown: unknown = null;
          try {
            importFresh(state, root, { supportedExtensions: ["com.example.known"] }).report;
          } catch (error) {
            thrown = error;
          }
          const record = errorOf(thrown);
          if (record?.code !== "InvalidRequest") {
            return {
              outcome: "fail",
              reason: `expected InvalidRequest, saw ${String(record?.code ?? "success")}`,
            };
          }
          const details = record.details as { missingExtensions?: unknown } | undefined;
          if (
            !Array.isArray(details?.missingExtensions) ||
            !details.missingExtensions.includes("com.example.unsupported")
          ) {
            return {
              outcome: "fail",
              reason: "the refusal does not name the missing extension",
              detail: JSON.stringify(record.details),
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "bundle.credential-references",
      area: "bundle",
      summary: "Credential-shaped references refuse or scrub before they cross.",
      async run(): Promise<ConformanceCaseAnswer | void> {
        const state = bench();
        try {
          // A retrieval location that carries a credential parameter
          // refuses the export outright.
          const refused = expectCode(
            () =>
              exportBundle(
                state.store,
                state.sessionId,
                {
                  selfContained: false,
                  retrievalLocations: state.blobDigests.map((digest, index) => ({
                    digest,
                    location:
                      index === 0
                        ? "https://objects.example/blobs?token=sk-abcdef123456"
                        : `https://objects.example/blobs/${digest}`,
                  })),
                },
                { blobs: state.blobs, rootPath: state.directory(), authority: LOCAL_AUTHORITY },
              ),
            "InvalidRequest",
          );
          if (refused !== undefined) {
            return refused;
          }

          // Attachment extensions that smell of credentials scrub out
          // of the exported record files.
          const seeded = bench();
          try {
            seeded.store.insertAttachment({
              sessionId: seeded.sessionId,
              attachmentId: `att-${randomUUID()}`,
              name: "secret-holder",
              generation: 1,
              status: "active",
              capabilityIds: ["exec.process@1"],
              extensions: {
                "com.example.auth": "sk-abcdef1234567890",
                "com.example.note": "survives",
              },
            });
            const root = exportTo(seeded);
            const stateDocument = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as {
              attachments: { name: string; extensions?: Record<string, unknown> }[];
            };
            const holder = stateDocument.attachments.find(
              (entry) => entry.name === "secret-holder",
            );
            const extensions = holder?.extensions ?? {};
            if (extensions["com.example.auth"] === "sk-abcdef1234567890") {
              return {
                outcome: "fail",
                reason: "a credential-shaped extension value crossed into the bundle",
                detail: String(extensions["com.example.auth"]),
              };
            }
            if (extensions["com.example.note"] !== "survives") {
              return {
                outcome: "fail",
                reason: "the scrub removed a benign extension value",
              };
            }
            return undefined;
          } finally {
            seeded.done();
          }
        } finally {
          state.done();
        }
      },
    },
    {
      id: "bundle.import-without-execution",
      area: "bundle",
      summary: "Import executes no recipe, admits no operation, and invalidates every handle.",
      async run(): Promise<ConformanceCaseAnswer | void> {
        const state = bench();
        try {
          const resourceId = await seedReconstructable(state);
          const root = exportTo(state);
          const { report, destination } = importFresh(state, root);

          // The reconstructable resource arrived invalidated, waiting
          // for an explicit flow; nothing executed on its behalf.
          const imported = report.resources.find((entry) => entry.id === resourceId);
          if (imported === undefined) {
            return {
              outcome: "fail",
              reason: "the reconstruct-mode resource did not travel with the bundle",
            };
          }
          if (imported.status !== "invalidated" || imported.invalidationReason === undefined) {
            return {
              outcome: "fail",
              reason: "an imported handle claims validity it never earned",
              detail: `${imported.status} / ${String(imported.invalidationReason)}`,
            };
          }
          if (!imported.invalidationReason.includes("reconstruct")) {
            return {
              outcome: "fail",
              reason: "the invalidation does not name reconstruction as its pending action",
              detail: imported.invalidationReason,
            };
          }
          if (destination.listOperationsBySession(report.sessionId).length !== 0) {
            return {
              outcome: "fail",
              reason: "import admitted operations, as if a recipe had executed",
            };
          }
          if (report.sessionId === state.sessionId) {
            return {
              outcome: "fail",
              reason: "import claimed the source session's identity",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "bundle.no-competing-controller",
      area: "bundle",
      summary: "A store holding the source session is never continued through a bundle.",
      async run(): Promise<ConformanceCaseAnswer | void> {
        const state = bench();
        try {
          const root = exportTo(state);
          const head = state.store.getWorkspaceHead(state.workspaceId);

          // The authoritative store refuses to continue itself by
          // import: a bundle holds no authority over its source.
          const refused = expectCode(
            () =>
              importBundle(
                state.store,
                { policyRef: "policy://conformance" },
                {
                  blobs: new BlobStore(state.directory(), state.store),
                  rootPath: root,
                  authority: LOCAL_AUTHORITY,
                },
              ),
            "InvalidRequest",
          );
          if (refused !== undefined) {
            return refused;
          }

          // A different store imports the same bundle as a new session,
          // and the source keeps its state untouched.
          const { report, destination } = importFresh(state, root);
          if (destination.getSession(report.sessionId) === null) {
            return { outcome: "fail", reason: "the imported session did not land" };
          }
          if (report.revisionId !== state.revisionId) {
            return {
              outcome: "fail",
              reason: "the import did not preserve the bundle's revision identity",
            };
          }
          const source = state.store.getSession(state.sessionId);
          if (source === null || state.store.getWorkspaceHead(state.workspaceId) !== head) {
            return {
              outcome: "fail",
              reason: "the import disturbed the source session",
            };
          }
          if (destination.getSession(state.sessionId) !== null) {
            return {
              outcome: "fail",
              reason: "the destination store also claims the source session",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
  ];
}
