import { invalidRequestError, providerUnavailableError, toPortableError } from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import { assertValid } from "../schema/validate.js";
import { reconstructionRecipeSchema, stateDispositionSchema } from "../schema/handoff.js";
import type {
  ReconstructionRecipe,
  StateDisposition,
  StateClass,
} from "../schema/handoff.js";
import type { AdapterOperation, AdapterOperationState } from "../schema/adapter.js";
import type { RecoveryMode } from "../schema/resource.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";

/**
 * State classification and declared reconstruction (SPEC.md section 12).
 *
 * Four state classes cross a handoff, each with one v1 behavior:
 *
 * | Class | Behavior |
 * | --- | --- |
 * | Portable | Transfer and validate. |
 * | Reconstructable | Run a declared reconstruction recipe. |
 * | Reattachable | Obtain a new authorized binding. |
 * | Native | Invalidate; snapshot restoration is not in version one. |
 *
 * A recipe is data, never code. Parsing and validating a recipe performs
 * no invocation, no store write, and no provider call; only
 * `runReconstructionRecipe` executes anything, and it runs every step
 * through the caller's ordinary authorized invocation path. The runner
 * holds no authority of its own to bypass.
 */

/** The action each state class takes in version one. */
const ACTION_OF_CLASS: Record<StateClass, StateDisposition["action"]> = {
  portable: "transfer",
  reconstructable: "reconstruct",
  reattachable: "reattach",
  native: "invalidate",
};

/**
 * The state class of one resource recovery mode (SPEC.md sections 10
 * and 12). A recovery mode is how a bound resource crosses; a state
 * class is what the state is. Resources never classify as portable:
 * portable state crosses as workspace content, not as a binding.
 */
const CLASS_OF_RECOVERY: Record<RecoveryMode, StateClass> = {
  reconstruct: "reconstructable",
  reattach: "reattachable",
  native: "native",
  none: "native",
};

/** One bound resource, as classification input. */
export interface ClassifiableResource {
  id: string;
  type: string;
  recovery: RecoveryMode;
}

/**
 * The disposition of one resource across a handoff.
 *
 * A resource with no declared restoration path (`none`) takes the
 * native treatment — invalidate — because version one offers no other
 * crossing for it.
 */
export function dispositionOfRecovery(resource: ClassifiableResource): StateDisposition {
  const stateClass = CLASS_OF_RECOVERY[resource.recovery];
  return {
    subject: `${resource.type} ${resource.id}`,
    class: stateClass,
    action: ACTION_OF_CLASS[stateClass],
    resourceId: resource.id,
    ...(resource.recovery === "none"
      ? { detail: "No restoration path is declared; the state does not cross." }
      : {}),
  };
}

/** Classify every input resource into its planned disposition. */
export function classifyResourceStates(
  resources: readonly ClassifiableResource[],
): StateDisposition[] {
  return resources.map(dispositionOfRecovery);
}

/**
 * Check declared dispositions against the v1 treatment table.
 *
 * Each class pairs with exactly one action, a reattachable entry names
 * the resource it rebinds, and native state always invalidates in
 * version one — a native disposition with any other action names a
 * restoration extension this version does not have. Subjects must be
 * unique: two dispositions for one subject is ambiguity, not coverage.
 */
export function checkStateDispositions(
  dispositions: readonly StateDisposition[],
): PortableError | null {
  const seen = new Set<string>();
  for (const disposition of dispositions) {
    assertValid(stateDispositionSchema, disposition);
    if (seen.has(disposition.subject)) {
      return invalidRequestError(
        `Two dispositions describe the subject ${disposition.subject}.`,
        { subject: disposition.subject },
      );
    }
    seen.add(disposition.subject);
    if (disposition.action !== ACTION_OF_CLASS[disposition.class]) {
      if (disposition.class === "native") {
        return invalidRequestError(
          `Native state ${disposition.subject} must invalidate in version one; ` +
            "snapshot restoration is not implemented.",
          { subject: disposition.subject, action: disposition.action },
        );
      }
      return invalidRequestError(
        `State ${disposition.subject} is class ${disposition.class}; its action ` +
          `must be ${ACTION_OF_CLASS[disposition.class]}, not ${disposition.action}.`,
        { subject: disposition.subject, action: disposition.action },
      );
    }
    if (disposition.class === "reattachable" && disposition.resourceId === undefined) {
      return invalidRequestError(
        `Reattachable state ${disposition.subject} names no resource to rebind.`,
        { subject: disposition.subject },
      );
    }
  }
  return null;
}

/**
 * Check a set of recipes beyond what the schema carries.
 *
 * A recipe declares at least one operation, and its declared required
 * capabilities cover every step's contract — a step running through a
 * capability the recipe never named is undeclared work. It declares at
 * least one failure condition: a recipe that cannot fail has not been
 * thought through. Recipe identities and outputs are unique across the
 * set: two recipes reconstructing one subject is a race, not coverage.
 *
 * This function is pure. It never invokes anything, and it is one of
 * the two reads of a recipe that happen without execution (the other
 * is JSON parsing itself).
 */
