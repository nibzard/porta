import {
  invalidRequestError,
  requirementUnsatisfiedError,
  staleHandleError,
  toPortableError,
} from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import { assertValid } from "../schema/validate.js";
import { replaceRequestSchema } from "../schema/handoff.js";
import type { ReplaceRequest, HandoffPlan, StateDisposition } from "../schema/handoff.js";
import type { ControlStore } from "../store/control-store.js";
import {
  checkReconstructionCoverage,
  checkReconstructionRecipes,
  checkStateDispositions,
  classifyResourceStates,
} from "./reconstruction.js";

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
