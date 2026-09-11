import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PolicyAuthority } from "../core/policy.js";
import { policyDeniedError, providerUnavailableError } from "../core/errors.js";
import type { BindingResult, AdapterOperation } from "../schema/adapter.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { ReconstructionRecipe, StateDisposition } from "../schema/handoff.js";
import { ControlStore } from "../store/control-store.js";
import { bindResource } from "./resources.js";
import type { BindResourceInput, BindTransport, ResourceFlowOptions } from "./resources.js";
import {
  checkReconstructionCoverage,
  checkReconstructionRecipes,
  checkStateDispositions,
  classifyResourceStates,
  invalidateNativeState,
  recipeStepOperationId,
  runReconstructionRecipe,
} from "./reconstruction.js";
import type {
  ClassifiableResource,
  ReconstructTransport,
  ReconstructionRun,
} from "./reconstruction.js";

function isPortableCode(value: unknown): value is { code: string; message?: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
async function refuse(run: () => unknown): Promise<{ code: string; message?: string; details?: unknown } | null> {
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
    operations: ["exec.process@1", "fs.workspace@1"],
  }),
};

/** A transport that always reports the reference bound unchanged. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource } satisfies BindingResult;
  },
};

/** One recipe fixture with two steps over declared capabilities. */
function recipe(overrides: Partial<ReconstructionRecipe> = {}): ReconstructionRecipe {
  return {
    id: "recipe-build",
    inputRevisionId: "rev-base",
    requiredCapabilities: ["exec.process@1"],
    steps: [
      { capability: "exec.process@1", operation: "run", input: { command: "npm", args: ["ci"] } },
      { capability: "exec.process@1", operation: "run", input: { command: "npm", args: ["run", "build"] } },
    ],
    outputs: ["built-index"],
    failureConditions: ["ProviderUnavailable", "the build command failed"],
    ...overrides,
  };
}

test("each recovery mode classifies to its v1 state treatment", () => {
  const dispositions = classifyResourceStates([
    { id: "res-app", type: "process.group", recovery: "reconstruct" },
    { id: "res-browser", type: "browser.session", recovery: "reattach" },
    { id: "res-heap", type: "interpreter.heap", recovery: "native" },
    { id: "res-socket", type: "socket", recovery: "none" },
  ]);
  assert.deepEqual(
    dispositions.map((disposition) => [disposition.class, disposition.action]),
    [
      ["reconstructable", "reconstruct"],
      ["reattachable", "reattach"],
      ["native", "invalidate"],
      ["native", "invalidate"],
    ],
  );
  // Every classified disposition names its resource.
  for (const disposition of dispositions) {
    assert.ok(disposition.resourceId);
    assert.ok(disposition.subject.length > 0);
  }
  // A resource with no declared restoration path says so.
  assert.match(dispositions[3]!.detail ?? "", /No restoration path/);
  // The set itself satisfies the v1 treatment table.
  assert.equal(checkStateDispositions(dispositions), null);
});

test("dispositions that break the v1 treatment table refuse", () => {
  // Correct pairings pass, including the empty set.
  assert.equal(checkStateDispositions([]), null);
  assert.equal(
    checkStateDispositions([
      { subject: "workspace files", class: "portable", action: "transfer" },
      { subject: "app server", class: "reconstructable", action: "reconstruct" },
      { subject: "browser session", class: "reattachable", action: "reattach", resourceId: "res-b" },
      { subject: "interpreter heap", class: "native", action: "invalidate" },
    ]),
    null,
  );

  // A class with the wrong action refuses.
  assert.equal(
    checkStateDispositions([
      { subject: "app server", class: "reconstructable", action: "transfer" },
    ])?.code,
    "InvalidRequest",
  );

  // Native state never takes another action in version one.
  const nativeRestore = checkStateDispositions([
    { subject: "heap snapshot", class: "native", action: "transfer" },
  ]);
  assert.equal(nativeRestore?.code, "InvalidRequest");
  assert.match(nativeRestore?.message ?? "", /must invalidate in version one/);

  // Reattachable state names the resource it rebinds.
  assert.equal(
    checkStateDispositions([
      { subject: "browser session", class: "reattachable", action: "reattach" },
    ])?.code,
    "InvalidRequest",
  );

  // One subject appears once.
  assert.equal(
    checkStateDispositions([
      { subject: "dup", class: "portable", action: "transfer" },
      { subject: "dup", class: "native", action: "invalidate" },
    ])?.code,
    "InvalidRequest",
  );
});