export function checkReconstructionRecipes(
  recipes: readonly ReconstructionRecipe[],
): PortableError | null {
  const ids = new Set<string>();
  const outputs = new Set<string>();
  for (const recipe of recipes) {
    assertValid(reconstructionRecipeSchema, recipe);
    if (ids.has(recipe.id)) {
      return invalidRequestError(`Two recipes carry the identity ${recipe.id}.`, {
        recipeId: recipe.id,
      });
    }
    ids.add(recipe.id);
    if (recipe.steps.length === 0) {
      return invalidRequestError(`Recipe ${recipe.id} declares no operations.`, {
        recipeId: recipe.id,
      });
    }
    if (recipe.failureConditions.length === 0) {
      return invalidRequestError(
        `Recipe ${recipe.id} declares no failure conditions; reconstruction can always fail.`,
        { recipeId: recipe.id },
      );
    }
    for (const [index, step] of recipe.steps.entries()) {
      if (!recipe.requiredCapabilities.includes(step.capability)) {
        return invalidRequestError(
          `Step ${index} of recipe ${recipe.id} runs through ${step.capability}, ` +
            "which the recipe does not declare as required.",
          { recipeId: recipe.id, step: index, capability: step.capability },
        );
      }
    }
    for (const output of recipe.outputs) {
      if (outputs.has(output)) {
        return invalidRequestError(
          `Two recipes declare the output ${output}; reconstructing one subject twice is a race.`,
          { output },
        );
      }
      outputs.add(output);
    }
  }
  return null;
}

/**
 * Check that declared reconstruction covers the reconstructable state.
 *
 * Every reconstructable subject must be the output of some recipe, or
 * the state silently fails to cross. Every recipe output must be
 * wanted by some reconstructable disposition, or the recipe does work
 * nobody declared a need for. Both directions refuse.
 */
export function checkReconstructionCoverage(
  dispositions: readonly StateDisposition[],
  recipes: readonly ReconstructionRecipe[],
): PortableError | null {
  const wanted = new Set(
    dispositions
      .filter((disposition) => disposition.class === "reconstructable")
      .map((disposition) => disposition.subject),
  );
  const offered = new Set(recipes.flatMap((recipe) => recipe.outputs));
  for (const subject of wanted) {
    if (!offered.has(subject)) {
      return invalidRequestError(
        `Reconstructable state ${subject} has no recipe output covering it.`,
        { subject },
      );
    }
  }
  for (const output of offered) {
    if (!wanted.has(output)) {
      return invalidRequestError(
        `Recipe output ${output} reconstructs state no disposition asked for.`,
        { output },
      );
    }
  }
  return null;
}

/**
 * The deterministic operation identity of one recipe step.
 *
 * A rerun of the same recipe addresses the same operations, so an
 * interrupted reconstruction resumes by request identity instead of
 * duplicating work.
 */
export function recipeStepOperationId(recipeId: string, index: number): string {
  return `${recipeId}:step-${index}`;
}

/**
 * Transport through which recipe steps run.
 *
 * Each call is one ordinary authorized invocation — the same admission,
 * policy, and lease path any consumer invocation takes. The runner
 * holds no authority and cannot bypass the transport.
 */
export interface ReconstructTransport {
  invoke(step: ReconstructionRecipe["steps"][number], operationId: string): Promise<AdapterOperation>;
}

/** The outcome of one executed recipe step. */
export interface ReconstructionStepOutcome {
  index: number;
  operationId: string;
  status: AdapterOperationState;
  result?: unknown;
  error?: PortableError;
}

/** The result of one recipe run. */
export interface ReconstructionRun {
  recipeId: string;
  inputRevisionId: string;
  outcome: "completed" | "failed";
  steps: ReconstructionStepOutcome[];
  /** The outputs the recipe declares; present only when completed. */
  outputs: string[];
  /** The declared condition the failure matched, when one did. */
  failureCondition?: string;
  error?: PortableError;
}

/**
 * Enforce one pure check at an entry point, refusing with a Portable
 * error either way: a semantic problem crosses unchanged, and a value
 * the schema rejected converts instead of escaping as a raw
 * `ValidationError` beside errors that carry a code.
 */
function enforce(check: () => PortableError | null): void {
  let problem: PortableError | null;
  try {
    problem = check();
  } catch (error) {
    throw toPortableError(error);
  }
  if (problem !== null) {
    throw problem;
  }
}

/**
 * Run one declared recipe through the ordinary authorized path
 * (SPEC.md section 12).
 *
 * Steps run in declared order and stop at the first failure; the
 * dispositions after a failure are not attempted. A failure reports
 * which declared condition it matched, when any does. This function
 * validates the recipe first, so a malformed recipe dispatches
 * nothing. It writes nothing: journaling belongs to the invocation
 * path behind the transport.
 */
