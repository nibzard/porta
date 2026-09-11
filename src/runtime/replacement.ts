import {
  handoffBlockedError,
  invalidRequestError,
  requirementUnsatisfiedError,
  sanitizeError,
  staleHandleError,
  toPortableError,
} from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import { assertValid } from "../schema/validate.js";
import { replaceRequestSchema } from "../schema/handoff.js";
import type {
  ActiveOperationsPolicy,
  ReplaceRequest,
  HandoffPlan,
  StateDisposition,
} from "../schema/handoff.js";
import type { OperationRecord, OperationStatus } from "../schema/operation.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";
import {
  checkReconstructionCoverage,
  checkReconstructionRecipes,
  checkStateDispositions,
  classifyResourceStates,
} from "./reconstruction.js";
import { cancelOperation, waitForOperation } from "./cancellation.js";
import type { CancelTransport } from "./cancellation.js";
import { randomUUID } from "node:crypto";

/**
 * Replacement planning (SPEC.md section 13.1).
 *
 * `planReplace` reads the durable state of one session and reports how
 * every piece of state crosses a replacement of one attachment. It is
 * side-effect free: it allocates nothing, admits nothing, journals
 * nothing, and never moves the workspace head. Provisioning happens in
 * later phases and refuses while any blocker stands.
 *
 * Preconditions of the request itself — shape, recipe semantics, the
 * source generation, the revision — refuse with an error. Obstacles of
 * the planned transition — required resources the plan would
 * invalidate, coverage gaps — cross inside the report as blockers, so
 * the caller sees the full treatment listing before deciding.
 */

/** The portable disposition of the workspace content being transferred. */
function workspaceDisposition(revisionId: string, workspaceId: string): StateDisposition {
  return {
    subject: `workspace ${workspaceId} files`,
    class: "portable",
    action: "transfer",
    detail: `Crosses as revision ${revisionId}; the workspace head does not move.`,
  };
}

/**
 * Plan the replacement of one attachment (SPEC.md section 13.1).
 *
 * The source generation is a precondition: a mismatch refuses with
 * `StaleHandle` before any provisioning could happen. Required
 * resources the plan would invalidate become blockers, never silent
 * losses; omitting a resource from `requiredResources` permits its
 * explicit invalidation.
 */