test("recipes must declare real operations, coverage, and failure conditions", () => {
  // A complete recipe passes, and checking it invokes nothing.
  assert.equal(checkReconstructionRecipes([recipe()]), null);

  // No operations: nothing to run.
  assert.equal(
    checkReconstructionRecipes([recipe({ steps: [] })])?.code,
    "InvalidRequest",
  );
  // No failure conditions: reconstruction can always fail.
  assert.equal(
    checkReconstructionRecipes([recipe({ failureConditions: [] })])?.code,
    "InvalidRequest",
  );
  // A step through a capability the recipe never declared refuses.
  const undeclared = recipe({
    steps: [
      { capability: "fs.workspace@1", operation: "write", input: {} },
    ],
  });
  assert.equal(checkReconstructionRecipes([undeclared])?.code, "InvalidRequest");
  // One identity appears once.
  const second = recipe({ id: "recipe-build", outputs: ["other"] });
  assert.equal(
    checkReconstructionRecipes([recipe(), second])?.code,
    "InvalidRequest",
  );
  // One output appears once across the set.
  const duplicateOutput = recipe({ id: "recipe-other" });
  assert.equal(
    checkReconstructionRecipes([recipe(), duplicateOutput])?.code,
    "InvalidRequest",
  );
});

test("reconstruction coverage binds recipe outputs to declared state", () => {
  const dispositions: StateDisposition[] = [
    { subject: "built-index", class: "reconstructable", action: "reconstruct" },
    { subject: "workspace files", class: "portable", action: "transfer" },
  ];
  assert.equal(checkReconstructionCoverage(dispositions, [recipe()]), null);

  // Reconstructable state with no recipe output covering it refuses.
  const uncovered: StateDisposition[] = [
    { subject: "search-index", class: "reconstructable", action: "reconstruct" },
  ];
  assert.equal(
    checkReconstructionCoverage(uncovered, [recipe()])?.code,
    "InvalidRequest",
  );
  // A recipe output nobody declared a need for refuses.
  const unrequested = recipe({ outputs: ["built-index", "bonus-artifact"] });
  assert.equal(
    checkReconstructionCoverage(dispositions, [unrequested])?.code,
    "InvalidRequest",
  );
});

test("a recipe runs through the ordinary authorized path in declared order", async () => {
  const calls: Array<{ operationId: string; capability: string; operation: string }> = [];
  const transport: ReconstructTransport = {
    async invoke(step, operationId) {
      calls.push({ operationId, capability: step.capability, operation: step.operation });
      return { operationId, status: "completed", result: { exitCode: 0 } };
    },
  };
  const run: ReconstructionRun = await runReconstructionRecipe(recipe(), transport);
  assert.equal(run.outcome, "completed");
  assert.deepEqual(run.outputs, ["built-index"]);
  assert.equal(run.error, undefined);
  assert.deepEqual(
    calls.map((call) => [call.operationId, call.operation]),
    [
      ["recipe-build:step-0", "run"],
      ["recipe-build:step-1", "run"],
    ],
  );
  // Step identities are deterministic: a rerun addresses the same operations.
  assert.equal(recipeStepOperationId("recipe-build", 0), "recipe-build:step-0");
  const rerun = await runReconstructionRecipe(recipe(), transport);
  assert.deepEqual(
    rerun.steps.map((step) => step.operationId),
    run.steps.map((step) => step.operationId),
  );
});

