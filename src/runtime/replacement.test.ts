import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PolicyAuthority } from "../core/policy.js";
import { providerUnavailableError } from "../core/errors.js";
import { BlobStore } from "../store/blob-store.js";
import { ControlStore } from "../store/control-store.js";
import { StoreError } from "../store/control-store.js";
import type { ResourceBindingRecord } from "../store/control-store.js";
import { checkpointWorkspace } from "./workspace.js";
import { bindResource } from "./resources.js";
import type { BindResourceInput, BindTransport, ResourceFlowOptions } from "./resources.js";
import { admitInvocation } from "./admission.js";
import { markOperationDispatched, settleOperation } from "./outcomes.js";
import {
  checkpointReplacement,
  planReplace,
  prepareReplacement,
} from "./replacement.js";
import type { PrepareOptions } from "./replacement.js";
import type { ReplaceRequest } from "../schema/handoff.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { BindingResult, CancellationResult } from "../schema/adapter.js";
import type { InvocationRequest } from "../schema/operation.js";

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
async function refuse(
  run: () => unknown,
): Promise<{ code: string; message?: string; details?: unknown } | null> {
  try {
    await run();
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
    // The destination materializes a local working copy.
    transferDestinations: ["local"],
  }),
};

/** A transport that always reports the reference bound unchanged. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource } satisfies BindingResult;
  },
};

/** The shape one seeded fixture returns. */
interface Fixture {
  store: ControlStore;
  blobs: BlobStore;
  cleanup: () => void;
  sessionId: string;
  attachmentId: string;
  revisionId: string;
  workspaceId: string;
  ids: { reconstruct: string; reattach: string; native: string; none: string };
}

/**
 * Seed one session with a checkpointed revision and one active
 * attachment holding bound resources of every recovery mode, on the
 * given store.
 */
