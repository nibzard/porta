import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PolicyAuthority } from "../core/policy.js";
import { BlobStore } from "../store/blob-store.js";
import { ControlStore } from "../store/control-store.js";
import type { ResourceBindingRecord } from "../store/control-store.js";
import { checkpointWorkspace } from "./workspace.js";
import { bindResource } from "./resources.js";
import type { BindResourceInput, BindTransport, ResourceFlowOptions } from "./resources.js";
import { planReplace } from "./replacement.js";
import type { ReplaceRequest } from "../schema/handoff.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { BindingResult } from "../schema/adapter.js";

function isPortableCode(
  value: unknown,
): value is { code: string; message?: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
function refuse(
  run: () => unknown,
): { code: string; message?: string; details?: unknown } | null {
  try {
    run();
  } catch (error) {
    if (isPortableCode(error)) {
      return error;
    }
    throw error;
  }
  return null;
}

const AUTHORITY: ResourceFlowOptions = {
  authority: PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    operations: ["exec.process@1"],
  }),
};

/** A transport that always reports the reference bound unchanged. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource } satisfies BindingResult;
  },
};

/**
 * One session with a checkpointed revision and one active attachment
 * holding bound resources of every recovery mode.
 */
async function fixture(): Promise<{
  store: ControlStore;
  blobs: BlobStore;
  cleanup: () => void;
  sessionId: string;
  attachmentId: string;
  revisionId: string;
  workspaceId: string;
  ids: { reconstruct: string; reattach: string; native: string; none: string };
}> {
  const store = ControlStore.inMemory();
  const src = mkdtempSync(join(tmpdir(), "porta-plan-src-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-plan-blobs-"));
  const blobs = new BlobStore(blobRoot, store);
  const sessionId = `sess-${randomUUID()}`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId: `ws-${randomUUID()}`,
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: new Date().toISOString(),
  });
  writeFileSync(join(src, "app.txt"), "base");
  const checkpoint = checkpointWorkspace(
    store,
    sessionId,
    blobs,
    { requestKey: "import-1", source: { kind: "bridge", rootPath: src } },
    { stability: { kind: "locked" } },
  );
  const session = store.getSession(sessionId)!;
  const attachment: AttachmentSummary = {
    sessionId,
    attachmentId: `att-${randomUUID()}`,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  };
  store.insertAttachment(attachment);
  const input: Omit<BindResourceInput, "type" | "recovery"> = {
    owner: { sessionId, attachmentId: attachment.attachmentId, generation: 1 },
    capability: "exec.process@1",
    lifetime: "attachment",
  };
  const bind = async (type: string, recovery: BindResourceInput["recovery"]) =>
    (
      await bindResource(
        store,
        sessionId,
        { ...input, type, recovery },
        okTransport,
        AUTHORITY,
      )
    ).ref.id;
  const ids = {
    reconstruct: await bind("process.group", "reconstruct"),
    reattach: await bind("browser.session", "reattach"),
    native: await bind("interpreter.heap", "native"),
    none: await bind("socket", "none"),
  };
  return {
    store,
    blobs,
    cleanup: () => {
      rmSync(src, { recursive: true, force: true });
      rmSync(blobRoot, { recursive: true, force: true });
    },
    sessionId,
    attachmentId: attachment.attachmentId,
    revisionId: checkpoint.revision.id,
    workspaceId: session.workspaceId,
    ids,
  };
}

/** A replacement request over the fixture, overridable field by field. */
function request(
  parts: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<ReplaceRequest> = {},
): ReplaceRequest {
  return {
    source: {
      sessionId: parts.sessionId,
      attachmentId: parts.attachmentId,
      generation: 1,
    },
    destination: { requires: {} },
    workspaceRevisionId: parts.revisionId,
    requiredResources: [],
    reconstruct: [
      {
        id: "recipe-worker",
        inputRevisionId: parts.revisionId,
        requiredCapabilities: ["exec.process@1"],
        steps: [
          { capability: "exec.process@1", operation: "run", input: { command: "npm", args: ["ci"] } },
        ],
        outputs: [`process.group ${parts.ids.reconstruct}`],
        failureConditions: ["ProviderUnavailable"],
      },
    ],
    activeOperations: "reject",
    requestKey: "replace-1",
    ...overrides,
  };
}