test("a failed step stops the recipe and reports the declared condition", async () => {
  let invoked = 0;
  const transport: ReconstructTransport = {
    async invoke(step, operationId) {
      invoked += 1;
      if (step.operation === "run" && invoked === 1) {
        return {
          operationId,
          status: "failed",
          error: providerUnavailableError("The environment provider failed."),
        };
      }
      return { operationId, status: "completed" };
    },
  };
  const run = await runReconstructionRecipe(recipe(), transport);
  assert.equal(run.outcome, "failed");
  assert.deepEqual(run.outputs, []);
  assert.equal(run.failureCondition, "ProviderUnavailable");
  assert.equal(run.error?.code, "ProviderUnavailable");
  // The second step never dispatched.
  assert.equal(invoked, 1);
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0]!.status, "failed");

  // A thrown refusal crosses as a failure without a matched condition.
  const denied: ReconstructTransport = {
    async invoke() {
      throw policyDeniedError("The policy does not permit this operation.");
    },
  };
  const refused = await runReconstructionRecipe(recipe(), denied);
  assert.equal(refused.outcome, "failed");
  assert.equal(refused.error?.code, "PolicyDenied");
  assert.equal(refused.failureCondition, undefined);

  // A step that answers neither completed nor an error still reports one.
  const silent: ReconstructTransport = {
    async invoke(_step, operationId) {
      const operation: AdapterOperation = { operationId, status: "cancelled" };
      return operation;
    },
  };
  const cancelled = await runReconstructionRecipe(recipe(), silent);
  assert.equal(cancelled.outcome, "failed");
  assert.equal(cancelled.steps[0]!.error?.code, "ProviderUnavailable");
});

test("a malformed recipe dispatches nothing", async () => {
  let invoked = 0;
  const transport: ReconstructTransport = {
    async invoke() {
      invoked += 1;
      return { operationId: "never", status: "completed" };
    },
  };
  // Parsing and validation never execute: the malformed recipe throws
  // before the transport sees one step.
  const refused = await refuse(() =>
    runReconstructionRecipe(recipe({ steps: [] }), transport),
  );
  assert.equal(refused?.code, "InvalidRequest");
  assert.equal(invoked, 0);
  // The schema itself rejects a recipe missing declared fields.
  const shapeless = await refuse(() =>
    runReconstructionRecipe({ id: "bad" } as unknown as ReconstructionRecipe, transport),
  );
  assert.equal(shapeless?.code, "InvalidRequest");
  assert.equal(invoked, 0);
});

/** One session, one attachment, and bound resources of each class. */
async function boundFixture(): Promise<{
  store: ControlStore;
  sessionId: string;
  attachmentId: string;
  ids: { reconstruct: string; reattach: string; native: string; none: string };
}> {
  const store = ControlStore.inMemory();
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
  const attachment: AttachmentSummary = {
    sessionId,
    attachmentId: `att-${randomUUID()}`,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  };
  store.insertAttachment(attachment);
  const base = {
    owner: { sessionId, attachmentId: attachment.attachmentId, generation: 1 },
    capability: "exec.process@1",
    lifetime: "attachment" as const,
  };
  const bind = async (type: string, recovery: BindResourceInput["recovery"]) =>
    (
      await bindResource(
        store,
        sessionId,
        { ...base, type, recovery },
        okTransport,
        AUTHORITY,
      )
    ).ref.id;
  return {
    store,
    sessionId,
    attachmentId: attachment.attachmentId,
    ids: {
      reconstruct: await bind("process.group", "reconstruct"),
      reattach: await bind("browser.session", "reattach"),
      native: await bind("interpreter.heap", "native"),
      none: await bind("socket", "none"),
    },
  };
}

