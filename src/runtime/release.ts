import { randomUUID } from "node:crypto";
import { invalidRequestError, staleHandleError } from "../core/errors.js";
import { nowUtcTimestamp } from "../core/time.js";
import type {
  AcquisitionStatus,
  EnvironmentAdapter,
  ReleaseResult,
} from "../schema/adapter.js";
import type { AttachmentRef, AttachmentSummary, SessionRecord } from "../schema/session.js";
import type { CleanupObligation } from "../schema/handoff.js";
import type { OperationRecord } from "../schema/operation.js";
import type { ResourceDescription } from "../schema/resource.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";
import { storedRequestOf } from "./acquisition.js";
import { invalidateOwnedResources } from "./resources.js";

/**
 * Attachment release, session close, and session reopen (SPEC.md
 * sections 5.1, 5.3, 8, 8.1, and 15).
 *
 * Release asks the provider to confirm and sweeps the handles the
 * attachment owned; nothing is released or invalidated without that
 * confirmation. A provider that cannot confirm leaves a cleanup
 * obligation behind, and the attachment stays `releasing` — blocked
 * from new work — until a cleanup pass confirms.
 *
 * Closing moves the session to `closing` first, so new work refuses
 * from that commit onward, and stays `closing` until every attachment
 * is released or its unresolved allocation is recorded as a cleanup
 * obligation.
 *
 * Reopening restores durable records and reconciles what the store
 * owns: lease expiries and operation statuses. It never calls a
 * provider and never claims to restore a harness conversation.
 */