test("planning reports every state class without provisioning anything", async () => {
  const parts = await fixture();
  try {
    const plan = planReplace(parts.store, request(parts));
    assert.equal(plan.sessionId, parts.sessionId);
    assert.equal(plan.attachmentId, parts.attachmentId);
    assert.equal(plan.sourceGeneration, 1);
    assert.equal(plan.workspaceRevisionId, parts.revisionId);
    assert.deepEqual(plan.blockers, []);

    // The workspace content is the portable state; it names its revision
    // and says the head does not move.
    assert.equal(plan.preserved.length, 1);
    assert.equal(plan.preserved[0]!.class, "portable");
    assert.equal(plan.preserved[0]!.action, "transfer");
    assert.match(plan.preserved[0]!.detail ?? "", /head does not move/);

    // Each recovery mode lands in its treatment bucket.
    assert.deepEqual(
      plan.reconstructed.map((entry) => entry.subject),
      [`process.group ${parts.ids.reconstruct}`],
    );
    assert.deepEqual(
      plan.reattached.map((entry) => entry.resourceId),
      [parts.ids.reattach],
    );
    // Native state and state with no restoration path invalidate; the
    // latter says so.
    assert.deepEqual(
      plan.invalidated.map((entry) => entry.resourceId).sort(),
      [parts.ids.native, parts.ids.none].sort(),
    );
    const none = plan.invalidated.find((entry) => entry.resourceId === parts.ids.none)!;
    assert.match(none.detail ?? "", /No restoration path/);
  } finally {
    parts.cleanup();
  }
});

test("stale sources and unknown revisions refuse before provisioning", async () => {
  const parts = await fixture();
  try {
    // A generation mismatch refuses with StaleHandle.
    const stale = refuse(() =>
      planReplace(
        parts.store,
        request(parts, { source: { sessionId: parts.sessionId, attachmentId: parts.attachmentId, generation: 2 } }),
      ),
    );
    assert.equal(stale?.code, "StaleHandle");

    // An attachment that does not exist refuses with StaleHandle.
    const missing = refuse(() =>
      planReplace(
        parts.store,
        request(parts, {
          source: { sessionId: parts.sessionId, attachmentId: "att-none", generation: 1 },
        }),
      ),
    );
    assert.equal(missing?.code, "StaleHandle");

    // A non-active attachment is not replaceable.
    const stored = parts.store.getAttachment(parts.attachmentId)!;
    parts.store.casAttachment(
      parts.attachmentId,
      { status: "active" },
      { ...stored, status: "releasing" },
    );
    const releasing = refuse(() => planReplace(parts.store, request(parts)));
    assert.equal(releasing?.code, "StaleHandle");
    parts.store.casAttachment(
      parts.attachmentId,
      { status: "releasing" },
      { ...stored, status: "active" },
    );

    // A revision of another workspace refuses.
    const foreign = refuse(() =>
      planReplace(parts.store, request(parts, { workspaceRevisionId: "rev-foreign" })),
    );
    assert.equal(foreign?.code, "InvalidRequest");

    // A destination pinning a different revision contradicts itself.
    const pinned = refuse(() =>
      planReplace(
        parts.store,
        request(parts, {
          destination: {
            requires: {},
            workspace: { revisionId: "rev-other", mode: "proposal" },
          },
        }),
      ),
    );
    assert.equal(pinned?.code, "InvalidRequest");

    // A malformed request and a malformed recipe refuse outright.
    const shapeless = refuse(() =>
      planReplace(parts.store, request(parts, { requestKey: "" })),
    );
    assert.equal(shapeless?.code, "InvalidRequest");
    const emptyRecipe = refuse(() =>
      planReplace(
        parts.store,
        request(parts, {
          reconstruct: [
            {
              id: "recipe-empty",
              inputRevisionId: parts.revisionId,
              requiredCapabilities: ["exec.process@1"],
              steps: [],
              outputs: [],
              failureConditions: ["ProviderUnavailable"],
            },
          ],
        }),
      ),
    );
    assert.equal(emptyRecipe?.code, "InvalidRequest");
  } finally {
    parts.cleanup();
  }
});