async function seedOn(store: ControlStore): Promise<Fixture> {
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

/** One seeded fixture on a fresh in-memory store. */
async function fixture(): Promise<Fixture> {
  return seedOn(ControlStore.inMemory());
}

/** A replacement request over the fixture, overridable field by field. */
function request(parts: Fixture, overrides: Partial<ReplaceRequest> = {}): ReplaceRequest {
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
    const stale = await refuse(() =>
      planReplace(
        parts.store,
        request(parts, { source: { sessionId: parts.sessionId, attachmentId: parts.attachmentId, generation: 2 } }),
      ),
    );
    assert.equal(stale?.code, "StaleHandle");

    // An attachment that does not exist refuses with StaleHandle.
    const missing = await refuse(() =>
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
    const releasing = await refuse(() => planReplace(parts.store, request(parts)));
    assert.equal(releasing?.code, "StaleHandle");
    parts.store.casAttachment(
      parts.attachmentId,
      { status: "releasing" },
      { ...stored, status: "active" },
    );

    // A revision of another workspace refuses.
    const foreign = await refuse(() =>
      planReplace(parts.store, request(parts, { workspaceRevisionId: "rev-foreign" })),
    );
    assert.equal(foreign?.code, "InvalidRequest");

    // A destination pinning a different revision contradicts itself.
    const pinned = await refuse(() =>
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
    const shapeless = await refuse(() =>
      planReplace(parts.store, request(parts, { requestKey: "" })),
    );
    assert.equal(shapeless?.code, "InvalidRequest");
    const emptyRecipe = await refuse(() =>
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

/** Admit one process operation on the fixture's attachment, dispatched. */
async function runningOperation(
  parts: Awaited<ReturnType<typeof fixture>>,
  requestKey: string,
): Promise<string> {
  const invocation: InvocationRequest = {
    attachment: {
      sessionId: parts.sessionId,
      attachmentId: parts.attachmentId,
      generation: 1,
    },
    capability: "exec.process@1",
    operation: "run",
    input: { command: "sleep", args: ["600"] },
    requestKey,
  };
  const admitted = admitInvocation(parts.store, parts.sessionId, invocation, {
    authority: AUTHORITY.authority,
  });
  markOperationDispatched(parts.store, parts.sessionId, admitted.operation.id);
  return admitted.operation.id;
}

test("wait, cancel, and reject handle active operations explicitly", async () => {
  const seeded: Fixture[] = [];
  const fresh = async (): Promise<Fixture> => {
    const parts = await seedOn(ControlStore.inMemory());
    seeded.push(parts);
    return parts;
  };
  try {
    // Reject: one running operation blocks, and the source is quiesced.
    const rejectParts = await fresh();
    const opReject = await runningOperation(rejectParts, "op-reject-1");
    const rejected = await prepareReplacement(rejectParts.store, request(rejectParts));
    assert.equal(rejected.state, "blocked");
    assert.equal(rejected.policy, "reject");
    assert.equal(rejected.blockers.length, 1);
    assert.equal(rejected.blockers[0]!.code, "HandoffBlocked");
    assert.equal(
      (rejected.blockers[0]!.details as { operationId?: string }).operationId,
      opReject,
    );
    assert.equal(rejected.quiesced.length, 1);
    assert.equal(rejectParts.store.getAttachment(rejectParts.attachmentId)!.status, "replacing");
    assert.equal(rejectParts.store.getTransition(rejected.transitionId)!.phase, "blocked");

    // Quiescence is real: a new admission refuses while replacing.
    const refused = await refuse(() =>
      admitInvocation(
        rejectParts.store,
        rejectParts.sessionId,
        {
          attachment: {
            sessionId: rejectParts.sessionId,
            attachmentId: rejectParts.attachmentId,
            generation: 1,
          },
          capability: "exec.process@1",
          operation: "run",
          input: { command: "true" },
          requestKey: "op-late-1",
        },
        { authority: AUTHORITY.authority },
      ),
    );
    assert.equal(refused?.code, "InvalidRequest");
    assert.equal(
      (refused?.details as { reason?: string }).reason,
      "attachment-replacing",
    );
    // The blocked operation itself is untouched: the policy only reports.
    assert.equal(rejectParts.store.getOperation(opReject)!.status, "running");

    // Cancel: a confirmed stop settles the operation and prepares.
    const cancelParts = await fresh();
    const opCancel = await runningOperation(cancelParts, "op-cancel-1");
    const confirmedTransport = {
      async cancel(): Promise<CancellationResult> {
        return { outcome: "confirmed", stopped: true };
      },
    };
    const cancelled = await prepareReplacement(
      cancelParts.store,
      request(cancelParts, { activeOperations: "cancel" }),
      { cancel: confirmedTransport },
    );
    assert.equal(cancelled.state, "prepared");
    assert.deepEqual(cancelled.blockers, []);
    assert.deepEqual(
      cancelled.resolved.map((operation) => operation.status),
      ["cancelled"],
    );
    assert.equal(cancelParts.store.getOperation(opCancel)!.status, "cancelled");

    // Cancel without a transport refuses before anything changes.
    const cancellessParts = await fresh();
    const cancelless = await refuse(() =>
      prepareReplacement(
        cancellessParts.store,
        request(cancellessParts, { activeOperations: "cancel" }),
      ),
    );
    assert.equal(cancelless?.code, "InvalidRequest");
    assert.equal(
      cancellessParts.store.getAttachment(cancellessParts.attachmentId)!.status,
      "active",
    );

    // Wait: a settled operation is no longer active, so nothing blocks.
    const waitParts = await fresh();
    const opWait = await runningOperation(waitParts, "op-wait-1");
    settleOperation(waitParts.store, waitParts.sessionId, opWait, {
      kind: "completed",
      resultRef: "blob://done",
    });
    const waited = await prepareReplacement(
      waitParts.store,
      request(waitParts, { activeOperations: "wait" }),
    );
    assert.equal(waited.state, "prepared");
    assert.deepEqual(waited.quiesced, []);

    // Wait: a deadline passing with work still running blocks, and
    // never bypasses the unresolved operation.
    const timedParts = await fresh();
    const opStuck = await runningOperation(timedParts, "op-wait-2");
    const timed = await prepareReplacement(
      timedParts.store,
      request(timedParts, { activeOperations: "wait" }),
      { waitMs: 10, pollIntervalMs: 2 },
    );
    assert.equal(timed.state, "blocked");
    assert.equal(
      (timed.blockers[0]!.details as { reason?: string }).reason,
      "wait-deadline-passed",
    );
    assert.equal(timedParts.store.getOperation(opStuck)!.status, "running");
  } finally {
    for (const parts of seeded) {
      parts.cleanup();
    }
  }
});

test("unknown outcomes block replacement under every policy", async () => {
  const parts = await fixture();
  try {
    // An operation lost mid-flight settles as unknown.
    const opLost = await runningOperation(parts, "op-lost-1");
    settleOperation(parts.store, parts.sessionId, opLost, {
      kind: "unknown",
      error: { code: "OperationUnknown", message: "The response was lost.", retry: "after-reconciliation" },
    });

    // Waiting treats unknown as settled, yet preparation still blocks.
    const waited = await prepareReplacement(
      parts.store,
      request(parts, { activeOperations: "wait" }),
      { waitMs: 10 },
    );
    assert.equal(waited.state, "blocked");
    assert.equal(
      (waited.blockers[0]!.details as { reason?: string }).reason,
      "unknown-outcome",
    );

    // Cancelling cannot resolve uncertainty either.
    const cancelStore = ControlStore.inMemory();
    const cancelParts = await seedOn(cancelStore);
    const opLost2 = await runningOperation(cancelParts, "op-lost-2");
    settleOperation(cancelStore, cancelParts.sessionId, opLost2, {
      kind: "unknown",
      error: { code: "OperationUnknown", message: "The response was lost.", retry: "after-reconciliation" },
    });
    const cancelled = await prepareReplacement(
      cancelStore,
      request(cancelParts, { activeOperations: "cancel" }),
      {
        cancel: {
          async cancel(): Promise<CancellationResult> {
            return { outcome: "confirmed", stopped: true };
          },
        },
      },
    );
    assert.equal(cancelled.state, "blocked");
    assert.equal(
      (cancelled.blockers[0]!.details as { reason?: string }).reason,
      "unknown-outcome",
    );
  } finally {
    parts.cleanup();
  }
});

test("a blocked plan refuses preparation before the source is touched", async () => {
  const parts = await fixture();
  try {
    const refused = await refuse(() =>
      prepareReplacement(
        parts.store,
        request(parts, { requiredResources: [parts.ids.native] }),
      ),
    );
    assert.equal(refused?.code, "HandoffBlocked");
    // Nothing was quiesced for a plan that cannot proceed.
    assert.equal(parts.store.getAttachment(parts.attachmentId)!.status, "active");
    assert.deepEqual(
      parts.store.listEvents(parts.sessionId, 0).filter(
        (event) => event.type === "handoff.updated",
      ),
      [],
    );

    // A clean preparation persists the durable transition.
    const report = await prepareReplacement(parts.store, request(parts));
    assert.equal(report.state, "prepared");
    const transition = parts.store.getTransition(report.transitionId)!;
    assert.equal(transition.phase, "prepared");
    assert.equal(transition.sessionId, parts.sessionId);
    assert.equal(transition.data.requestKey, "replace-1");
    assert.equal(transition.data.workspaceRevisionId, parts.revisionId);
    const plan = transition.data.plan as { invalidated: string[] };
    assert.equal(plan.invalidated.length, 2);
    assert.ok(
      parts.store.listEvents(parts.sessionId, 0).some(
        (event) =>
          event.type === "handoff.updated" && event.subjectId === report.transitionId,
      ),
      "the preparation step is journaled",
    );
  } finally {
    parts.cleanup();
  }
});

test("managed writers stop or declare a consistent snapshot before checkpointing", async () => {
  const parts = await fixture();
  try {
    // A clean checkpoint fences writers behind one rising token.
    const report = await prepareReplacement(parts.store, request(parts));
    const checkpoint = checkpointReplacement(parts.store, report.transitionId);
    assert.equal(checkpoint.workspaceRevisionId, parts.revisionId);
    assert.equal(checkpoint.sourceGeneration, 1);
    assert.equal(checkpoint.consistency.kind, "writers-stopped");
    assert.ok(checkpoint.consistency.fencingToken >= 1);
    assert.equal(checkpoint.inventory, 4);
    const transition = parts.store.getTransition(report.transitionId)!;
    assert.equal(transition.phase, "checkpointed");
    assert.equal(transition.data.fencingToken, checkpoint.consistency.fencingToken);
    assert.equal(
      (transition.data.inventory as Array<{ status: string }>).length,
      4,
    );
    // The checkpoint holds the lease: a managed writer cannot start.
    let leaseError: unknown = null;
    try {
      parts.store.acquireMutationLease(
        parts.sessionId,
        parts.attachmentId,
        "writer",
        60_000,
      );
    } catch (error) {
      leaseError = error;
    }
    assert.ok(leaseError instanceof StoreError, "the writer's lease request refuses");
    assert.equal(leaseError.kind, "lease-held");

    // A writer that still holds the lease blocks the checkpoint.
    const heldStore = ControlStore.inMemory();
    const heldParts = await seedOn(heldStore);
    const heldReport = await prepareReplacement(heldStore, request(heldParts));
    heldStore.acquireMutationLease(
      heldParts.sessionId,
      heldParts.attachmentId,
      "writer-x",
      60_000,
    );
    const blocked = await refuse(() =>
      Promise.resolve(
        checkpointReplacement(heldStore, heldReport.transitionId),
      ),
    );
    assert.equal(blocked?.code, "HandoffBlocked");
    assert.equal(
      (blocked?.details as { reason?: string }).reason,
      "mutation-lease-held",
    );

    // A declared snapshot with an explicit contract stands in for the
    // stop, and records who still writes.
    const snapshot = await refuse(() =>
      Promise.resolve(
        checkpointReplacement(heldStore, heldReport.transitionId, {
          snapshot: { consistencyContract: "" },
        }),
      ),
    );
    assert.equal(snapshot?.code, "InvalidRequest");
    const snapshotted = checkpointReplacement(heldStore, heldReport.transitionId, {
      snapshot: {
        consistencyContract: "Crash-consistent point-in-time volume snapshot.",
        scope: "volume /home/user/portable",
      },
    });
    assert.equal(snapshotted.consistency.kind, "provider-snapshot");
    assert.equal(snapshotted.consistency.heldBy, "writer-x");
    assert.ok(snapshotted.consistency.fencingToken >= 1);

    // Only a prepared transition checkpoints.
    const freshStore = ControlStore.inMemory();
    const freshParts = await seedOn(freshStore);
    const unprepared = await refuse(() =>
      Promise.resolve(checkpointReplacement(freshStore, "tr-none")),
    );
    assert.equal(unprepared?.code, "InvalidRequest");
  } finally {
    parts.cleanup();
  }
});

// -- Destination preparation (SPEC.md section 13.2, phases 3 to 5) ------------

import { prepareDestination, verifyWorkingCopyIntegrity } from "./replacement.js";
import { attachEnvironment } from "./acquisition.js";
import { FakeEnvironmentAdapter } from "../adapters/test-adapter.js";

/** Options of one destination preparation call over the fixture. */
function destinationOptions(
  parts: Fixture,
  adapter: FakeEnvironmentAdapter,
  copyRoot: string,
): Parameters<typeof prepareDestination>[2] {
  return {
    adapter,
    leaseOf: (environmentId) => Promise.resolve(adapter.lease(environmentId)),
    bind: okTransport,
    blobs: parts.blobs,
    copyRoot,
    principal: "tester",
    authority: AUTHORITY.authority,
  };
}

test("destination preparation validates the candidate and leaves source authority alone", async () => {
  const parts = await fixture();
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-dest-"));
  try {
    const adapter = new FakeEnvironmentAdapter();
    const prepared = await prepareReplacement(parts.store, request(parts));
    checkpointReplacement(parts.store, prepared.transitionId);

    const report = await prepareDestination(
      parts.store,
      prepared.transitionId,
      destinationOptions(parts, adapter, copyRoot),
    );
    assert.equal(report.state, "validated");
    assert.ok(report.candidateAttachmentId !== parts.attachmentId);
    assert.ok(report.environmentId.length > 0);
    assert.deepEqual(report.validation, {
      manifest: true,
      satisfies: true,
      revisionIntegrity: true,
      requiredResources: true,
    });

    // The declared recipe ran to completion and is recorded.
    assert.deepEqual(
      report.reconstruction.map((run) => [run.recipeId, run.outcome]),
      [["recipe-worker", "completed"]],
    );

    // Reconstructable and reattachable state hold candidate bindings
    // under the candidate attachment; native state holds none.
    assert.deepEqual(
      report.candidates.map((candidate) => candidate.ofResourceId).sort(),
      [parts.ids.reconstruct, parts.ids.reattach].sort(),
    );
    for (const candidate of report.candidates) {
      const binding = parts.store.getResourceBinding(parts.sessionId, candidate.resourceId)!;
      assert.equal(binding.owner.attachmentId, report.candidateAttachmentId);
      assert.equal(binding.owner.generation, 1);
      assert.equal(binding.status, "bound");
      assert.equal(binding.recovery, candidate.recovery);
    }

    // Source authority is unchanged: the source attachment stays
    // quiesced at its generation, and every source binding stays bound.
    const source = parts.store.getAttachment(parts.attachmentId)!;
    assert.equal(source.status, "replacing");
    assert.equal(source.generation, 1);
    for (const id of [parts.ids.reconstruct, parts.ids.reattach, parts.ids.native, parts.ids.none]) {
      assert.equal(parts.store.getResourceBinding(parts.sessionId, id)!.status, "bound");
    }
    // The transfer revision is still the durable record; no new one.
    assert.equal(
      parts.store.getWorkingCopy(report.copyId)!.baseRevisionId,
      parts.revisionId,
    );
    assert.equal(parts.store.getTransition(prepared.transitionId)!.phase, "validated");
    // The recipe step settled durably under its deterministic identity.
    assert.equal(
      parts.store.getOperationByRequestKey(parts.sessionId, "recipe-worker:step-0")!.status,
      "completed",
    );

    // A repeated call over a validated transition returns the record.
    const again = await prepareDestination(
      parts.store,
      prepared.transitionId,
      destinationOptions(parts, adapter, copyRoot),
    );
    assert.equal(again.state, "validated");
    assert.equal(again.candidateAttachmentId, report.candidateAttachmentId);
    assert.equal(again.copyId, report.copyId);

    // Only the source and the one candidate exist; nothing doubled.
    assert.equal(parts.store.listAttachments(parts.sessionId).length, 2);
  } finally {
    parts.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test("an interrupted preparation reconciles one acquisition and adopts recorded steps", async () => {
  const parts = await fixture();
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-dest-2-"));
  try {
    const adapter = new FakeEnvironmentAdapter();
    const prepared = await prepareReplacement(parts.store, request(parts));
    const transitionId = prepared.transitionId;
    checkpointReplacement(parts.store, transitionId);

    // Simulate a crash after the acquire landed but before the
    // transition recorded it: the acquisition exists under the
    // transition's own request identity, the phase never moved past
    // provisioning, and nothing was recorded.
    const acquired = await attachEnvironment(parts.store, parts.sessionId, "policy://test", {
      adapter,
      request: { name: `worker_${transitionId}`.slice(0, 63), requires: {} },
      requestKey: `replace:${transitionId}`,
      principal: "tester",
      authority: AUTHORITY.authority,
    });
    const record = parts.store.getTransition(transitionId)!;
    parts.store.casTransition(transitionId, { phase: "checkpointed" }, {
      ...record,
      phase: "provisioning",
      updatedAt: new Date().toISOString(),
    });

    // The resumed call adopts that acquisition; it allocates nothing.
    const resumed = await prepareDestination(
      parts.store,
      transitionId,
      destinationOptions(parts, adapter, copyRoot),
    );
    assert.equal(resumed.state, "validated");
    assert.equal(resumed.candidateAttachmentId, acquired.attachmentId);
    assert.equal(parts.store.listAttachments(parts.sessionId).length, 2);

    // Simulate a crash mid-recipe: the step settled, the run never
    // recorded. The rerun adopts the recorded operation instead of
    // dispatching again, so a queued failure directive is never spent.
    adapter.queueInvoke({
      kind: "fail",
      error: providerUnavailableError("The environment provider failed."),
    });
    const settled = parts.store.getTransition(transitionId)!;
    const { reconstruction: _drop, ...carried } = settled.data as Record<string, unknown>;
    void _drop;
    parts.store.casTransition(transitionId, { phase: "validated" }, {
      ...settled,
      phase: "materialized",
      data: carried,
      updatedAt: new Date().toISOString(),
    });
    const rerun = await prepareDestination(
      parts.store,
      transitionId,
      destinationOptions(parts, adapter, copyRoot),
    );
    assert.equal(rerun.state, "validated");
    assert.deepEqual(
      rerun.reconstruction.map((run) => run.outcome),
      ["completed"],
    );
    assert.equal(adapter.queues.invoke.length, 1, "the queued failure was never dispatched");
    assert.equal(parts.store.listAttachments(parts.sessionId).length, 2);
  } finally {
    parts.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test("a failing recipe fails the transition and never touches the source", async () => {
  const parts = await fixture();
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-dest-3-"));
  try {
    const adapter = new FakeEnvironmentAdapter();
    adapter.queueInvoke({
      kind: "fail",
      error: providerUnavailableError("The environment provider failed."),
    });
    const prepared = await prepareReplacement(parts.store, request(parts));
    checkpointReplacement(parts.store, prepared.transitionId);

    const report = await prepareDestination(
      parts.store,
      prepared.transitionId,
      destinationOptions(parts, adapter, copyRoot),
    );
    assert.equal(report.state, "failed");
    // The report carries the refusal; the transition records the root
    // cause beside the failed run.
    assert.equal(report.error?.code, "HandoffBlocked");
    assert.equal(
      (report.error?.details as { reason?: string }).reason,
      "ProviderUnavailable",
    );
    assert.equal(report.reconstruction[0]!.failureCondition, "ProviderUnavailable");
    const transition = parts.store.getTransition(prepared.transitionId)!;
    assert.equal(transition.phase, "failed");
    assert.equal((transition.data.error as { code?: string }).code, "ProviderUnavailable");
    // The source stays exactly as the checkpoint left it.
    assert.equal(parts.store.getAttachment(parts.attachmentId)!.status, "replacing");
    for (const id of [parts.ids.reconstruct, parts.ids.reattach, parts.ids.native, parts.ids.none]) {
      assert.equal(parts.store.getResourceBinding(parts.sessionId, id)!.status, "bound");
    }
    // The failed step is not lost: it settled durably.
    assert.equal(
      parts.store.getOperationByRequestKey(parts.sessionId, "recipe-worker:step-0")!.status,
      "failed",
    );

    // A transition that never checkpointed refuses outright.
    const fresh = await fixture();
    try {
      const other = await prepareReplacement(fresh.store, request(fresh));
      const refused = await refuse(() =>
        prepareDestination(
          fresh.store,
          other.transitionId,
          destinationOptions(fresh, new FakeEnvironmentAdapter(), copyRoot),
        ),
      );
      assert.equal(refused?.code, "InvalidRequest");
    } finally {
      fresh.cleanup();
    }
  } finally {
    parts.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test("working-copy integrity refuses any content that drifted from the revision", async () => {
  const parts = await fixture();
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-dest-4-"));
  try {
    const adapter = new FakeEnvironmentAdapter();
    const prepared = await prepareReplacement(parts.store, request(parts));
    checkpointReplacement(parts.store, prepared.transitionId);
    const report = await prepareDestination(
      parts.store,
      prepared.transitionId,
      destinationOptions(parts, adapter, copyRoot),
    );
    assert.equal(report.state, "validated");

    // The pristine copy verifies and returns the revision root.
    const root = verifyWorkingCopyIntegrity(parts.store, parts.blobs, copyRoot, parts.revisionId);
    assert.equal(root.length > 0, true);

    // A file that appeared refuses.
    writeFileSync(join(copyRoot, "evil.txt"), "tampered");
    const appeared = await refuse(() =>
      Promise.resolve(
        verifyWorkingCopyIntegrity(parts.store, parts.blobs, copyRoot, parts.revisionId),
      ),
    );
    assert.equal(appeared?.code, "IntegrityFailure");

    // A file that changed refuses too.
    rmSync(join(copyRoot, "evil.txt"));
    writeFileSync(join(copyRoot, "app.txt"), "drifted");
    const changed = await refuse(() =>
      Promise.resolve(
        verifyWorkingCopyIntegrity(parts.store, parts.blobs, copyRoot, parts.revisionId),
      ),
    );
    assert.equal(changed?.code, "IntegrityFailure");

    // An absent revision refuses as an integrity failure, not a crash.
    const absent = await refuse(() =>
      Promise.resolve(
        verifyWorkingCopyIntegrity(parts.store, parts.blobs, copyRoot, "rev-none"),
      ),
    );
    assert.equal(absent?.code, "IntegrityFailure");
  } finally {
    parts.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

// -- Switch transaction (SPEC.md section 13.3) --------------------------------

import { switchReplacement } from "./replacement.js";

/** Run the full pipeline to a validated destination transition. */
async function validatedTransition(
  parts: Fixture,
  adapter: FakeEnvironmentAdapter,
  copyRoot: string,
): Promise<{ transitionId: string; candidateAttachmentId: string; environmentId: string }> {
  const prepared = await prepareReplacement(parts.store, request(parts));
  checkpointReplacement(parts.store, prepared.transitionId);
  const destination = await prepareDestination(
    parts.store,
    prepared.transitionId,
    destinationOptions(parts, adapter, copyRoot),
  );
  assert.equal(destination.state, "validated");
  return {
    transitionId: prepared.transitionId,
    candidateAttachmentId: destination.candidateAttachmentId,
    environmentId: destination.environmentId,
  };
}

test("the switch commits generation, bindings, and obligations together", async () => {
  const parts = await fixture();
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-sw-1-"));
  try {
    const adapter = new FakeEnvironmentAdapter();
    const { transitionId, candidateAttachmentId, environmentId } = await validatedTransition(
      parts,
      adapter,
      copyRoot,
    );

    // An unrelated attachment and the workspace head must not move.
    parts.store.insertAttachment({
      sessionId: parts.sessionId,
      attachmentId: "att-bystander",
      name: "bystander",
      generation: 3,
      status: "active",
      capabilityIds: ["exec.process@1"],
    });
    const headBefore = parts.store.getWorkspaceHead(parts.workspaceId);

    const report = switchReplacement(parts.store, transitionId);
    assert.equal(report.oldGeneration, 1);
    assert.equal(report.newGeneration, 2);
    assert.equal(report.environmentId, environmentId);
    assert.equal(report.cleanup.length, 1);
    assert.equal(report.cleanup[0]!.kind, "release");

    // The target attachment continues at generation 2 on the new
    // environment, under its own name.
    const switched = parts.store.getAttachment(parts.attachmentId)!;
    assert.equal(switched.status, "active");
    assert.equal(switched.generation, 2);
    assert.equal(switched.environmentId, environmentId);
    assert.equal(switched.name, "worker");

    // The candidate record retired and records where it went.
    const candidate = parts.store.getAttachment(candidateAttachmentId)!;
    assert.equal(candidate.status, "released");
    assert.equal(candidate.extensions?.["portable.runtime.merged-into"], parts.attachmentId);

    // Every source-generation handle died; the candidates live on,
    // by unchanged identity, under generation 2.
    for (const id of [parts.ids.reconstruct, parts.ids.reattach, parts.ids.native, parts.ids.none]) {
      assert.equal(parts.store.getResourceBinding(parts.sessionId, id)!.status, "invalidated");
    }
    assert.equal(report.invalidatedResourceIds.length, 4);
    const adopted = report.adoptedResourceIds;
    assert.equal(adopted.length, 2);
    for (const resourceId of adopted) {
      const binding = parts.store.getResourceBinding(parts.sessionId, resourceId)!;
      assert.equal(binding.status, "bound");
      assert.equal(binding.owner.attachmentId, parts.attachmentId);
      assert.equal(binding.owner.generation, 2);
    }

    // The fence dropped with the commit: a writer may lease afresh.
    const lease = parts.store.getMutationLease(parts.sessionId, parts.attachmentId);
    assert.notEqual(lease?.releasedAt, undefined);
    parts.store.acquireMutationLease(parts.sessionId, parts.attachmentId, "writer-next", 60_000);

    // The transition and its journal carry the outcome.
    const transition = parts.store.getTransition(transitionId)!;
    assert.equal(transition.phase, "switched");
    const events = parts.store
      .listEvents(parts.sessionId, 0)
      .filter((event) => event.subjectId === transitionId);
    const switchedEvent = events.find(
      (event) => event.type === "handoff.updated" && event.data.phase === "switched",
    )!;
    assert.equal(switchedEvent.data.phase, "switched");
    assert.equal(switchedEvent.data.outcome, "completed");
    assert.equal(switchedEvent.data.oldGeneration, 1);
    assert.equal(switchedEvent.data.newGeneration, 2);
    assert.ok(
      parts.store
        .listEvents(parts.sessionId, 0)
        .some((event) => event.type === "cleanup.pending"),
      "the cleanup obligation is journaled",
    );

    // Nothing else moved.
    const bystander = parts.store.getAttachment("att-bystander")!;
    assert.equal(bystander.generation, 3);
    assert.equal(bystander.status, "active");
    assert.equal(parts.store.getWorkspaceHead(parts.workspaceId), headBefore);

    // A repeated call returns the committed result, not a second switch.
    const repeated = switchReplacement(parts.store, transitionId);
    assert.equal(repeated.newGeneration, 2);
    assert.deepEqual(repeated.adoptedResourceIds, adopted);
    assert.equal(parts.store.getAttachment(parts.attachmentId)!.generation, 2);
    assert.equal(
      parts.store.getResourceBinding(parts.sessionId, adopted[0]!)!.owner.generation,
      2,
    );
  } finally {
    parts.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test("the switch validates generation, fence, and destination state", async () => {
  const parts = await fixture();
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-sw-2-"));
  try {
    // A stale source generation refuses before anything moves.
    const staleAdapter = new FakeEnvironmentAdapter();
    const stale = await validatedTransition(parts, staleAdapter, copyRoot);
    const stored = parts.store.getAttachment(parts.attachmentId)!;
    parts.store.casAttachment(
      parts.attachmentId,
      { status: "replacing", generation: 1 },
      { ...stored, generation: 2 },
    );
    const staleRefusal = await refuse(() =>
      Promise.resolve(switchReplacement(parts.store, stale.transitionId)),
    );
    assert.equal(staleRefusal?.code, "StaleHandle");
    parts.store.casAttachment(
      parts.attachmentId,
      { status: "replacing", generation: 2 },
      { ...stored, generation: 1 },
    );

    // A released or superseded fence refuses: the checkpoint's proof
    // of quiescence is gone.
    const fenceStore = ControlStore.inMemory();
    const fenceParts = await seedOn(fenceStore);
    const fenceRoot = mkdtempSync(join(tmpdir(), "porta-sw-2b-"));
    const fence = await validatedTransition(
      fenceParts,
      new FakeEnvironmentAdapter(),
      fenceRoot,
    );
    const token = fenceStore.getTransition(fence.transitionId)!.data.fencingToken as number;
    fenceStore.releaseMutationLease(fenceParts.sessionId, fenceParts.attachmentId, token);
    const releasedRefusal = await refuse(() =>
      Promise.resolve(switchReplacement(fenceStore, fence.transitionId)),
    );
    assert.equal(releasedRefusal?.code, "StaleHandle");
    // A writer who re-leased after the release is just as refusing.
    fenceStore.acquireMutationLease(
      fenceParts.sessionId,
      fenceParts.attachmentId,
      "writer-x",
      60_000,
    );
    const supersededRefusal = await refuse(() =>
      Promise.resolve(switchReplacement(fenceStore, fence.transitionId)),
    );
    assert.equal(supersededRefusal?.code, "StaleHandle");
    rmSync(fenceRoot, { recursive: true, force: true });

    // A transition that never validated refuses.
    const earlyStore = ControlStore.inMemory();
    const earlyParts = await seedOn(earlyStore);
    try {
      const early = await prepareReplacement(earlyStore, request(earlyParts));
      checkpointReplacement(earlyStore, early.transitionId);
      const earlyRefusal = await refuse(() =>
        Promise.resolve(switchReplacement(earlyStore, early.transitionId)),
      );
      assert.equal(earlyRefusal?.code, "InvalidRequest");
    } finally {
      earlyParts.cleanup();
    }

    // A fabricated validated phase without the validation record
    // refuses: the destination state must be proven, not asserted.
    const fabricatedStore = ControlStore.inMemory();
    const fabricatedParts = await seedOn(fabricatedStore);
    try {
      const fabricated = await prepareReplacement(fabricatedStore, request(fabricatedParts));
      checkpointReplacement(fabricatedStore, fabricated.transitionId);
      // A live candidate exists, but no validation record backs it.
      fabricatedStore.insertAttachment({
        sessionId: fabricatedParts.sessionId,
        attachmentId: "att-fake-candidate",
        name: "fake-candidate",
        generation: 1,
        status: "active",
        capabilityIds: ["exec.process@1"],
        environmentId: "env-fake",
      });
      const record = fabricatedStore.getTransition(fabricated.transitionId)!;
      fabricatedStore.casTransition(fabricated.transitionId, { phase: "checkpointed" }, {
        ...record,
        phase: "validated",
        data: {
          ...record.data,
          candidateAttachmentId: "att-fake-candidate",
          environmentId: "env-fake",
        },
        updatedAt: new Date().toISOString(),
      });
      const fabricatedRefusal = await refuse(() =>
        Promise.resolve(switchReplacement(fabricatedStore, fabricated.transitionId)),
      );
      assert.equal(fabricatedRefusal?.code, "HandoffBlocked");
      assert.equal(
        (fabricatedRefusal?.details as { reason?: string }).reason,
        "destination-not-validated",
      );
    } finally {
      fabricatedParts.cleanup();
    }

    // A dead candidate refuses.
    const deadAdapter = new FakeEnvironmentAdapter();
    const deadRoot = mkdtempSync(join(tmpdir(), "porta-sw-2c-"));
    const deadParts = await seedOn(ControlStore.inMemory());
    const dead = await validatedTransition(deadParts, deadAdapter, deadRoot);
    const candidate = deadParts.store.getAttachment(dead.candidateAttachmentId)!;
    deadParts.store.casAttachment(
      dead.candidateAttachmentId,
      { status: "active", generation: candidate.generation },
      { ...candidate, status: "unavailable" },
    );
    const deadRefusal = await refuse(() =>
      Promise.resolve(switchReplacement(deadParts.store, dead.transitionId)),
    );
    assert.equal(deadRefusal?.code, "StaleHandle");
    rmSync(deadRoot, { recursive: true, force: true });
  } finally {
    parts.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test("a store refusal mid-switch rolls the whole transaction back", async () => {
  const parts = await fixture();
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-sw-3-"));
  try {
    const adapter = new FakeEnvironmentAdapter();
    const { transitionId } = await validatedTransition(parts, adapter, copyRoot);
    const eventsBefore = parts.store.listEvents(parts.sessionId, 0).length;

    // Poison the inventory with a binding that does not exist: the
    // invalidation sweep throws inside the transaction.
    const record = parts.store.getTransition(transitionId)!;
    const inventory = record.data.inventory as unknown[];
    parts.store.casTransition(transitionId, { phase: "validated" }, {
      ...record,
      data: {
        ...record.data,
        inventory: [...inventory, { resourceId: "res-ghost", type: "socket", capability: "exec.process@1", recovery: "native" }],
      },
      updatedAt: new Date().toISOString(),
    });
    const refused = await refuse(() =>
      Promise.resolve(switchReplacement(parts.store, transitionId)),
    );
    assert.equal(refused?.code, "InvalidRequest");

    // Nothing committed: the attachment, the bindings, the fence, the
    // phase, and the journal all stand exactly as before.
    const source = parts.store.getAttachment(parts.attachmentId)!;
    assert.equal(source.status, "replacing");
    assert.equal(source.generation, 1);
    for (const id of [parts.ids.reconstruct, parts.ids.reattach, parts.ids.native, parts.ids.none]) {
      assert.equal(parts.store.getResourceBinding(parts.sessionId, id)!.status, "bound");
    }
    const lease = parts.store.getMutationLease(parts.sessionId, parts.attachmentId)!;
    assert.equal(lease.releasedAt, undefined);
    assert.equal(parts.store.getTransition(transitionId)!.phase, "validated");
    assert.equal(parts.store.listEvents(parts.sessionId, 0).length, eventsBefore);
  } finally {
    parts.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});