/** Options of one release call. */
export interface ReleaseOptions {
  /** The adapter that owns the environment of this attachment. */
  adapter: EnvironmentAdapter;
  /** Authenticated principal supplied by the embedding application. */
  principal: string;
  /** Mutation lease duration in milliseconds. Default 60000. */
  leaseTtlMs?: number;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** Options of one close call. */
export interface CloseOptions extends ReleaseOptions {
  /** Names this close sweep; per-attachment releases derive from it. */
  requestKey: string;
}

/** Options of one reopen call. */
export interface ReopenOptions {
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** The outcome of one release call. */
export type ReleaseOutcome =
  | {
      /** The provider confirmed the release; owned handles are invalid. */
      status: "released";
      attachment: AttachmentSummary;
      invalidated: ResourceDescription[];
      result: ReleaseResult;
    }
  | {
      /** The attachment was already released; no provider call ran. */
      status: "already-released";
      attachment: AttachmentSummary;
      /** Handles the release invalidated; they stay invalid forever. */
      invalidated: ResourceDescription[];
    }
  | {
      /** The provider did not confirm; the obligation is recorded. */
      status: "unresolved";
      attachment: AttachmentSummary;
      obligation: CleanupObligation;
      detail: string;
    };

/** One attachment's entry in a close report. */
export interface CloseEntry {
  attachmentId: string;
  generation: number;
  outcome: "released" | "already-released" | "unresolved";
  detail?: string;
}

/** The report of one close call. */
export interface CloseReport {
  /** The session record after the sweep. */
  session: SessionRecord;
  /** `closing` means unresolved obligations keep the session visible. */
  status: SessionRecord["status"];
  entries: CloseEntry[];
  /** Cleanup obligations still pending after the sweep. */
  pendingObligations: string[];
  /**
   * In-flight operations at close. Closing rejects new work; it never
   * claims these stopped. Their durable records are untouched.
   */
  inFlightOperations: InFlightOperation[];
}

/** One attachment's lease judgment in a reopen report. */
export interface ReopenAttachmentState {
  attachment: AttachmentSummary;
  /** Lease validity judged from the durable expiry alone. */
  lease: "valid" | "expired" | "none";
  /** The attachment still owes adapter reconciliation. */
  needsReconciliation: boolean;
}

/** The report of one reopen call. */
export interface ReopenReport {
  session: SessionRecord;
  workspace: { workspaceId: string; headRevisionId?: string };
  attachments: ReopenAttachmentState[];
  /** Durable in-flight operations, reported exactly as stored. */
  inFlightOperations: InFlightOperation[];
  /** Explicitly false: reopening restores records, never a conversation. */
  readonly conversationRestored: false;
}

/** One durable operation that has neither settled nor stopped. */
export interface InFlightOperation {
  operationId: string;
  status: OperationRecord["status"];
  attachmentId: string;
}

const DEFAULT_LEASE_TTL_MS = 60_000;
const ATTACHMENT_KEY = "portable.runtime.attachment-id";
const ACQUISITION_KEY = "portable.runtime.acquisition-id";

/**
 * Release one attachment (SPEC.md sections 8, 8.1, and 15).
 *
 * The call serializes on the attachment mutation lease. A confirmed
 * release commits the `released` status, the acquisition's terminal
 * state, the handle invalidations, and the journal event in one fenced
 * transaction. A provider that does not confirm leaves the attachment
 * `releasing` with a pending obligation: release may be retried, by
 * this call or by a cleanup pass, and nothing is claimed released
 * without the provider's answer.
 */
export async function releaseAttachment(
  store: ControlStore,
  sessionId: string,
  policyRef: string,
  attachment: AttachmentRef,
  requestKey: string,
  options: ReleaseOptions,
): Promise<ReleaseOutcome> {
  if (typeof requestKey !== "string" || requestKey.length === 0 || requestKey.length > 256) {
    throw invalidRequestError("The release request key must be 1 to 256 characters.", {
      requestKey,
    });
  }
  if (attachment.sessionId !== sessionId) {
    throw invalidRequestError("The attachment reference names another session.", {
      sessionId,
      attachmentSessionId: attachment.sessionId,
    });
  }
  const initial = requireAttachment(store, sessionId, attachment.attachmentId);
  if (initial.generation !== attachment.generation) {
    throw staleHandleError(
      { kind: "attachment-generation", value: attachment.generation },
      { kind: "attachment-generation", value: initial.generation },
    );
  }
  if (initial.status === "released") {
    // A repeated release never reaches the provider.
    return alreadyReleased(store, sessionId, initial);
  }
  if (!releasable(initial.status)) {
    throw invalidRequestError(
      `Attachment ${attachment.attachmentId} is ${initial.status}; it accepts no release.`,
      { attachmentId: attachment.attachmentId, status: initial.status },
    );
  }

  const stream = new SessionEventStream(store, sessionId, options.redactor);
  const token = takeMutationLease(
    store,
    sessionId,
    attachment.attachmentId,
    `release:${sessionId}:${requestKey}`,
    options.leaseTtlMs,
  );
  try {
    // Re-read under the lease: another release may have finished while
    // this call waited for the lease.
    const current = requireAttachment(store, sessionId, attachment.attachmentId);
    if (current.status === "released") {
      return alreadyReleased(store, sessionId, current);
    }
    if (!releasable(current.status)) {
      throw invalidRequestError(
        `Attachment ${attachment.attachmentId} is ${current.status}; it accepts no release.`,
        { attachmentId: attachment.attachmentId, status: current.status },
      );
    }
    const acquisition = requireAcquisition(store, sessionId, attachment.attachmentId);
    const request = storedRequestOf(acquisition);
    if (request === undefined) {
      throw invalidRequestError(
        `Attachment ${attachment.attachmentId} names no stored request; it predates the durable protocol.`,
        { attachmentId: attachment.attachmentId },
      );
    }

    const marked =
      current.status === "releasing"
        ? current
        : markReleasing(store, stream, sessionId, attachment.attachmentId, token, current, requestKey);
    const lease = await options.adapter.acquire({
      acquisitionId: acquisition.acquisitionId,
      request,
      authority: { principal: options.principal, policyRef },
    });
    const result = await lease.release();
    if (result.status === "released") {
      return confirmRelease(store, stream, sessionId, token, {
        attachmentId: attachment.attachmentId,
        attachment: marked,
        acquisition,
        result,
        ...(options.redactor !== undefined ? { redactor: options.redactor } : {}),
      });
    }
    return recordUnresolved(store, stream, sessionId, token, {
      attachmentId: attachment.attachmentId,
      attachment: marked,
      acquisition,
      detail: result.detail ?? "The provider did not confirm the release.",
    });
  } finally {
    store.releaseMutationLease(sessionId, attachment.attachmentId, token);
  }
}

/**
 * Close one session (SPEC.md sections 5.3 and 15).
 *
 * The session moves to `closing` first, so new work refuses from that
 * commit onward even if every provider call then fails. Each
 * attachment receives one release attempt; failures and unresolved
 * allocations become cleanup obligations, which is what lets the
 * session close honestly: the unresolved state is recorded, not
 * forgotten. The session reaches `closed` only when no attachment is
 * left without a release or an obligation.
 */
export async function closeSession(
  store: ControlStore,
  sessionId: string,
  options: CloseOptions,
): Promise<CloseReport> {
  const session = requireSession(store, sessionId);
  const stream = new SessionEventStream(store, sessionId, options.redactor);
  let status = session.status;

  if (status === "open") {
    const moved = store.casSessionStatus(sessionId, ["open"], "closing");
    if (moved !== null) {
      stream.append("session.closing", sessionId, {
        sessionId,
        requestKey: options.requestKey,
        attachments: store.listAttachments(sessionId).length,
      });
      status = moved.status;
    } else {
      status = requireSession(store, sessionId).status;
    }
  }
  if (status === "closed") {
    // Idempotent: a closed session reports its attachments as they are.
    return closeReport(store, sessionId, entriesAsReleased(store, sessionId), "closed");
  }

  // Unresolved allocations become obligations before releases run:
  // closing records them explicitly instead of dropping them.
  for (const acquisitionId of store.listUnresolvedAcquisitions(sessionId)) {
    recordAllocationObligation(store, stream, sessionId, acquisitionId);
  }

  const entries: CloseEntry[] = [];
  for (const attachment of store.listAttachments(sessionId)) {
    if (attachment.status === "released" || attachment.status === "failed") {
      // Released attachments are done. Failed ones hold no environment:
      // the provider already reported the allocation failed.
      entries.push({
        attachmentId: attachment.attachmentId,
        generation: attachment.generation,
        outcome: "already-released",
        ...(attachment.status === "failed"
          ? {
              detail:
                "The attachment failed before activation; the provider reports nothing allocated.",
            }
          : {}),
      });
      continue;
    }
    let outcome: Awaited<ReturnType<typeof releaseAttachment>> | null = null;
    try {
      outcome = await releaseAttachment(
        store,
        sessionId,
        session.policyRef,
        {
          sessionId,
          attachmentId: attachment.attachmentId,
          generation: attachment.generation,
        },
        `${options.requestKey}:${attachment.attachmentId}:${attachment.generation}`,
        options,
      );
    } catch (error) {
      // A throwing release — a held lease, an unreachable provider —
      // records its unresolved state and never fails the whole sweep.
      const detail = errorMessage(error);
      recordCloseObligation(store, stream, sessionId, attachment, detail);
      entries.push({
        attachmentId: attachment.attachmentId,
        generation: attachment.generation,
        outcome: "unresolved",
        detail,
      });
      continue;
    }
    entries.push(
      outcome.status === "unresolved"
        ? {
            attachmentId: attachment.attachmentId,
            generation: attachment.generation,
            outcome: "unresolved",
            detail: outcome.detail,
          }
        : {
            attachmentId: attachment.attachmentId,
            generation: attachment.generation,
            outcome: outcome.status,
          },
    );
  }

  if (mayClose(store, sessionId)) {
    const moved = store.casSessionStatus(sessionId, ["closing"], "closed");
    if (moved !== null) {
      stream.append("session.closed", sessionId, {
        sessionId,
        requestKey: options.requestKey,
        entries: entries.length,
      });
      status = moved.status;
    }
  }
  return closeReport(store, sessionId, entries, status);
}

/**
 * Reopen one session (SPEC.md sections 5.1 and 17).
 *
 * Reopening restores durable records and reconciles what the store
 * owns. An environment lease whose expiry passed moves the attachment
 * to `unavailable` and records a release obligation — expiry of
 * runtime authority proves nothing about the provider. In-flight
 * operations are reported exactly as stored; provider truth needs
 * per-attachment reconciliation. The report states explicitly that no
 * harness conversation was restored.
 */
export async function reopenSession(
  store: ControlStore,
  sessionId: string,
  options: ReopenOptions = {},
): Promise<ReopenReport> {
  const session = requireSession(store, sessionId);
  const stream = new SessionEventStream(store, sessionId, options.redactor);

  const attachments: ReopenAttachmentState[] = [];
  for (const attachment of store.listAttachments(sessionId)) {
    const expired =
      attachment.leaseExpiresAt !== undefined &&
      Date.parse(attachment.leaseExpiresAt) <= Date.now();
    const reconciled = expired ? expireLease(store, stream, sessionId, attachment) : null;
    const current = reconciled ?? requireAttachment(store, sessionId, attachment.attachmentId);
    attachments.push({
      attachment: current,
      lease: attachment.leaseExpiresAt === undefined ? "none" : expired ? "expired" : "valid",
      needsReconciliation: current.status === "unavailable" || current.status === "releasing",
    });
  }

  const head = store.getWorkspaceHead(session.workspaceId);
  const record = requireSession(store, sessionId);
  return {
    session: record,
    workspace:
      head === null
        ? { workspaceId: record.workspaceId }
        : { workspaceId: record.workspaceId, headRevisionId: head },
    attachments,
    inFlightOperations: inFlightOperations(store, sessionId),
    conversationRestored: false,
  };
}

// -- Release internals -------------------------------------------------------

/** The statuses one release may start from. */
function releasable(status: AttachmentSummary["status"]): boolean {
  return status === "active" || status === "unavailable" || status === "releasing";
}

/** The idempotent answer for an attachment already released. */
function alreadyReleased(
  store: ControlStore,
  sessionId: string,
  attachment: AttachmentSummary,
): ReleaseOutcome {
  return {
    status: "already-released",
    attachment,
    invalidated: invalidatedHandlesOf(store, sessionId, attachment),
  };
}

/** Mark one attachment `releasing` under the lease this flow holds. */
function markReleasing(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  attachmentId: string,
  token: number,
  attachment: AttachmentSummary,
  requestKey: string,
): AttachmentSummary {
  const next: AttachmentSummary = { ...attachment, status: "releasing" };
  fenced(store, sessionId, attachmentId, token, () => {
    stream.commitWith(
      "attachment.releasing",
      attachmentId,
      {
        attachmentId,
        generation: attachment.generation,
        requestKey,
      },
      () => {
        if (store.casAttachment(attachmentId, { status: attachment.status }, next) === null) {
          throw new StoreError(
            "cas-failed",
            `Attachment ${attachmentId} moved before its release began.`,
          );
        }
      },
    );
  });
  return next;
}

/** Commit one provider-confirmed release and its handle sweep. */
function confirmRelease(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  token: number,
  facts: {
    attachmentId: string;
    attachment: AttachmentSummary;
    acquisition: AcquisitionStatus;
    result: ReleaseResult;
    redactor?: EventRedactor;
  },
): ReleaseOutcome {
  const { attachmentId, acquisition } = facts;
  // Re-read: the `releasing` transition moved the record since load.
  const current = store.getAttachment(attachmentId) ?? facts.attachment;
  const next: AttachmentSummary = { ...current, status: "released" };
  let invalidated: ResourceDescription[] = [];
  fenced(store, sessionId, attachmentId, token, () => {
    stream.commitWith(
      "attachment.released",
      attachmentId,
      {
        attachmentId,
        generation: current.generation,
        reason: "explicit-release",
      },
      () => {
        if (store.casAttachment(attachmentId, { status: current.status }, next) === null) {
          throw new StoreError(
            "cas-failed",
            `Attachment ${attachmentId} moved before its release committed.`,
          );
        }
        const stored = store.getAcquisition(acquisition.acquisitionId);
        if (stored !== null) {
          // The acquisition's terminal state follows the attachment; a
          // concurrent state change never blocks the release itself.
          store.casAcquisition(
            acquisition.acquisitionId,
            { state: stored.state },
            { ...stored, state: "released" },
          );
        }
      },
    );
    invalidated = invalidateOwnedResources(
      store,
      sessionId,
      attachmentId,
      current.generation,
      "attachment-released",
      facts.redactor === undefined ? undefined : { redactor: facts.redactor },
    );
  });
  return {
    status: "released",
    attachment: store.getAttachment(attachmentId) ?? next,
    invalidated,
    result: facts.result,
  };
}

/** Record the obligation one unconfirmed release leaves behind. */
function recordUnresolved(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  token: number,
  facts: {
    attachmentId: string;
    attachment: AttachmentSummary;
    acquisition: AcquisitionStatus;
    detail: string;
  },
): ReleaseOutcome {
  const { attachmentId, attachment, acquisition, detail } = facts;
  const environmentId = attachment.environmentId ?? acquisition.environmentId;
  const targetId = environmentId ?? acquisition.acquisitionId;
  const existing = findObligation(store, sessionId, targetId, attachmentId);
  const obligation: CleanupObligation =
    existing ??
    {
      id: `cln-${randomUUID()}`,
      kind: environmentId === undefined ? "other" : "release",
      targetId,
      detail: `Release of ${attachmentId} was not confirmed: ${detail}`,
      createdAt: nowUtcTimestamp(),
      extensions: {
        [ATTACHMENT_KEY]: attachmentId,
        [ACQUISITION_KEY]: acquisition.acquisitionId,
      },
    };
  if (existing === null) {
    fenced(store, sessionId, attachmentId, token, () => {
      store.insertCleanup(sessionId, obligation);
      stream.append("cleanup.pending", obligation.id, {
        cleanupId: obligation.id,
        kind: obligation.kind,
        targetId: obligation.targetId,
        detail: obligation.detail,
      });
    });
  }
  return {
    status: "unresolved",
    attachment: requireAttachment(store, sessionId, attachmentId),
    obligation,
    detail,
  };
}

// -- Close internals ---------------------------------------------------------

/**
 * Whether every attachment is released, failed, or covered by a
 * pending obligation that records its unresolved state.
 */
function mayClose(store: ControlStore, sessionId: string): boolean {
  const pending = store.listCleanup(sessionId, "pending");
  for (const attachment of store.listAttachments(sessionId)) {
    if (attachment.status === "released" || attachment.status === "failed") {
      continue;
    }
    const acquisition = store.getAcquisitionForAttachment(sessionId, attachment.attachmentId);
    const covered = pending.some(
      (entry) =>
        entry.record.extensions?.[ATTACHMENT_KEY] === attachment.attachmentId ||
        (attachment.environmentId !== undefined &&
          entry.record.targetId === attachment.environmentId) ||
        (acquisition !== null && entry.record.targetId === acquisition.acquisitionId),
    );
    if (!covered) {
      return false;
    }
  }
  return true;
}

/** Entries for a session whose attachments need no new attempt. */
function entriesAsReleased(store: ControlStore, sessionId: string): CloseEntry[] {
  return store.listAttachments(sessionId).map((attachment) => ({
    attachmentId: attachment.attachmentId,
    generation: attachment.generation,
    outcome: "already-released" as const,
  }));
}

/** Record the obligation one throwing release leaves behind. */
function recordCloseObligation(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  attachment: AttachmentSummary,
  detail: string,
): void {
  const environmentId = attachment.environmentId;
  const targetId = environmentId ?? attachment.attachmentId;
  if (findObligation(store, sessionId, targetId, attachment.attachmentId) !== null) {
    return;
  }
  const acquisition = store.getAcquisitionForAttachment(sessionId, attachment.attachmentId);
  const obligation: CleanupObligation = {
    id: `cln-${randomUUID()}`,
    kind: environmentId === undefined ? "other" : "release",
    targetId,
    detail: `Close of ${sessionId} could not release ${attachment.attachmentId}: ${detail}`,
    createdAt: nowUtcTimestamp(),
    extensions: {
      [ATTACHMENT_KEY]: attachment.attachmentId,
      ...(acquisition !== null ? { [ACQUISITION_KEY]: acquisition.acquisitionId } : {}),
    },
  };
  try {
    store.transaction(() => {
      store.insertCleanup(sessionId, obligation);
      stream.append("cleanup.pending", obligation.id, {
        cleanupId: obligation.id,
        kind: obligation.kind,
        targetId: obligation.targetId,
        detail: obligation.detail,
      });
    });
  } catch (error) {
    throw portable(error);
  }
}

/** Assemble the close report from persisted state. */
function closeReport(
  store: ControlStore,
  sessionId: string,
  entries: CloseEntry[],
  status: SessionRecord["status"],
): CloseReport {
  return {
    session: requireSession(store, sessionId),
    status,
    entries,
    pendingObligations: store
      .listCleanup(sessionId, "pending")
      .map((entry) => entry.record.id),
    inFlightOperations: inFlightOperations(store, sessionId),
  };
}

/** Record one unresolved acquisition as a cleanup obligation. */
function recordAllocationObligation(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  acquisitionId: string,
): void {
  const acquisition = store.getAcquisition(acquisitionId);
  if (acquisition === null) {
    return;
  }
  const environmentId = acquisition.environmentId;
  const targetId = environmentId ?? acquisitionId;
  if (findObligation(store, sessionId, targetId, undefined) !== null) {
    return;
  }
  const obligation: CleanupObligation = {
    id: `cln-${randomUUID()}`,
    kind: environmentId === undefined ? "unresolved-allocation" : "release",
    targetId,
    detail: `Acquisition ${acquisitionId} is ${acquisition.state}; its allocation outcome is unresolved.`,
    createdAt: nowUtcTimestamp(),
    extensions: { [ACQUISITION_KEY]: acquisitionId },
  };
  try {
    store.transaction(() => {
      store.insertCleanup(sessionId, obligation);
      stream.append("cleanup.pending", obligation.id, {
        cleanupId: obligation.id,
        kind: obligation.kind,
        targetId: obligation.targetId,
        detail: obligation.detail,
      });
    });
  } catch (error) {
    throw portable(error);
  }
}

// -- Reopen internals --------------------------------------------------------

/**
 * Move one attachment past its expired lease, under the mutation lease.
 *
 * Returns the updated attachment, or null when the lease could not be
 * taken or the record moved: the caller then reports the stored state
 * with reconciliation still owed.
 */
function expireLease(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  attachment: AttachmentSummary,
): AttachmentSummary | null {
  const next: AttachmentSummary = { ...attachment, status: "unavailable" };
  const environmentId = attachment.environmentId;
  const expiredAt = attachment.leaseExpiresAt ?? nowUtcTimestamp();
  try {
    const lease = store.acquireMutationLease(
      sessionId,
      attachment.attachmentId,
      `reopen:${sessionId}`,
      DEFAULT_LEASE_TTL_MS,
    );
    try {
      store.mutateWithLease(sessionId, attachment.attachmentId, lease.fencingToken, () => {
        stream.commitWith(
          "lease.expired",
          attachment.attachmentId,
          {
            attachmentId: attachment.attachmentId,
            leaseKind: "environment",
            expiredAt,
            generation: attachment.generation,
          },
          () => {
            const updated = store.casAttachment(
              attachment.attachmentId,
              { status: attachment.status },
              next,
            );
            if (updated === null) {
              return;
            }
            if (
              environmentId !== undefined &&
              findObligation(store, sessionId, environmentId, attachment.attachmentId) === null
            ) {
              const acquisition = store.getAcquisitionForAttachment(
                sessionId,
                attachment.attachmentId,
              );
              const obligation: CleanupObligation = {
                id: `cln-${randomUUID()}`,
                kind: "release",
                targetId: environmentId,
                detail: `Lease of ${attachment.attachmentId} ran out at reopen; provider termination unconfirmed.`,
                createdAt: nowUtcTimestamp(),
                extensions: {
                  [ATTACHMENT_KEY]: attachment.attachmentId,
                  ...(acquisition !== null
                    ? { [ACQUISITION_KEY]: acquisition.acquisitionId }
                    : {}),
                },
              };
              store.insertCleanup(sessionId, obligation);
              stream.append("cleanup.pending", obligation.id, {
                cleanupId: obligation.id,
                kind: obligation.kind,
                targetId: obligation.targetId,
                detail: obligation.detail,
              });
            }
          },
        );
      });
    } finally {
      store.releaseMutationLease(sessionId, attachment.attachmentId, lease.fencingToken);
    }
  } catch {
    // The lease is held or the record moved: report stored state and
    // leave the reconciliation owed.
    return null;
  }
  return store.getAttachment(attachment.attachmentId);
}

/** The durable operations that neither settled nor stopped. */
function inFlightOperations(store: ControlStore, sessionId: string): InFlightOperation[] {
  return store
    .listOperationsBySession(sessionId)
    .filter((operation) => operation.status === "accepted" || operation.status === "running")
    .map((operation) => ({
      operationId: operation.id,
      status: operation.status,
      attachmentId: operation.attachment.attachmentId,
    }));
}

// -- Shared plumbing ---------------------------------------------------------

/** The pending obligation that names one target, or null. */
function findObligation(
  store: ControlStore,
  sessionId: string,
  targetId: string,
  attachmentId: string | undefined,
): CleanupObligation | null {
  for (const entry of store.listCleanup(sessionId, "pending")) {
    if (entry.record.targetId === targetId) {
      return entry.record;
    }
    if (
      attachmentId !== undefined &&
      entry.record.extensions?.[ATTACHMENT_KEY] === attachmentId
    ) {
      return entry.record;
    }
  }
  return null;
}

/** The handles one attachment generation owns that are invalidated. */
function invalidatedHandlesOf(
  store: ControlStore,
  sessionId: string,
  attachment: AttachmentSummary,
): ResourceDescription[] {
  return store
    .listResourceBindingsForOwner(sessionId, attachment.attachmentId, attachment.generation)
    .filter((binding) => binding.status === "invalidated")
    .map((binding) => ({
      ref: {
        id: binding.id,
        sessionId,
        type: binding.type,
        owner: {
          sessionId,
          attachmentId: binding.owner.attachmentId,
          generation: binding.owner.generation,
        },
        lifetime: binding.lifetime,
        recovery: binding.recovery,
        ...(binding.expiresAt !== undefined ? { expiresAt: binding.expiresAt } : {}),
      },
      validity: "released" as const,
      ...(binding.providerResourceId !== undefined
        ? { providerResourceId: binding.providerResourceId }
        : {}),
      detail: binding.invalidationReason ?? "The owning attachment was released.",
    }));
}

/** Load one session or refuse. */
function requireSession(store: ControlStore, sessionId: string): SessionRecord {
  const session = store.getSession(sessionId);
  if (session === null) {
    throw invalidRequestError(`Session ${sessionId} does not exist.`, { sessionId });
  }
  return session;
}

/** Load one attachment or refuse. */
function requireAttachment(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
): AttachmentSummary {
  const attachment = store.getAttachment(attachmentId);
  if (attachment === null || attachment.sessionId !== sessionId) {
    throw invalidRequestError(`Attachment ${attachmentId} does not exist in this session.`, {
      attachmentId,
    });
  }
  return attachment;
}

/** Load the acquisition that serves one attachment. */
function requireAcquisition(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
): AcquisitionStatus {
  const acquisition = store.getAcquisitionForAttachment(sessionId, attachmentId);
  if (acquisition === null) {
    throw invalidRequestError(
      `Attachment ${attachmentId} names no acquisition; it predates the durable protocol.`,
      { attachmentId },
    );
  }
  return acquisition;
}

/** Take the attachment mutation lease. */
function takeMutationLease(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
  holder: string,
  leaseTtlMs: number | undefined,
): number {
  try {
    return store.acquireMutationLease(sessionId, attachmentId, holder, leaseTtlMs ?? DEFAULT_LEASE_TTL_MS)
      .fencingToken;
  } catch (error) {
    throw portable(error);
  }
}

/** Run one body under the mutation lease. */
function fenced<T>(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
  token: number,
  body: () => T,
): T {
  try {
    return store.mutateWithLease(sessionId, attachmentId, token, body);
  } catch (error) {
    throw portable(error);
  }
}

/** Map one store error to its portable form; pass others through. */
function portable(error: unknown): unknown {
  if (error instanceof StoreError) {
    return error.toPortableError();
  }
  return error;
}

/** One-line message of an unknown error. */
function errorMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