test("native state invalidates through the durable binding sweep", async () => {
  const parts = await boundFixture();
  const resources: ClassifiableResource[] = [
    { id: parts.ids.reconstruct, type: "process.group", recovery: "reconstruct" },
    { id: parts.ids.reattach, type: "browser.session", recovery: "reattach" },
    { id: parts.ids.native, type: "interpreter.heap", recovery: "native" },
    { id: parts.ids.none, type: "socket", recovery: "none" },
  ];
  const dispositions = classifyResourceStates(resources);
  const result = invalidateNativeState(
    parts.store,
    parts.sessionId,
    [...dispositions, { subject: "process memory", class: "native", action: "invalidate" }],
    "replacement invalidated native state",
  );

  // Native bindings swept, including the no-restoration-path socket.
  assert.deepEqual(
    result.invalidated.map((entry) => entry.subject).sort(),
    ["interpreter.heap " + parts.ids.native, "socket " + parts.ids.none].sort(),
  );
  // Unbound native state records its invalidation in the plan itself.
  assert.deepEqual(result.unbound, [
    { subject: "process memory", class: "native", action: "invalidate" },
  ]);
  // Other classes are skipped: reattachment and reconstruction are
  // explicit flows, never side effects of invalidation.
  assert.deepEqual(
    result.skipped.map((entry) => entry.class),
    ["reconstructable", "reattachable"],
  );
  assert.equal(
    parts.store.getResourceBinding(parts.sessionId, parts.ids.native)?.status,
    "invalidated",
  );
  assert.equal(
    parts.store.getResourceBinding(parts.sessionId, parts.ids.reconstruct)?.status,
    "bound",
  );

  // The journal carries one invalidation event per swept binding.
  const events = parts.store.listEvents(parts.sessionId, 0).filter(
    (event) => event.type === "resource.invalidated",
  );
  assert.deepEqual(
    events.map((event) => event.subjectId).sort(),
    [parts.ids.native, parts.ids.none].sort(),
  );

  // A repeat sweep stays idempotent.
  const again = invalidateNativeState(
    parts.store,
    parts.sessionId,
    dispositions,
    "replacement invalidated native state",
  );
  assert.equal(again.invalidated.length, 2);
  assert.equal(
    parts.store.listEvents(parts.sessionId, 0).filter(
      (event) => event.type === "resource.invalidated",
    ).length,
    2,
  );
});

test("invalidation refuses foreign resources and rolls the sweep back", async () => {
  const parts = await boundFixture();
  // A native disposition naming a resource this session never bound.
  const refused = await refuse(() =>
    invalidateNativeState(
      parts.store,
      parts.sessionId,
      [
        {
          subject: "heap",
          class: "native",
          action: "invalidate",
          resourceId: "res-foreign",
        },
      ],
      "test",
    ),
  );
  assert.equal(refused?.code, "InvalidRequest");

  // Broken dispositions refuse before the store is touched.
  const broken = await refuse(() =>
    invalidateNativeState(
      parts.store,
      parts.sessionId,
      [{ subject: "heap", class: "native", action: "reattach" }],
      "test",
    ),
  );
  assert.equal(broken?.code, "InvalidRequest");

  // A foreign resource mid-sweep rolls the earlier sweep back.
  const sweep = await refuse(() =>
    invalidateNativeState(
      parts.store,
      parts.sessionId,
      [
        { subject: "heap", class: "native", action: "invalidate", resourceId: parts.ids.native },
        { subject: "ghost", class: "native", action: "invalidate", resourceId: "res-ghost" },
      ],
      "test",
    ),
  );
  assert.equal(sweep?.code, "InvalidRequest");
  assert.equal(
    parts.store.getResourceBinding(parts.sessionId, parts.ids.native)?.status,
    "bound",
  );
  assert.equal(
    parts.store.listEvents(parts.sessionId, 0).filter(
      (event) => event.type === "resource.invalidated",
    ).length,
    0,
  );
});
