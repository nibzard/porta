import {
  handoffBlockedError,
  integrityFailureError,
  invalidRequestError,
  providerUnavailableError,
  requirementUnsatisfiedError,
  sanitizeError,
  staleHandleError,
  toPortableError,
} from "../core/errors.js";
import { checkTargetSatisfies, manifestTarget } from "../core/matching.js";
import type { PolicyAuthority } from "../core/policy.js";
import type { PortableError } from "../schema/error.js";
import { assertValid } from "../schema/validate.js";
import { replaceRequestSchema } from "../schema/handoff.js";
import type {
  ActiveOperationsPolicy,
  CleanupObligation,
  DestinationRequest,
  ReplaceRequest,
  HandoffPlan,
  ReconstructionRecipe,
  StateDisposition,
} from "../schema/handoff.js";
import { environmentManifestSchema } from "../schema/capability.js";
import type { EnvironmentRequest } from "../schema/capability.js";
import type {
  AdapterOperation,
  EnvironmentAdapter,
  EnvironmentLease,
} from "../schema/adapter.js";
import type { InvocationRequest } from "../schema/operation.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { RecoveryMode } from "../schema/resource.js";
import type { OperationRecord, OperationStatus } from "../schema/operation.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import type { BlobStore } from "../store/blob-store.js";
import { buildTreeFromDirectory } from "../store/workspace-tree.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore, TransitionRecord } from "../store/control-store.js";
import {
  checkReconstructionCoverage,
  checkReconstructionRecipes,
  checkStateDispositions,
  classifyResourceStates,
  runReconstructionRecipe,
} from "./reconstruction.js";
import { cancelOperation, waitForOperation } from "./cancellation.js";
import type { CancelTransport } from "./cancellation.js";
import { attachEnvironment } from "./acquisition.js";
import { materializeRevision } from "./workspace.js";
import { admitInvocation } from "./admission.js";
import { markOperationDispatched, settleOperation } from "./outcomes.js";
import type { OperationOutcome } from "./outcomes.js";
import { bindResource } from "./resources.js";
import type { BindTransport } from "./resources.js";
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
      sourceName: swapped.name,
      destination: request.destination,
      requiredResources: request.requiredResources,
      reconstruct: request.reconstruct,
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
      ...(binding.providerResourceId !== undefined
        ? { providerResourceId: binding.providerResourceId }
        : {}),
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

// -- Destination preparation (SPEC.md section 13.2, phases 3 to 5) ------------