export function planReplace(store: ControlStore, request: ReplaceRequest): HandoffPlan {
  try {
    assertValid(replaceRequestSchema, request);
  } catch (error) {
    throw toPortableError(error);
  }
  enforceRecipeSemantics(request);

  const { sessionId, attachmentId, generation } = request.source;
  const session = store.getSession(sessionId);
  if (session === null) {
    throw invalidRequestError(`Session ${sessionId} does not exist.`, { sessionId });
  }
  const attachment = store.getAttachment(attachmentId);
  if (attachment === null) {
    throw staleHandleError(
      { kind: "attachment", value: attachmentId },
      { kind: "attachment", value: null },
    );
  }
  if (attachment.sessionId !== sessionId) {
    throw invalidRequestError(
      `Attachment ${attachmentId} belongs to session ${attachment.sessionId}, not ${sessionId}.`,
      { sessionId, attachmentId, ownerSessionId: attachment.sessionId },
    );
  }
  if (attachment.generation !== generation) {
    throw staleHandleError(
      { kind: "generation", value: attachment.generation },
      { kind: "generation", value: generation },
    );
  }
  if (attachment.status !== "active") {
    throw staleHandleError(
      { kind: "attachment-status", value: "active" },
      { kind: "attachment-status", value: attachment.status },
    );
  }
  const revision = store.getRevision(request.workspaceRevisionId);
  if (revision === null) {
    throw invalidRequestError(
      `Revision ${request.workspaceRevisionId} does not exist.`,
      { workspaceRevisionId: request.workspaceRevisionId },
    );
  }
  if (revision.workspaceId !== session.workspaceId) {
    throw invalidRequestError(
      `Revision ${request.workspaceRevisionId} belongs to workspace ${revision.workspaceId}, ` +
        `not the session workspace ${session.workspaceId}.`,
      { workspaceRevisionId: request.workspaceRevisionId, workspaceId: session.workspaceId },
    );
  }
  const pinned = request.destination.workspace?.revisionId;
  if (pinned !== undefined && pinned !== request.workspaceRevisionId) {
    throw invalidRequestError(
      `The destination pins revision ${pinned}, but the transfer carries ${request.workspaceRevisionId}.`,
      { pinned, workspaceRevisionId: request.workspaceRevisionId },
    );
  }

  // The inventory reads exactly the source generation's live bindings.
  // Planning never mutates one to inspect it.
  const bindings = store.listResourceBindingsForOwner(sessionId, attachmentId, generation, true);
  const resourceDispositions = classifyResourceStates(
    bindings.map((binding) => ({
      id: binding.id,
      type: binding.type,
      recovery: binding.recovery,
    })),
  );
  const portable = workspaceDisposition(request.workspaceRevisionId, session.workspaceId);
  const dispositions = [portable, ...resourceDispositions];
  const semantic = checkStateDispositions(dispositions);
  if (semantic !== null) {
    throw semantic;
  }

  const reconstructed = dispositions.filter((entry) => entry.class === "reconstructable");
  const reattached = dispositions.filter((entry) => entry.class === "reattachable");
  const invalidated = dispositions.filter((entry) => entry.class === "native");
  const blockers: PortableError[] = [];

  const coverage = checkReconstructionCoverage(dispositions, request.reconstruct);
  if (coverage !== null) {
    blockers.push(coverage);
  }
  for (const recipe of request.reconstruct) {
    if (recipe.inputRevisionId !== request.workspaceRevisionId) {
      blockers.push(
        invalidRequestError(
          `Recipe ${recipe.id} pins input revision ${recipe.inputRevisionId}, ` +
            `but the transfer carries ${request.workspaceRevisionId}.`,
          { recipeId: recipe.id, inputRevisionId: recipe.inputRevisionId },
        ),
      );
    }
  }

  const byResource = new Map(
    resourceDispositions.map((entry) => [entry.resourceId ?? "", entry] as const),
  );
  for (const resourceId of request.requiredResources) {
    const disposition = byResource.get(resourceId);
    if (disposition === undefined) {
      blockers.push(
        requirementUnsatisfiedError(
          `Required resource ${resourceId} is not held by the source generation.`,
          { resourceId, reason: "not-held" },
        ),
      );
      continue;
    }
    if (disposition.class === "native") {
      blockers.push(
        requirementUnsatisfiedError(
          `The plan invalidates required resource ${resourceId}; ` +
            "an execution request rejects that treatment.",
          { resourceId, reason: "invalidated", subject: disposition.subject },
        ),
      );
    }
  }

  return {
    sessionId,
    attachmentId,
    sourceGeneration: generation,
    workspaceRevisionId: request.workspaceRevisionId,
    preserved: dispositions.filter((entry) => entry.class === "portable"),
    reconstructed,
    reattached,
    invalidated,
    blockers,
  };
}

/** Recipe semantic problems are request problems; they refuse the plan. */
function enforceRecipeSemantics(request: ReplaceRequest): void {
  const problem = checkReconstructionRecipes(request.reconstruct);
  if (problem !== null) {
    throw problem;
  }
}

// -- Preparation (SPEC.md sections 5.3 and 13.2, phase 1) ---------------------

/** Options of one preparation call. */
export interface PrepareOptions {
  /** Transport for stopping active operations under policy `cancel`. */
  cancel?: CancelTransport;
  /**
   * Bounded patience for policy `wait`, in milliseconds. When the
   * deadline passes with operations still unsettled, preparation
   * blocks: a deadline never bypasses an unresolved outcome.
   */
  waitMs?: number;
  pollIntervalMs?: number;
  redactor?: EventRedactor;
}

/** One operation the preparation found unsettled. */
export interface ActiveOperationState {
  operationId: string;
  capability: string;
  operation: string;
  status: OperationStatus;
}

/** The report of one preparation call. */
export interface PreparationReport {
  transitionId: string;
  sessionId: string;
  attachmentId: string;
  sourceGeneration: number;
  /** `prepared` = quiesced and settled; `blocked` = quiesced with blockers. */
  state: "prepared" | "blocked";
  policy: ActiveOperationsPolicy;
  /** Operations unsettled when preparation began. */
  quiesced: ActiveOperationState[];
  /** Operations the policy settled before the report. */
  resolved: ActiveOperationState[];
  blockers: PortableError[];
}

/** The default patience of policy `wait`. */
const DEFAULT_WAIT_MS = 30_000;