test("required resources and coverage gaps stand as blockers", async () => {
  const parts = await fixture();
  try {
    // A required resource the plan would invalidate blocks, and the
    // report still lists the full treatment.
    const required = planReplace(
      parts.store,
      request(parts, { requiredResources: [parts.ids.native] }),
    );
    assert.equal(required.blockers.length, 1);
    assert.equal(required.blockers[0]!.code, "RequirementUnsatisfied");
    assert.equal(
      (required.blockers[0]!.details as { resourceId?: string }).resourceId,
      parts.ids.native,
    );
    assert.equal(required.invalidated.length, 2);

    // A required resource the source does not hold blocks too.
    const absent = planReplace(
      parts.store,
      request(parts, { requiredResources: ["res-ghost"] }),
    );
    assert.equal(absent.blockers[0]!.code, "RequirementUnsatisfied");
    assert.equal(
      (absent.blockers[0]!.details as { reason?: string }).reason,
      "not-held",
    );

    // A reconstructable subject with no matching recipe output blocks.
    const uncovered = planReplace(parts.store, request(parts, { reconstruct: [] }));
    assert.equal(uncovered.blockers[0]!.code, "InvalidRequest");
    assert.match(uncovered.blockers[0]!.message, /no recipe output/);

    // A recipe pinned to another input revision blocks.
    const unpinned = planReplace(
      parts.store,
      request(parts, {
        reconstruct: [
          {
            id: "recipe-other-rev",
            inputRevisionId: "rev-older",
            requiredCapabilities: ["exec.process@1"],
            steps: [
              { capability: "exec.process@1", operation: "run", input: { command: "true" } },
            ],
            outputs: [`process.group ${parts.ids.reconstruct}`],
            failureConditions: ["ProviderUnavailable"],
          },
        ],
      }),
    );
    assert.equal(unpinned.blockers[0]!.code, "InvalidRequest");
    assert.match(unpinned.blockers[0]!.message, /pins input revision/);

    // Required resources that survive by design never block.
    const surviving = planReplace(
      parts.store,
      request(parts, { requiredResources: [parts.ids.reconstruct, parts.ids.reattach] }),
    );
    assert.deepEqual(surviving.blockers, []);
  } finally {
    parts.cleanup();
  }
});

test("planning changes nothing: no allocation, no head move, no journal", async () => {
  const parts = await fixture();
  try {
    const eventsBefore = parts.store.listEvents(parts.sessionId, 0).length;
    const headBefore = parts.store.getWorkspaceHead(parts.workspaceId);
    const attachmentBefore = parts.store.getAttachment(parts.attachmentId);
    const bindingsBefore = parts.store
      .listResourceBindingsForOwner(parts.sessionId, parts.attachmentId, 1, false)
      .map((record: ResourceBindingRecord) => [record.id, record.status] as const);

    // A clean plan and a blocked plan both leave the store untouched.
    planReplace(parts.store, request(parts));
    planReplace(parts.store, request(parts, { requiredResources: [parts.ids.native] }));

    assert.equal(parts.store.listEvents(parts.sessionId, 0).length, eventsBefore);
    assert.equal(parts.store.getWorkspaceHead(parts.workspaceId), headBefore);
    assert.deepEqual(parts.store.getAttachment(parts.attachmentId), attachmentBefore);
    assert.deepEqual(
      parts.store
        .listResourceBindingsForOwner(parts.sessionId, parts.attachmentId, 1, false)
        .map((record: ResourceBindingRecord) => [record.id, record.status] as const),
      bindingsBefore,
    );
  } finally {
    parts.cleanup();
  }
});