/** Options of one destination preparation call. */
export interface DestinationOptions {
  /** The adapter that owns the destination environments. */
  adapter: EnvironmentAdapter;
  /** Reaches the acquired destination environment for work and reads. */
  leaseOf: (environmentId: string) => Promise<EnvironmentLease>;
  /** Carries candidate resource bindings to the destination lease. */
  bind: BindTransport;
  /** The content-addressed store holding the transfer revision. */
  blobs: BlobStore;
  /** The staging root the destination working copy materializes into. */
  copyRoot: string;
  /** Authenticated principal supplied by the embedding application. */
  principal: string;
  /** The policy authority in force for this call. */
  authority: PolicyAuthority;
  /** Mutation lease hold of the acquisition, in milliseconds. */
  leaseTtlMs?: number;
  /** Wait for the acquire response before reconciling, in milliseconds. */
  responseTimeoutMs?: number;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** What the validation step checked (SPEC.md section 13.2, phase 5). */
export interface DestinationValidation {
  /** The manifest parses and passes its own schema. */
  manifest: boolean;
  /** Capabilities, platform, resources, and enforcement satisfy the request. */
  satisfies: boolean;
  /** The destination working copy hashes back to the transfer revision. */
  revisionIntegrity: boolean;
  /** Every required resource holds a candidate binding. */
  requiredResources: boolean;
}

/** One reconstruction run recorded in the transition. */
export interface DestinationReconstruction {
  recipeId: string;
  outcome: "completed" | "failed";
  /** The declared condition a failure matched, when one did. */
  failureCondition?: string;
}

/** One candidate binding, by the source resource it replaces. */
export interface CandidateBinding {
  ofResourceId: string;
  resourceId: string;
  recovery: string;
}

/** The report of one destination preparation call. */
export interface DestinationReport {
  transitionId: string;
  sessionId: string;
  sourceAttachmentId: string;
  /** The candidate attachment the destination provisioned. */
  candidateAttachmentId: string;
  environmentId: string;
  /** The working copy the revision materialized into. */
  copyId: string;
  copyRoot: string;
  state: "validated" | "failed";
  reconstruction: DestinationReconstruction[];
  candidates: CandidateBinding[];
  validation?: DestinationValidation;
  error?: PortableError;
}

/** The persisted transition data, as destination preparation reads it. */
interface TransitionData {
  workspaceRevisionId?: string;
  sourceName?: string;
  destination?: DestinationRequest;
  requiredResources?: string[];
  reconstruct?: ReconstructionRecipe[];
  inventory?: Array<{
    resourceId: string;
    type: string;
    capability: string;
    recovery: RecoveryMode;
    providerResourceId?: string;
  }>;
  candidateAttachmentId?: string;
  environmentId?: string;
  fencingToken?: number;
  copyId?: string;
  reconstruction?: DestinationReconstruction[];
  candidates?: CandidateBinding[];
  validation?: DestinationValidation;
}

/**
 * Provision, materialize, reconstruct, bind, and validate the
 * destination of one replacement (SPEC.md section 13.2, phases 3 to
 * 5).
 *
 * The acquisition runs through the ordinary durable protocol under the
 * transition's request identity, `replace:<transitionId>`: a call
 * interrupted at any point re-enters, reconciles the same acquisition,
 * and never allocates a second environment. Each step checks its
 * recorded output first, so a resumed call redoes only what never
 * landed. Recipe steps address their operations by deterministic
 * identity, so a rerun of a partially finished recipe adopts the
 * recorded operations instead of dispatching duplicates.
 *
 * Candidate bindings are new bindings under the candidate attachment;
 * the source keeps every binding and all authority until the switch
 * transaction. A failure marks the transition `failed` and returns the
 * report; releasing the candidate is the abort flow's work.
 */
export async function prepareDestination(
  store: ControlStore,
  transitionId: string,
  options: DestinationOptions,
): Promise<DestinationReport> {
  const current = store.getTransition(transitionId);
  if (current === null) {
    throw invalidRequestError(`Transition ${transitionId} does not exist.`, {
      transitionId,
    });
  }
  const { sessionId, attachmentId } = current;
  const session = store.getSession(sessionId);
  if (session === null) {
    throw invalidRequestError(`Session ${sessionId} does not exist.`, { sessionId });
  }
  if (current.phase === "validated") {
    return recordedReport(store, current);
  }
  if (current.phase !== "checkpointed" && !RESUMABLE.has(current.phase)) {
    throw invalidRequestError(
      `Transition ${transitionId} is ${current.phase}; destination preparation needs a checkpointed transition.`,
      { transitionId, phase: current.phase },
    );
  }
  const stream =
    options.redactor === undefined
      ? new SessionEventStream(store, sessionId)
      : new SessionEventStream(store, sessionId, options.redactor);
  const transition: TransitionRecord = current;

  try {
    const provisioned = await provision(store, stream, transition, session.policyRef, options);
    const materialized = materialize(store, stream, transition, options);
    const reconstructed = await reconstruct(store, stream, transition, provisioned, options);
    const candidates = await bindCandidates(store, transition, provisioned, options);
    const validation = await validate(
      store,
      stream,
      transition,
      provisioned,
      materialized,
      candidates,
      options,
    );
    transitionPhase(
      store,
      transitionId,
      "validating",
      "validated",
      { validation },
      stream,
      `Destination validated: attachment ${provisioned.attachmentId}.`,
    );
    return {
      transitionId,
      sessionId,
      sourceAttachmentId: attachmentId,
      candidateAttachmentId: provisioned.attachmentId,
      environmentId: provisioned.environmentId,
      copyId: materialized.copyId,
      copyRoot: materialized.copyRoot,
      state: "validated",
      reconstruction: reconstructed,
      candidates,
      validation,
    };
  } catch (error) {
    const portable = toPortableError(error);
    const failed = store.getTransition(transitionId);
    if (failed !== null && failed.phase !== "failed") {
      transitionPhase(
        store,
        transitionId,
        failed.phase,
        "failed",
        { error: sanitizeError(portable) },
        stream,
        `Destination preparation failed: ${portable.code}.`,
      );
    }
    const data = (failed?.data ?? {}) as TransitionData;
    return {
      transitionId,
      sessionId,
      sourceAttachmentId: attachmentId,
      candidateAttachmentId: data.candidateAttachmentId ?? "",
      environmentId: data.environmentId ?? "",
      copyId: data.copyId ?? "",
      copyRoot: workingCopyRoot(store, data.copyId) ?? options.copyRoot,
      state: "failed",
      reconstruction: data.reconstruction ?? [],
      candidates: data.candidates ?? [],
      error: portable,
    };
  }
}

/** Phases destination preparation resumes from. */
const RESUMABLE = new Set([
  "provisioning",
  "provisioned",
  "materializing",
  "materialized",
  "reconstructing",
  "reconstructed",
  "validating",
]);

/** What the provision step established. */
interface Provisioned {
  attachmentId: string;
  environmentId: string;
}

/** Phase 3: acquire the destination under the transition identity. */
async function provision(
  store: ControlStore,
  stream: SessionEventStream,
  transition: TransitionRecord,
  policyRef: string,
  options: DestinationOptions,
): Promise<Provisioned> {
  const data = transition.data as TransitionData;
  if (data.candidateAttachmentId !== undefined && data.environmentId !== undefined) {
    const summary = store.getAttachment(data.candidateAttachmentId);
    if (summary === null || summary.environmentId === undefined) {
      throw providerUnavailableError(
        `The recorded destination attachment ${data.candidateAttachmentId} is gone.`,
        { attachmentId: data.candidateAttachmentId },
      );
    }
    return { attachmentId: summary.attachmentId, environmentId: summary.environmentId };
  }
  const wanted = requireDestination(transition.id, data);
  enterPhase(
    store,
    transition.id,
    "checkpointed",
    "provisioning",
    {},
    stream,
    "Provisioning the destination.",
  );
  // Attachment names are unique per session and the source keeps its
  // name until the switch, so the candidate carries a derived one.
  const summary = await attachEnvironment(store, transition.sessionId, policyRef, {
    adapter: options.adapter,
    request: {
      // Names match ^[a-z][a-z0-9_-]{0,62}$; the derived candidate
      // name stays inside it and never collides with the source.
      name: `${wanted.sourceName}_${transition.id}`.slice(0, 63),
      ...wanted.destination,
    },
    requestKey: `replace:${transition.id}`,
    principal: options.principal,
    authority: options.authority,
    ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
    ...(options.responseTimeoutMs !== undefined
      ? { responseTimeoutMs: options.responseTimeoutMs }
      : {}),
    ...(options.redactor !== undefined ? { redactor: options.redactor } : {}),
  });
  if (summary.environmentId === undefined) {
    throw providerUnavailableError(
      `The destination attachment ${summary.attachmentId} reports no environment.`,
      { attachmentId: summary.attachmentId },
    );
  }
  transitionPhase(
    store,
    transition.id,
    "provisioning",
    "provisioned",
    { candidateAttachmentId: summary.attachmentId, environmentId: summary.environmentId },
    stream,
    `Destination provisioned: environment ${summary.environmentId}.`,
  );
  return { attachmentId: summary.attachmentId, environmentId: summary.environmentId };
}

/** What the materialize step established. */
interface Materialized {
  copyId: string;
  copyRoot: string;
}

/** Phase 4a: restore the transfer revision into the destination copy. */
function materialize(
  store: ControlStore,
  stream: SessionEventStream,
  transition: TransitionRecord,
  options: DestinationOptions,
): Materialized {
  const data = transition.data as TransitionData;
  const revisionId = data.workspaceRevisionId;
  if (revisionId === undefined) {
    throw invalidRequestError(
      `Transition ${transition.id} carries no transfer revision.`,
      { transitionId: transition.id },
    );
  }
  if (data.copyId !== undefined) {
    const record = store.getWorkingCopy(data.copyId);
    if (record === null) {
      throw integrityFailureError(`working copy ${data.copyId}`, "recorded", "absent");
    }
    return { copyId: record.id, copyRoot: record.rootPath };
  }
  enterPhase(
    store,
    transition.id,
    "provisioned",
    "materializing",
    {},
    stream,
    "Materializing the transfer revision.",
  );
  // A crash between the file write and this call leaves the record
  // behind; the recorded path is the output the redo looks for.
  const existing = store.getWorkingCopyByPath(transition.sessionId, options.copyRoot);
  const copy =
    existing ??
    materializeRevision(
      store,
      transition.sessionId,
      options.blobs,
      revisionId,
      options.copyRoot,
      {
        authority: options.authority,
        mode: data.destination?.workspace?.mode ?? "proposal",
      },
    ).record;
  transitionPhase(
    store,
    transition.id,
    "materializing",
    "materialized",
    { copyId: copy.id },
    stream,
    `Revision materialized into copy ${copy.id}.`,
  );
  return { copyId: copy.id, copyRoot: copy.rootPath };
}

/** Phase 4b: run the declared recipes through the destination lease. */
async function reconstruct(
  store: ControlStore,
  stream: SessionEventStream,
  transition: TransitionRecord,
  provisioned: Provisioned,
  options: DestinationOptions,
): Promise<DestinationReconstruction[]> {
  const data = transition.data as TransitionData;
  if (data.reconstruction !== undefined) {
    return data.reconstruction;
  }
  const recipes = data.reconstruct ?? [];
  enterPhase(
    store,
    transition.id,
    "materialized",
    "reconstructing",
    {},
    stream,
    `Running ${recipes.length} declared recipe(s).`,
  );
  const lease = await options.leaseOf(provisioned.environmentId);
  const runs: DestinationReconstruction[] = [];
  for (const recipe of recipes) {
    const run = await runReconstructionRecipe(recipe, {
      invoke: (step, operationId) =>
        invokeStep(store, transition, provisioned, lease, step, operationId, options),
    });
    runs.push({
      recipeId: recipe.id,
      outcome: run.outcome,
      ...(run.failureCondition !== undefined ? { failureCondition: run.failureCondition } : {}),
    });
    if (run.outcome === "failed") {
      transitionPhase(
        store,
        transition.id,
        "reconstructing",
        "failed",
        { reconstruction: runs, error: sanitizeError(run.error!) },
        stream,
        `Recipe ${recipe.id} failed` +
          `${run.failureCondition !== undefined ? ` on ${run.failureCondition}` : ""}.`,
      );
      throw handoffBlockedError(
        `Recipe ${recipe.id} failed; the destination cannot be validated.`,
        { recipeId: recipe.id, reason: run.failureCondition ?? run.error?.code },
      );
    }
  }
  transitionPhase(
    store,
    transition.id,
    "reconstructing",
    "reconstructed",
    { reconstruction: runs },
    stream,
    "Declared reconstruction completed.",
  );
  return runs;
}

/**
 * Run one recipe step through the ordinary admission, dispatch, and
 * settle path, under the step's deterministic identity.
 *
 * A step whose operation record already exists — a rerun after an
 * interruption — adopts that record instead of dispatching again. A
 * step still running on the record gets the provider's own answer
 * through `inspect`.
 */
async function invokeStep(
  store: ControlStore,
  transition: TransitionRecord,
  provisioned: Provisioned,
  lease: EnvironmentLease,
  step: ReconstructionRecipe["steps"][number],
  operationId: string,
  options: DestinationOptions,
): Promise<AdapterOperation> {
  const invocation: InvocationRequest = {
    attachment: {
      sessionId: transition.sessionId,
      attachmentId: provisioned.attachmentId,
      generation: 1,
    },
    capability: step.capability,
    operation: step.operation,
    input: step.input,
    requestKey: operationId,
  };
  const admitted = admitInvocation(store, transition.sessionId, invocation, {
    authority: options.authority,
    ...(options.redactor !== undefined ? { redactor: options.redactor } : {}),
  });
  // The durable record owns its own id; the adapter addresses the step
  // by its deterministic identity. A rerun adopts the record either way.
  const record = admitted.operation;
  if (admitted.deduplicated && record.status !== "accepted") {
    if (record.status === "running") {
      const inspected = await lease.inspect(operationId);
      return {
        operationId,
        status: inspected.status,
        ...(inspected.result !== undefined ? { result: inspected.result } : {}),
        ...(inspected.error !== undefined ? { error: inspected.error } : {}),
      };
    }
    return {
      operationId,
      status: record.status,
      ...(record.resultRef !== undefined ? { result: record.resultRef } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }
  markOperationDispatched(store, transition.sessionId, record.id);
  const answer = await lease.invoke({
    operationId,
    capability: step.capability,
    operation: step.operation,
    input: step.input,
    environmentId: provisioned.environmentId,
    limits: {},
  });
  if (answer.status !== "running") {
    settleStep(store, transition.sessionId, record.id, answer);
  }
  return answer;
}

/** Settle one step outcome durably; a running answer stays running. */
function settleStep(
  store: ControlStore,
  sessionId: string,
  operationId: string,
  answer: AdapterOperation,
): void {
  if (answer.status === "completed") {
    settleOperation(store, sessionId, operationId, {
      kind: "completed",
      resultRef: `op:${operationId}`,
    });
    return;
  }

  const error =
    answer.error ??
    providerUnavailableError(
      `Reconstruction step ${operationId} answered ${answer.status} without an error.`,
      { operationId, status: answer.status },
    );
  const outcome: OperationOutcome =
    answer.status === "cancelled"
      ? { kind: "cancelled", error }
      : answer.status === "unknown"
        ? { kind: "unknown", error }
        : { kind: "failed", error };
  settleOperation(store, sessionId, operationId, outcome);
}

/** Phase 4c: create the candidate resource bindings. */
async function bindCandidates(
  store: ControlStore,
  transition: TransitionRecord,
  provisioned: Provisioned,
  options: DestinationOptions,
): Promise<CandidateBinding[]> {
  const data = transition.data as TransitionData;
  if (data.candidates !== undefined) {
    return data.candidates;
  }
  const crossing = (data.inventory ?? []).filter(
    (entry) => entry.recovery === "reconstruct" || entry.recovery === "reattach",
  );
  const candidates: CandidateBinding[] = [];
  for (const entry of crossing) {
    const description = await bindResource(
      store,
      transition.sessionId,
      {
        type: entry.type,
        owner: {
          sessionId: transition.sessionId,
          attachmentId: provisioned.attachmentId,
          generation: 1,
        },
        capability: entry.capability,
        lifetime: "attachment",
        recovery: entry.recovery,
        ...(entry.providerResourceId !== undefined
          ? { providerResourceId: entry.providerResourceId }
          : {}),
      },
      options.bind,
      { authority: options.authority },
    );
    candidates.push({
      ofResourceId: entry.resourceId,
      resourceId: description.ref.id,
      recovery: entry.recovery,
    });
  }
  return candidates;
}

/** Phase 5: validate the candidate against the request and revision. */
async function validate(
  store: ControlStore,
  stream: SessionEventStream,
  transition: TransitionRecord,
  provisioned: Provisioned,
  materialized: Materialized,
  candidates: CandidateBinding[],
  options: DestinationOptions,
): Promise<DestinationValidation> {
  // The candidates cross with the transition; the validating move is
  // the durable record of the binding step.
  enterPhase(
    store,
    transition.id,
    "reconstructed",
    "validating",
    { candidates },
    stream,
    "Validating the destination.",
  );
  const data = transition.data as TransitionData;
  const wanted = requireDestination(transition.id, data);
  const request: EnvironmentRequest = {
    name: `${wanted.sourceName}_${transition.id}`.slice(0, 63),
    ...wanted.destination,
  };
  const lease = await options.leaseOf(provisioned.environmentId);
  const manifest = await lease.manifest();

  try {
    assertValid(environmentManifestSchema, manifest);
  } catch {
    throw integrityFailureError("the destination manifest", "schema-valid", "invalid");
  }
  const problem = checkTargetSatisfies(request, manifestTarget(manifest));
  if (problem !== null) {
    throw requirementUnsatisfiedError(
      "The destination environment does not satisfy the request.",
      { reason: problem.message },
    );
  }
  verifyWorkingCopyIntegrity(store, options.blobs, materialized.copyRoot, data.workspaceRevisionId!);

  const held = new Set(candidates.map((candidate) => candidate.ofResourceId));
  const missing = (data.requiredResources ?? []).filter((resourceId) => !held.has(resourceId));
  if (missing.length > 0) {
    throw requirementUnsatisfiedError(
      "Required resources hold no candidate binding on the destination.",
      { missing },
    );
  }
  return { manifest: true, satisfies: true, revisionIntegrity: true, requiredResources: true };
}

/**
 * Verify that one working copy still hashes to its revision
 * (SPEC.md section 11.4).
 *
 * The check re-ingests the copy's content into the same
 * content-addressed store, which is idempotent, and compares the
 * rebuilt tree root against the recorded revision root. Any file that
 * changed, appeared, or disappeared between materialization and this
 * check refuses with `IntegrityFailure`.
 */
export function verifyWorkingCopyIntegrity(
  store: ControlStore,
  blobs: BlobStore,
  copyRoot: string,
  revisionId: string,
): string {
  const revision = store.getRevision(revisionId);
  if (revision === null) {
    throw integrityFailureError(`revision ${revisionId}`, "recorded", "absent");
  }
  const rebuilt = buildTreeFromDirectory(copyRoot, blobs);
  if (rebuilt.rootHash !== revision.rootHash) {
    throw integrityFailureError(
      `the working copy at ${copyRoot}`,
      revision.rootHash,
      rebuilt.rootHash,
    );
  }
  return revision.rootHash;
}

/** The destination request and source name one transition carries. */
function requireDestination(
  transitionId: string,
  data: TransitionData,
): { destination: DestinationRequest; sourceName: string } {
  if (data.destination === undefined || data.sourceName === undefined) {
    throw invalidRequestError(
      `Transition ${transitionId} carries no destination request; it predates destination preparation.`,
      { transitionId },
    );
  }
  return { destination: data.destination, sourceName: data.sourceName };
}

/**
 * Enter one phase of the destination flow.
 *
 * A transition already sitting in the target phase skipped this move on
 * an earlier, interrupted call; the move is not redone. Any other phase
 * refuses: the phase machine moves one step at a time.
 */
function enterPhase(
  store: ControlStore,
  transitionId: string,
  from: string,
  to: string,
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
  if (current.phase === to) {
    return;
  }
  if (current.phase !== from) {
    throw staleHandleError(
      { kind: "transition-phase", value: from },
      { kind: "transition-phase", value: current.phase },
    );
  }
  transitionPhase(store, transitionId, from, to, data, stream, detail);
}

/** The report of a transition that already validated. */
function recordedReport(store: ControlStore, transition: TransitionRecord): DestinationReport {
  const data = transition.data as TransitionData;
  return {
    transitionId: transition.id,
    sessionId: transition.sessionId,
    sourceAttachmentId: transition.attachmentId,
    candidateAttachmentId: data.candidateAttachmentId ?? "",
    environmentId: data.environmentId ?? "",
    copyId: data.copyId ?? "",
    copyRoot: workingCopyRoot(store, data.copyId) ?? "",
    state: "validated",
    reconstruction: data.reconstruction ?? [],
    candidates: data.candidates ?? [],
    ...(data.validation !== undefined ? { validation: data.validation } : {}),
  };
}

/** The root path of one recorded working copy, when it still exists. */
function workingCopyRoot(store: ControlStore, copyId: string | undefined): string | null {
  if (copyId === undefined) {
    return null;
  }
  return store.getWorkingCopy(copyId)?.rootPath ?? null;
}
// -- Switch transaction (SPEC.md section 13.3) --------------------------------

/** Options of one switch call. */
export interface SwitchOptions {
  redactor?: EventRedactor;
}

/** The report of one committed switch. */
export interface SwitchReport {
  transitionId: string;
  sessionId: string;
  attachmentId: string;
  oldGeneration: number;
  newGeneration: number;
  /** The environment the switched generation runs on. */
  environmentId: string;
  /** Source bindings the transaction invalidated. */
  invalidatedResourceIds: string[];
  /** Candidate bindings the transaction adopted, by unchanged identity. */
  adoptedResourceIds: string[];
  /** Source cleanup the switch left behind (SPEC.md section 13.4). */
  cleanup: CleanupObligation[];
}

/** The persisted transition data, as the switch reads it. */
interface SwitchData extends TransitionData {
  sourceGeneration?: number;
  switchedAt?: string;
  newGeneration?: number;
  invalidatedResourceIds?: string[];
  adoptedResourceIds?: string[];
  cleanup?: CleanupObligation[];
}

/**
 * Commit one replacement atomically (SPEC.md section 13.3).
 *
 * The transaction verifies the source generation, the mutation
 * fencing token recorded at the checkpoint, and the validated
 * destination record before anything moves. It then records, in one
 * store transaction: the incremented attachment generation bound to
 * the destination environment, the retirement of the candidate
 * attachment record, the invalidation of every source-generation
 * binding, the adoption of the candidate bindings under the new
 * generation, the fence release, the handoff outcome with its durable
 * event, and the source cleanup obligations.
 *
 * Nothing else moves: unrelated attachments keep their generations,
 * and the workspace head is untouched — accepting a proposal is a
 * separate, explicit operation. A repeated call after a lost response
 * finds the transition already switched and returns the committed
 * result without committing anything twice.
 */
export function switchReplacement(
  store: ControlStore,
  transitionId: string,
  options: SwitchOptions = {},
): SwitchReport {
  const current = store.getTransition(transitionId);
  if (current === null) {
    throw invalidRequestError(`Transition ${transitionId} does not exist.`, {
      transitionId,
    });
  }
  if (current.phase === "switched") {
    // The response was lost, not the commit: return what committed.
    return recordedSwitch(current);
  }
  if (current.phase !== "validated") {
    throw invalidRequestError(
      `Transition ${transitionId} is ${current.phase}; only a validated transition switches.`,
      { transitionId, phase: current.phase },
    );
  }
  const { sessionId, attachmentId } = current;
  const data = current.data as SwitchData;
  const stream =
    options.redactor === undefined
      ? new SessionEventStream(store, sessionId)
      : new SessionEventStream(store, sessionId, options.redactor);

  const source = requireSwitchedSource(store, current, data);
  requireRecordedFence(store, current, data);
  const candidate = requireLiveCandidate(store, current, data);
  requireRecordedValidation(current, data);

  const sourceGeneration = source.generation;
  const newGeneration = sourceGeneration + 1;
  const now = new Date().toISOString();
  const reason =
    `Replacement ${transitionId} switched generation ${sourceGeneration} to ${newGeneration}.`;
  // The obligation names the source's acquisition, never the attachment:
  // after the switch the attachment record belongs to the destination,
  // and a cleanup pass must not touch it (SPEC.md section 13.4).
  const sourceAcquisition = store.getAcquisitionForAttachment(sessionId, attachmentId);
  const cleanup: CleanupObligation[] = [
    {
      id: `cleanup-${randomUUID()}`,
      kind: "release",
      targetId: source.environmentId ?? attachmentId,
      detail: "Release the replaced source environment after the switch.",
      createdAt: now,
      ...(sourceAcquisition !== null
        ? {
            extensions: {
              "portable.runtime.acquisition-id": sourceAcquisition.acquisitionId,
            },
          }
        : {}),
    },
  ];

  const invalidatedResourceIds: string[] = [];
  const adoptedResourceIds: string[] = [];
  try {
    store.transaction(() => {
      const switched = store.casAttachment(
        attachmentId,
        { status: "replacing", generation: sourceGeneration },
        {
          sessionId: source.sessionId,
          attachmentId,
          name: source.name,
          generation: newGeneration,
          status: "active",
          environmentId: candidate.environmentId!,
          ...(candidate.providerId !== undefined ? { providerId: candidate.providerId } : {}),
          capabilityIds: candidate.capabilityIds,
          ...(candidate.leaseExpiresAt !== undefined
            ? { leaseExpiresAt: candidate.leaseExpiresAt }
            : {}),
          ...(source.extensions !== undefined ? { extensions: source.extensions } : {}),
        },
      );
      if (switched === null) {
        throw staleHandleError(
          {
            kind: "attachment-state",
            value: { status: "replacing", generation: sourceGeneration },
          },
          {
            kind: "attachment-state",
            value: { status: source.status, generation: source.generation },
          },
        );
      }
      // The candidate record retires; its environment lives on under
      // the switched attachment. The extension records where it went.
      const retired = store.casAttachment(
        candidate.attachmentId,
        { status: "active", generation: candidate.generation },
        {
          ...candidate,
          status: "released",
          extensions: {
            ...candidate.extensions,
            "portable.runtime.merged-into": attachmentId,
            "portable.runtime.merged-generation": newGeneration,
          },
        },
      );
      if (retired === null) {
        throw staleHandleError(
          {
            kind: "attachment-state",
            value: { status: "active", generation: candidate.generation },
          },
          {
            kind: "attachment-state",
            value: { status: candidate.status, generation: candidate.generation },
          },
        );
      }

      // Every source-generation handle dies here, native and
      // superseded alike: the candidate bindings are the live ones.
      for (const entry of data.inventory ?? []) {
        const updated = store.markResourceBindingInvalidated(entry.resourceId, reason, now);
        if (updated !== null) {
          invalidatedResourceIds.push(entry.resourceId);
          stream.append("resource.invalidated", updated.id, {
            resourceId: updated.id,
            reason,
            ownerGeneration: sourceGeneration,
            attachmentId,
          });
        }
      }

      // Candidate bindings keep their identities and move to the new
      // generation: callers hold these handles across the switch.
      for (const binding of store.transferResourceBindings(
        sessionId,
        candidate.attachmentId,
        candidate.generation,
        attachmentId,
        newGeneration,
      )) {
        adoptedResourceIds.push(binding.id);
      }

      // The fence drops with the commit: a managed writer may lease
      // the switched generation afresh.
      store.releaseMutationLease(sessionId, attachmentId, data.fencingToken!);

      for (const obligation of cleanup) {
        store.insertCleanup(sessionId, obligation);
        stream.append("cleanup.pending", obligation.id, {
          cleanupId: obligation.id,
          kind: obligation.kind,
          targetId: obligation.targetId,
          ...(obligation.detail !== undefined ? { detail: obligation.detail } : {}),
        });
      }

      const moved = store.casTransition(transitionId, { phase: "validated" }, {
        ...current,
        phase: "switched",
        data: {
          ...current.data,
          switchedAt: now,
          newGeneration,
          invalidatedResourceIds,
          adoptedResourceIds,
          cleanup,
        },
        updatedAt: now,
      });
      if (moved === null) {
        throw staleHandleError(
          { kind: "transition-phase", value: "validated" },
          { kind: "transition-phase", value: current.phase },
        );
      }
      stream.append("handoff.updated", transitionId, {
        transitionId,
        phase: "switched",
        outcome: "completed",
        oldGeneration: sourceGeneration,
        newGeneration,
        detail: `Attachment ${attachmentId} switched to environment ${String(candidate.environmentId)}.`,
      });
    });
  } catch (error) {
    if (error instanceof StoreError) {
      // The store refused mid-transaction; all of it rolled back.
      throw error.toPortableError();
    }
    throw error;
  }

  return {
    transitionId,
    sessionId,
    attachmentId,
    oldGeneration: sourceGeneration,
    newGeneration,
    environmentId: candidate.environmentId ?? "",
    invalidatedResourceIds,
    adoptedResourceIds,
    cleanup,
  };
}

/** The quiesced source of one switch, at the recorded generation. */
function requireSwitchedSource(
  store: ControlStore,
  transition: TransitionRecord,
  data: SwitchData,
): AttachmentSummary {
  const source = store.getAttachment(transition.attachmentId);
  if (source === null || source.sessionId !== transition.sessionId) {
    throw staleHandleError(
      { kind: "attachment", value: transition.attachmentId },
      { kind: "attachment", value: null },
    );
  }
  if (
    data.sourceGeneration === undefined ||
    source.generation !== data.sourceGeneration ||
    source.status !== "replacing"
  ) {
    throw staleHandleError(
      {
        kind: "attachment-state",
        value: { status: "replacing", generation: data.sourceGeneration },
      },
      {
        kind: "attachment-state",
        value: { status: source.status, generation: source.generation },
      },
    );
  }
  return source;
}

/**
 * The mutation fence of one switch.
 *
 * The lease row must still name this transition with the token the
 * checkpoint recorded. A released or superseded row means the fence
 * was given up: no switch may commit over that history.
 */
function requireRecordedFence(
  store: ControlStore,
  transition: TransitionRecord,
  data: SwitchData,
): void {
  const lease = store.getMutationLease(transition.sessionId, transition.attachmentId);
  if (
    data.fencingToken === undefined ||
    lease === null ||
    lease.releasedAt !== undefined ||
    lease.holder !== `replacement:${transition.id}` ||
    lease.fencingToken !== data.fencingToken
  ) {
    throw staleHandleError(
      { kind: "fencing-token", value: data.fencingToken ?? 0 },
      { kind: "fencing-token", value: lease?.fencingToken ?? 0 },
    );
  }
}

/** The candidate attachment of one switch, still live. */
function requireLiveCandidate(
  store: ControlStore,
  transition: TransitionRecord,
  data: SwitchData,
): AttachmentSummary {
  if (data.candidateAttachmentId === undefined || data.environmentId === undefined) {
    throw handoffBlockedError(
      `Transition ${transition.id} carries no provisioned destination to switch to.`,
      { transitionId: transition.id, reason: "destination-absent" },
    );
  }
  const candidate = store.getAttachment(data.candidateAttachmentId);
  if (candidate === null || candidate.sessionId !== transition.sessionId) {
    throw staleHandleError(
      { kind: "attachment", value: data.candidateAttachmentId },
      { kind: "attachment", value: null },
    );
  }
  if (candidate.status !== "active") {
    throw staleHandleError(
      { kind: "attachment-status", value: "active" },
      { kind: "attachment-status", value: candidate.status },
    );
  }
  if (candidate.environmentId === undefined) {
    throw providerUnavailableError(
      `The candidate attachment ${candidate.attachmentId} reports no environment.`,
      { attachmentId: candidate.attachmentId },
    );
  }
  return candidate;
}

/** The validated destination state of one switch. */
function requireRecordedValidation(
  transition: TransitionRecord,
  data: SwitchData,
): void {
  const validation = data.validation;
  if (
    validation === undefined ||
    !validation.manifest ||
    !validation.satisfies ||
    !validation.revisionIntegrity ||
    !validation.requiredResources
  ) {
    throw handoffBlockedError(
      `The destination of transition ${transition.id} never validated; the switch refuses.`,
      { transitionId: transition.id, reason: "destination-not-validated" },
    );
  }
}

/** The report of a transition that already switched. */
function recordedSwitch(transition: TransitionRecord): SwitchReport {
  const data = transition.data as SwitchData;
  return {
    transitionId: transition.id,
    sessionId: transition.sessionId,
    attachmentId: transition.attachmentId,
    oldGeneration: data.sourceGeneration ?? 0,
    newGeneration: data.newGeneration ?? 0,
    environmentId: data.environmentId ?? "",
    invalidatedResourceIds: data.invalidatedResourceIds ?? [],
    adoptedResourceIds: data.adoptedResourceIds ?? [],
    cleanup: data.cleanup ?? [],
  };
}
// -- Abort and forward recovery (SPEC.md section 13.4) -------------------------

/** Options of one abort call. */
export interface AbortOptions {
  redactor?: EventRedactor;
}

/**
 * One reconstruction effect that landed before an abort and survives
 * it (SPEC.md section 13.4).
 *
 * There is no transaction across arbitrary external systems, so an
 * aborted replacement may leave effects behind. The report lists
 * them instead of hiding them.
 */
export interface SurvivingEffect {
  kind: "environment" | "working-copy" | "recipe";
  /** The durable identity of the effect. */
  ref: string;
  detail: string;
}

/** The report of one aborted replacement transition. */
export interface AbortReport {
  transitionId: string;
  sessionId: string;
  attachmentId: string;
  /** The generation the source keeps; an abort never advances it. */
  sourceGeneration: number;
  /** The candidate attachment record the abort released, when one existed. */
  releasedCandidateAttachmentId?: string;
  /** The environment the released candidate ran on. */
  releasedEnvironmentId?: string;
  /** Candidate bindings the abort invalidated. */
  invalidatedResourceIds: string[];
  /** Reconstruction effects that landed before the abort. */
  survivingEffects: SurvivingEffect[];
  /**
   * Source services that may need rebuilding: a reattach recovery can
   * move the provider-side state to the candidate, so the retained
   * source binding does not prove the service still sits there.
   */
  rebuildResourceIds: string[];
  /** Cleanup obligations the abort recorded. */
  cleanup: CleanupObligation[];
}

/** The persisted transition data, as the abort reads it back. */
interface AbortData extends TransitionData {
  sourceGeneration?: number;
  abortedAt?: string;
  abort?: {
    releasedCandidateAttachmentId?: string;
    releasedEnvironmentId?: string;
    invalidatedResourceIds: string[];
    survivingEffects: SurvivingEffect[];
    rebuildResourceIds: string[];
    cleanup: CleanupObligation[];
  };
}

/** Phases an abort may still act on: everything before the switch. */
const ABORTABLE = new Set([
  "blocked",
  "prepared",
  "checkpointed",
  "provisioning",
  "provisioned",
  "materializing",
  "materialized",
  "reconstructing",
  "reconstructed",
  "validating",
  "validated",
  "failed",
]);

/**
 * Abort one replacement transition (SPEC.md section 13.4).
 *
 * An abort returns the source to authority exactly as the
 * replacement found it: the attachment reactivates at its unchanged
 * generation and every source binding stays bound, because no switch
 * ever invalidated them. The candidate side is the abort's work: the
 * candidate attachment record releases, its bindings invalidate, and
 * a cleanup obligation journals the provider-side release so it
 * retries independently.
 *
 * A committed switch is the boundary recovery never crosses. An
 * abort of a switched transition refuses: the old generation must
 * not reactivate, and a failed destination needs a new transition.
 * A repeated call over an aborted transition returns the recorded
 * report without doing anything twice.
 */
export function abortReplacement(
  store: ControlStore,
  transitionId: string,
  options: AbortOptions = {},
): AbortReport {
  const current = store.getTransition(transitionId);
  if (current === null) {
    throw invalidRequestError(`Transition ${transitionId} does not exist.`, {
      transitionId,
    });
  }
  if (current.phase === "aborted") {
    // The response was lost, not the abort: return what happened.
    return recordedAbort(current);
  }
  if (current.phase === "switched") {
    throw handoffBlockedError(
      `Transition ${transitionId} committed its switch; the old generation must not reactivate.`,
      {
        transitionId,
        reason: "switch-committed",
        newGeneration: (current.data as SwitchData).newGeneration,
      },
    );
  }
  if (!ABORTABLE.has(current.phase)) {
    throw invalidRequestError(
      `Transition ${transitionId} is ${current.phase}; this phase aborts nothing.`,
      { transitionId, phase: current.phase },
    );
  }
  const { sessionId, attachmentId } = current;
  const data = current.data as AbortData;
  const stream =
    options.redactor === undefined
      ? new SessionEventStream(store, sessionId)
      : new SessionEventStream(store, sessionId, options.redactor);

  const source = requireAbortableSource(store, current, data);
  if (data.fencingToken !== undefined) {
    requireRecordedFence(store, current, data as SwitchData);
  }

  const now = new Date().toISOString();
  const reason = `Replacement ${transitionId} aborted before the switch.`;
  // Effects that landed before this call survive the abort; the
  // report lists them instead of pretending they rolled back.
  const survivingEffects: SurvivingEffect[] = [];
  if (data.environmentId !== undefined) {
    survivingEffects.push({
      kind: "environment",
      ref: data.environmentId,
      detail: "The candidate environment was allocated; its release retries through cleanup.",
    });
  }
  if (data.copyId !== undefined) {
    survivingEffects.push({
      kind: "working-copy",
      ref: data.copyId,
      detail: "The materialized working copy stays on disk until cleaned up.",
    });
  }
  for (const run of data.reconstruction ?? []) {
    if (run.outcome === "completed") {
      survivingEffects.push({
        kind: "recipe",
        ref: run.recipeId,
        detail: "The reconstruction recipe completed; its effects persist outside the control store.",
      });
    }
  }
  const rebuildResourceIds = (data.inventory ?? [])
    .filter((entry) => entry.recovery === "reattach")
    .map((entry) => entry.resourceId);

  const invalidatedResourceIds: string[] = [];
  const cleanup: CleanupObligation[] = [];
  const candidate =
    data.candidateAttachmentId === undefined
      ? null
      : store.getAttachment(data.candidateAttachmentId);
  if (candidate !== null && candidate.sessionId === sessionId) {
    // The obligation names the candidate's acquisition when one
    // exists, so a cleanup pass can release the provider side
    // mechanically; it never names the reactivated source.
    const acquisition = store.getAcquisitionForAttachment(sessionId, candidate.attachmentId);
    cleanup.push({
      id: `cleanup-${randomUUID()}`,
      kind: "release",
      targetId: candidate.environmentId ?? candidate.attachmentId,
      detail: "Release the aborted candidate environment.",
      createdAt: now,
      ...(acquisition !== null
        ? {
            extensions: {
              "portable.runtime.acquisition-id": acquisition.acquisitionId,
            },
          }
        : {
            extensions: { "portable.runtime.attachment-id": candidate.attachmentId },
          }),
    });
  }

  try {
    store.transaction(() => {
      // The source returns to authority at its unchanged generation.
      const reactivated = store.casAttachment(
        attachmentId,
        { status: "replacing", generation: source.generation },
        { ...source, status: "active" },
      );
      if (reactivated === null) {
        throw staleHandleError(
          {
            kind: "attachment-state",
            value: { status: "replacing", generation: source.generation },
          },
          {
            kind: "attachment-state",
            value: { status: source.status, generation: source.generation },
          },
        );
      }

      // The candidate record retires under this transition's name.
      if (candidate !== null && candidate.sessionId === sessionId && candidate.status === "active") {
        const retired = store.casAttachment(
          candidate.attachmentId,
          { status: "active", generation: candidate.generation },
          {
            ...candidate,
            status: "released",
            extensions: {
              ...candidate.extensions,
              "portable.runtime.aborted-by": transitionId,
            },
          },
        );
        if (retired === null) {
          throw staleHandleError(
            { kind: "attachment-status", value: "active" },
            { kind: "attachment-status", value: candidate.status },
          );
        }
      }

      // Candidate bindings die with the candidate: the source kept
      // its own bindings the whole time.
      if (candidate !== null && candidate.sessionId === sessionId) {
        for (const binding of store.listResourceBindingsForOwner(
          sessionId,
          candidate.attachmentId,
          candidate.generation,
          true,
        )) {
          const updated = store.markResourceBindingInvalidated(binding.id, reason, now);
          if (updated !== null) {
            invalidatedResourceIds.push(updated.id);
            stream.append("resource.invalidated", updated.id, {
              resourceId: updated.id,
              reason,
              ownerGeneration: candidate.generation,
              attachmentId: candidate.attachmentId,
            });
          }
        }
      }

      // The fence the checkpoint raised drops with the abort.
      if (data.fencingToken !== undefined) {
        store.releaseMutationLease(sessionId, attachmentId, data.fencingToken);
      }

      for (const obligation of cleanup) {
        store.insertCleanup(sessionId, obligation);
        stream.append("cleanup.pending", obligation.id, {
          cleanupId: obligation.id,
          kind: obligation.kind,
          targetId: obligation.targetId,
          ...(obligation.detail !== undefined ? { detail: obligation.detail } : {}),
        });
      }

      const moved = store.casTransition(transitionId, { phase: current.phase }, {
        ...current,
        phase: "aborted",
        data: {
          ...current.data,
          abortedAt: now,
          abort: {
            ...(candidate !== null && candidate.sessionId === sessionId
              ? {
                  releasedCandidateAttachmentId: candidate.attachmentId,
                  releasedEnvironmentId: candidate.environmentId,
                }
              : {}),
            invalidatedResourceIds,
            survivingEffects,
            rebuildResourceIds,
            cleanup,
          },
        },
        updatedAt: now,
      });
      if (moved === null) {
        throw staleHandleError(
          { kind: "transition-phase", value: current.phase },
          { kind: "transition-phase", value: current.phase },
        );
      }
      stream.append("handoff.updated", transitionId, {
        transitionId,
        phase: "aborted",
        outcome: "aborted",
        oldGeneration: source.generation,
        detail: `Attachment ${attachmentId} returned to generation ${source.generation} without a switch.`,
      });
    });
  } catch (error) {
    if (error instanceof StoreError) {
      // The store refused mid-transaction; all of it rolled back.
      throw error.toPortableError();
    }
    throw error;
  }

  return {
    transitionId,
    sessionId,
    attachmentId,
    sourceGeneration: source.generation,
    ...(candidate !== null && candidate.sessionId === sessionId
      ? {
          releasedCandidateAttachmentId: candidate.attachmentId,
          releasedEnvironmentId: candidate.environmentId,
        }
      : {}),
    invalidatedResourceIds,
    survivingEffects,
    rebuildResourceIds,
    cleanup,
  };
}

/**
 * The quiesced source of one abort, at its recorded generation.
 *
 * Anything other than a fenced, quiesced attachment means the
 * transition no longer describes reality; the abort refuses rather
 * than reactivate an attachment it cannot account for.
 */
function requireAbortableSource(
  store: ControlStore,
  transition: TransitionRecord,
  data: AbortData,
): AttachmentSummary {
  const source = store.getAttachment(transition.attachmentId);
  if (source === null || source.sessionId !== transition.sessionId) {
    throw staleHandleError(
      { kind: "attachment", value: transition.attachmentId },
      { kind: "attachment", value: null },
    );
  }
  if (
    source.status !== "replacing" ||
    (data.sourceGeneration !== undefined && source.generation !== data.sourceGeneration)
  ) {
    throw staleHandleError(
      {
        kind: "attachment-state",
        value: { status: "replacing", generation: data.sourceGeneration },
      },
      {
        kind: "attachment-state",
        value: { status: source.status, generation: source.generation },
      },
    );
  }
  return source;
}

/** The report of a transition that already aborted. */
function recordedAbort(transition: TransitionRecord): AbortReport {
  const data = transition.data as AbortData;
  const recorded = data.abort;
  return {
    transitionId: transition.id,
    sessionId: transition.sessionId,
    attachmentId: transition.attachmentId,
    sourceGeneration: data.sourceGeneration ?? 0,
    ...(recorded?.releasedCandidateAttachmentId !== undefined
      ? { releasedCandidateAttachmentId: recorded.releasedCandidateAttachmentId }
      : {}),
    ...(recorded?.releasedEnvironmentId !== undefined
      ? { releasedEnvironmentId: recorded.releasedEnvironmentId }
      : {}),
    invalidatedResourceIds: recorded?.invalidatedResourceIds ?? [],
    survivingEffects: recorded?.survivingEffects ?? [],
    rebuildResourceIds: recorded?.rebuildResourceIds ?? [],
    cleanup: recorded?.cleanup ?? [],
  };
}