/**
 * Quiesce one attachment for replacement (SPEC.md sections 5.3 and
 * 13.2, phase 1).
 *
 * The attachment moves `active` to `replacing` in one compare-and-set
 * that also carries the source generation, so a stale request cannot
 * quiesce a newer generation and a concurrent admission either lands
 * before the swap or refuses after it — never between.
 *
 * Active operations then resolve under the declared policy: `reject`
 * refuses while any operation is unsettled, `cancel` stops each one
 * through the transport, and `wait` waits bounded. An operation whose
 * outcome is `unknown` blocks replacement under every policy, and a
 * wait deadline never bypasses that block. A blocked preparation
 * leaves the attachment quiesced; aborting it is a separate flow.
 *
 * A plan with blockers refuses here, before the source is touched:
 * provisioning refuses while blockers stand, so quiescing for it
 * would only buy risk.
 */
export async function prepareReplacement(
  store: ControlStore,
  request: ReplaceRequest,
  options: PrepareOptions = {},
): Promise<PreparationReport> {
  const plan = planReplace(store, request);
  if (plan.blockers.length > 0) {
    throw handoffBlockedError(
      "The replacement plan carries blockers; preparation refuses to quiesce for it.",
      { blockers: plan.blockers.map((blocker) => blocker.code) },
    );
  }
  if (request.activeOperations === "cancel" && options.cancel === undefined) {
    throw invalidRequestError(
      "Policy cancel needs a cancellation transport to stop active operations.",
      { policy: "cancel" },
    );
  }

  const { sessionId, attachmentId, generation } = request.source;
  const transitionId = `tr-${randomUUID()}`;
  const stored = store.getAttachment(attachmentId);
  if (stored === null) {
    throw staleHandleError(
      { kind: "attachment", value: attachmentId },
      { kind: "attachment", value: null },
    );
  }
  const swapped = store.casAttachment(
    attachmentId,
    { status: "active", generation },
    { ...stored, status: "replacing" },
  );
  if (swapped === null) {
    throw staleHandleError(
      { kind: "attachment-state", value: { status: "active", generation } },
      {
        kind: "attachment-state",
        value: { status: stored.status, generation: stored.generation },
      },
    );
  }
  store.insertTransition({
    id: transitionId,
    sessionId,
    attachmentId,
    phase: "preparing",
    data: {
      requestKey: request.requestKey,
      policy: request.activeOperations,
      workspaceRevisionId: request.workspaceRevisionId,
      plan: planSummary(plan),
    },
    updatedAt: new Date().toISOString(),
  });

  const stream =
    options.redactor === undefined
      ? new SessionEventStream(store, sessionId)
      : new SessionEventStream(store, sessionId, options.redactor);
  const quiesced = activeOperations(store, sessionId, attachmentId, generation);
  const resolved: ActiveOperationState[] = [];
  const blockers: PortableError[] = [];

  if (request.activeOperations === "reject") {
    for (const operation of quiesced) {
      blockers.push(operationBlocker(operation, "policy-reject"));
    }
  } else if (request.activeOperations === "cancel") {
    for (const operation of quiesced) {
      if (operation.status === "unknown") {
        continue;
      }
      const outcome = await cancelOperation(store, sessionId, operation.id, options.cancel!);
      if (outcome.operation.status === "cancelled") {
        resolved.push(stateOf(outcome.operation));
      } else {
        blockers.push(
          operationBlocker(
            outcome.operation,
            outcome.operation.status === "unknown" ? "unknown-outcome" : "cancel-unconfirmed",
          ),
        );
      }
    }
  } else {
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    for (const operation of quiesced) {
      if (operation.status === "unknown") {
        continue;
      }
      const outcome = await waitForOperation(store, sessionId, operation.id, {
        waitMs,
        ...(options.pollIntervalMs !== undefined
          ? { pollIntervalMs: options.pollIntervalMs }
          : {}),
      });
      if (outcome.outcome === "timed-out") {
        blockers.push(operationBlocker(operation, "wait-deadline-passed"));
      } else {
        resolved.push(stateOf(outcome.operation));
      }
    }
  }

  // An unknown outcome blocks replacement in version one, under every
  // policy: uncertainty is never release, and no deadline bypasses it.
  for (const operation of activeOperations(store, sessionId, attachmentId, generation)) {
    if (operation.status === "unknown") {
      blockers.push(operationBlocker(operation, "unknown-outcome"));
    }
  }

  const state: PreparationReport["state"] = blockers.length > 0 ? "blocked" : "prepared";
  const settledIds = new Set(resolved.map((operation) => operation.operationId));
  const data = {
    state,
    policy: request.activeOperations,
    blockers: blockers.map((blocker) => sanitizeError(blocker)),
    resolved: resolved.map((operation) => operation.operationId),
  };
  transitionPhase(
    store,
    transitionId,
    "preparing",
    state,
    data,
    stream,
    `Operations resolved under policy ${request.activeOperations}; ` +
      `${blockers.length} blocker(s).`,
  );
  return {
    transitionId,
    sessionId,
    attachmentId,
    sourceGeneration: generation,
    state,
    policy: request.activeOperations,
    quiesced: quiesced
      .filter((operation) => !settledIds.has(operation.id))
      .map(stateOf),
    resolved,
    blockers,
  };
}