export async function runReconstructionRecipe(
  recipe: ReconstructionRecipe,
  transport: ReconstructTransport,
): Promise<ReconstructionRun> {
  enforce(() => checkReconstructionRecipes([recipe]));
  const steps: ReconstructionStepOutcome[] = [];
  for (const [index, step] of recipe.steps.entries()) {
    const operationId = recipeStepOperationId(recipe.id, index);
    try {
      const operation = await transport.invoke(step, operationId);
      const outcome: ReconstructionStepOutcome = {
        index,
        operationId,
        status: operation.status,
        ...(operation.result !== undefined ? { result: operation.result } : {}),
        ...(operation.error !== undefined ? { error: operation.error } : {}),
      };
      steps.push(outcome);
      if (operation.status !== "completed") {
        // The failing step carries an error even when the operation
        // reported a non-completed status without one.
        outcome.error = stepError(index, operation);
        return failedRun(recipe, steps, outcome.error);
      }
    } catch (error) {
      const portable = toPortableError(error);
      steps.push({ index, operationId, status: "failed", error: portable });
      return failedRun(recipe, steps, portable);
    }
  }
  return {
    recipeId: recipe.id,
    inputRevisionId: recipe.inputRevisionId,
    outcome: "completed",
    steps,
    outputs: recipe.outputs,
  };
}

/** The error of one unfinished step, never absent. */
function stepError(index: number, operation: AdapterOperation): PortableError {
  if (operation.error !== undefined) {
    return operation.error;
  }
  return providerUnavailableError(
    `Step ${index} answered ${operation.status} without an error.`,
    { status: operation.status },
  );
}

/** Compose the failed run, matching the failure against declared conditions. */
function failedRun(
  recipe: ReconstructionRecipe,
  steps: ReconstructionStepOutcome[],
  error: PortableError,
): ReconstructionRun {
  const failureCondition =
    recipe.failureConditions.find(
      (condition) => error.code === condition || error.message.includes(condition),
    ) ?? undefined;
  return {
    recipeId: recipe.id,
    inputRevisionId: recipe.inputRevisionId,
    outcome: "failed",
    steps,
    outputs: [],
    ...(failureCondition !== undefined ? { failureCondition } : {}),
    error,
  };
}

/** The result of one native-state invalidation sweep. */
export interface NativeInvalidationResult {
  /** Dispositions whose bindings the sweep invalidated. */
  invalidated: StateDisposition[];
  /** Native dispositions with no binding behind them; the plan itself is their record. */
  unbound: StateDisposition[];
  /** Dispositions the sweep did not treat; they are not class native. */
  skipped: StateDisposition[];
}

/**
 * Invalidate the native state of one session (SPEC.md section 12).
 *
 * Version one must invalidate native state; this is that path. Each
 * disposition naming a resource binding marks that binding invalidated
 * and appends the `resource.invalidated` event. A binding of another
 * session refuses. An already-invalidated binding stays idempotent and
 * counts as invalidated. A native disposition with no binding —
 * process memory, an open socket — records its invalidation here, in
 * the plan, because no durable object exists to mark.
 *
 * Dispositions of other classes are skipped untouched: reattachment
 * and reconstruction are explicit flows, never side effects of
 * invalidation.
 */
export function invalidateNativeState(
  store: ControlStore,
  sessionId: string,
  dispositions: readonly StateDisposition[],
  reason: string,
  options?: { redactor?: EventRedactor },
): NativeInvalidationResult {
  enforce(() => checkStateDispositions(dispositions));
  const stream =
    options?.redactor === undefined
      ? new SessionEventStream(store, sessionId)
      : new SessionEventStream(store, sessionId, options.redactor);
  const result: NativeInvalidationResult = { invalidated: [], unbound: [], skipped: [] };
  try {
    store.transaction(() => {
      for (const disposition of dispositions) {
        if (disposition.class !== "native") {
          result.skipped.push(disposition);
          continue;
        }
        if (disposition.resourceId === undefined) {
          result.unbound.push(disposition);
          continue;
        }
        const binding = store.getResourceBinding(sessionId, disposition.resourceId);
        if (binding === null) {
          throw invalidRequestError(
            `Disposition ${disposition.subject} names resource ${disposition.resourceId}, ` +
              `which session ${sessionId} does not hold.`,
            { sessionId, resourceId: disposition.resourceId },
          );
        }
        if (binding.status === "invalidated") {
          // Idempotent: an earlier sweep already recorded this one.
          result.invalidated.push({
            ...disposition,
            detail: binding.invalidationReason ?? reason,
          });
          continue;
        }
        const updated = store.markResourceBindingInvalidated(
          binding.id,
          reason,
          new Date().toISOString(),
        );
        if (updated !== null) {
          stream.append("resource.invalidated", updated.id, {
            resourceId: updated.id,
            reason,
            ownerGeneration: updated.owner.generation,
            attachmentId: updated.owner.attachmentId,
          });
        }
        result.invalidated.push(disposition);
      }
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw invalidRequestError(
        `Native invalidation for session ${sessionId} failed: ${error.message}`,
        { sessionId },
      );
    }
    throw error;
  }
  return result;
}