/** The unsettled operations of one attachment generation. */
function activeOperations(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
  generation: number,
): OperationRecord[] {
  return store
    .listOperationsBySession(sessionId)
    .filter(
      (operation) =>
        operation.attachment.attachmentId === attachmentId &&
        operation.attachment.generation === generation &&
        operation.status !== "completed" &&
        operation.status !== "failed" &&
        operation.status !== "cancelled",
    );
}

/** The blocked-operation error of one unsettled operation. */
function operationBlocker(
  operation: OperationRecord,
  reason: string,
): PortableError {
  return handoffBlockedError(
    `Operation ${operation.id} is ${operation.status}; the replacement cannot proceed past it.`,
    {
      operationId: operation.id,
      status: operation.status,
      reason,
    },
  );
}

/** The report shape of one operation. */
function stateOf(operation: OperationRecord): ActiveOperationState {
  return {
    operationId: operation.id,
    capability: operation.capability,
    operation: operation.operation,
    status: operation.status,
  };
}

/** The durable summary of one plan. */
function planSummary(plan: HandoffPlan): Record<string, unknown> {
  return {
    workspaceRevisionId: plan.workspaceRevisionId,
    preserved: plan.preserved.map((entry) => entry.subject),
    reconstructed: plan.reconstructed.map((entry) => entry.subject),
    reattached: plan.reattached.map((entry) => entry.subject),
    invalidated: plan.invalidated.map((entry) => entry.subject),
  };
}

/** Move one transition to its next phase and journal the step. */
function transitionPhase(
  store: ControlStore,
  transitionId: string,
  expect: string,
  next: string,
  data: Record<string, unknown>,
  stream: SessionEventStream,
  detail: string,
): void {
  const current = store.getTransition(transitionId);
  if (current === null) {
    throw invalidRequestError(`Transition ${transitionId} does not exist.`, {
      transitionId,
    });
  }
  const moved = store.casTransition(transitionId, { phase: expect }, {
    ...current,
    phase: next,
    data: { ...current.data, ...data },
    updatedAt: new Date().toISOString(),
  });
  if (moved === null) {
    throw staleHandleError(
      { kind: "transition-phase", value: expect },
      { kind: "transition-phase", value: current.phase },
    );
  }
  // The journal carries the lean step; the transition record carries
  // the full data of every phase.
  stream.append("handoff.updated", transitionId, {
    transitionId,
    phase: next,
    detail,
  });
}

// -- Checkpoint (SPEC.md section 13.2, phase 2) -------------------------------

/** A provider snapshot with an explicit consistency contract. */
export interface DeclaredSnapshot {
  /** What the snapshot guarantees, in the provider's own terms. */
  consistencyContract: string;
  /** What the snapshot covers, when the provider states a scope. */
  scope?: string;
}

/** Options of one checkpoint call. */
export interface ReplacementCheckpointOptions {
  /**
   * A provider snapshot may replace the writer-stop requirement only
   * when its consistency contract is explicit (SPEC.md 13.2).
   */
  snapshot?: DeclaredSnapshot;
  redactor?: EventRedactor;
  /** How long the checkpoint's mutation lease holds. Ten minutes by default. */
  leaseTtlMs?: number;
}

/** How the managed copy was made consistent for the checkpoint. */
export type CheckpointConsistency =
  | { kind: "writers-stopped"; fencingToken: number }
  | {
      kind: "provider-snapshot";
      consistencyContract: string;
      heldBy?: string;
      fencingToken: number;
    };

/** The report of one checkpoint call. */
export interface CheckpointReport {
  transitionId: string;
  sessionId: string;
  attachmentId: string;
  sourceGeneration: number;
  /** The revision the transition persists. */
  workspaceRevisionId: string;
  consistency: CheckpointConsistency;
  /** The durable resource inventory persisted with the transition. */
  inventory: number;
}

/** The default hold of the checkpoint mutation lease. */
const DEFAULT_CHECKPOINT_LEASE_MS = 10 * 60_000;

/**
 * Checkpoint one prepared replacement (SPEC.md section 13.2, phase 2).
 *
 * Managed background writers stop before the freeze: the checkpoint
 * takes the attachment's mutation lease, which fences every managed
 * copy writer behind one rising token, and holds it for the switch to
 * verify. A writer that still holds the lease blocks the checkpoint,
 * unless the caller declares a provider snapshot whose consistency
 * contract is explicit — then the snapshot's contract stands in for
 * the stop, and the transition records it.
 *
 * The transition record persists the selected revision, the fencing
 * token, the consistency basis, and the full resource inventory of
 * the source generation. Nothing here allocates a destination.
 */
export function checkpointReplacement(
  store: ControlStore,
  transitionId: string,
  options: ReplacementCheckpointOptions = {},
): CheckpointReport {
  const current = store.getTransition(transitionId);
  if (current === null) {
    throw invalidRequestError(`Transition ${transitionId} does not exist.`, {
      transitionId,
    });
  }
  const { sessionId, attachmentId } = current;
  const prepared = current.data as {
    workspaceRevisionId?: string;
    sourceGeneration?: number;
  };
  if (current.phase !== "prepared") {
    throw invalidRequestError(
      `Transition ${transitionId} is ${current.phase}; only a prepared transition checkpoints.`,
      { transitionId, phase: current.phase },
    );
  }
  const attachment = store.getAttachment(attachmentId);
  if (attachment === null || attachment.sessionId !== sessionId) {
    throw invalidRequestError(
      `Transition ${transitionId} names attachment ${attachmentId}, which session ${sessionId} does not hold.`,
      { transitionId, attachmentId },
    );
  }
  const stream =
    options.redactor === undefined
      ? new SessionEventStream(store, sessionId)
      : new SessionEventStream(store, sessionId, options.redactor);

  let consistency: CheckpointConsistency;
  const ttl = options.leaseTtlMs ?? DEFAULT_CHECKPOINT_LEASE_MS;
  try {
    const lease = store.acquireMutationLease(
      sessionId,
      attachmentId,
      `replacement:${transitionId}`,
      ttl,
    );
    consistency = { kind: "writers-stopped", fencingToken: lease.fencingToken };
  } catch (error) {
    const held = error instanceof StoreError && error.kind === "lease-held";
    if (!held || options.snapshot === undefined) {
      if (held) {
        throw handoffBlockedError(
          "A managed writer holds the mutation lease; background writers must stop before checkpointing.",
          { attachmentId, reason: "mutation-lease-held" },
        );
      }
      throw error;
    }
    if (options.snapshot.consistencyContract.trim().length === 0) {
      throw invalidRequestError(
        "A declared snapshot needs an explicit consistency contract.",
        { transitionId },
      );
    }
    const writer = store.getMutationLease(sessionId, attachmentId);
    consistency = {
      kind: "provider-snapshot",
      consistencyContract: options.snapshot.consistencyContract,
      ...(options.snapshot.scope !== undefined ? { scope: options.snapshot.scope } : {}),
      ...(writer?.holder !== undefined ? { heldBy: writer.holder } : {}),
      fencingToken: writer?.fencingToken ?? 0,
    };
  }

  const inventory = store.listResourceBindingsForOwner(
    sessionId,
    attachmentId,
    attachment.generation,
    false,
  );
  const data = {
    sourceGeneration: attachment.generation,
    fencingToken: consistency.fencingToken,
    consistency,
    inventory: inventory.map((binding) => ({
      resourceId: binding.id,
      type: binding.type,
      capability: binding.capability,
      recovery: binding.recovery,
      status: binding.status,
    })),
    checkpointedAt: new Date().toISOString(),
  };
  const moved = store.casTransition(transitionId, { phase: "prepared" }, {
    ...current,
    phase: "checkpointed",
    data: { ...current.data, ...data },
    updatedAt: new Date().toISOString(),
  });
  if (moved === null) {
    throw staleHandleError(
      { kind: "transition-phase", value: "prepared" },
      { kind: "transition-phase", value: current.phase },
    );
  }
  stream.append("handoff.updated", transitionId, {
    transitionId,
    phase: "checkpointed",
    detail: `Consistency basis ${consistency.kind}; fencing token ${consistency.fencingToken}.`,
  });
  return {
    transitionId,
    sessionId,
    attachmentId,
    sourceGeneration: attachment.generation,
    workspaceRevisionId: String(prepared.workspaceRevisionId ?? ""),
    consistency,
    inventory: inventory.length,
  };
}
