import { randomUUID } from "node:crypto";
import {
  invalidRequestError,
  leaseExpiredError,
  providerUnavailableError,
} from "../core/errors.js";
import type { PolicyAuthority } from "../core/policy.js";
import { nowUtcTimestamp } from "../core/time.js";
import type {
  AcquisitionStatus,
  EnvironmentAdapter,
  EnvironmentLease,
  ReleaseResult,
} from "../schema/adapter.js";
import type { CleanupObligation } from "../schema/handoff.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { PortableError } from "../schema/error.js";
import type { EventRedactor } from "../store/event-stream.js";
import { SessionEventStream } from "../store/event-stream.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";
import { dispatchedAtOf, storedRequestOf } from "./acquisition.js";

/**
 * Lease renewal and allocation cleanup (SPEC.md sections 8 and 8.1).
 *
 * Each lease records its expiration on the attachment, and the runtime
 * stops new work after expiration. Expiration of runtime authority
 * never proves provider termination: an attachment whose lease ran out
 * enters `unavailable`, keeps its environment named, and owes a
 * release obligation that stays visible through inspection until the
 * provider confirms the release. Cleanup retries are idempotent,
 * survive restart, and touch only the records an obligation names.
 */

/** Input of one renewal call. */
export interface RenewOptions {
  /** The adapter that owns the environment of this attachment. */
  adapter: EnvironmentAdapter;
  /** Authenticated principal supplied by the embedding application. */
  principal: string;
  /** The policy authority in force for this call. */
  authority: PolicyAuthority;
  /** How far to extend the lease, in milliseconds. */
  durationMs: number;
  /** Mutation lease duration in milliseconds. Default 60000. */
  leaseTtlMs?: number;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** The outcome of one renewal call. */
export type RenewOutcome =
  | { status: "renewed"; attachment: AttachmentSummary }
  | { status: "unsupported"; attachment: AttachmentSummary }
  | { status: "unavailable"; attachment: AttachmentSummary; reason: string };

/** Input of one cleanup pass. */
export interface CleanupOptions {
  /** The adapter that owns the environments of this session. */
  adapter: EnvironmentAdapter;
  /** Authenticated principal supplied by the embedding application. */
  principal: string;
  /** The policy authority in force for this call. */
  authority: PolicyAuthority;
  /** Mutation lease duration in milliseconds. Default 60000. */
  leaseTtlMs?: number;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** The outcome of one cleanup obligation in a pass. */
export interface CleanupOutcome {
  cleanupId: string;
  kind: CleanupObligation["kind"];
  /** `satisfied` clears the obligation; `pending` keeps it visible. */
  outcome: "satisfied" | "pending";
  reason: string;
}

/** The report of one cleanup pass. */
export interface CleanupReport {
  outcomes: CleanupOutcome[];
  /** Obligations still pending after the pass. */
  remaining: number;
}

const DEFAULT_LEASE_TTL_MS = 60_000;
const ATTACHMENT_KEY = "portable.runtime.attachment-id";
const ACQUISITION_KEY = "portable.runtime.acquisition-id";

/**
 * Renew the environment lease of one attachment (SPEC.md section 8).
 *
 * A renewed lease records its new expiry on the attachment and the
 * acquisition. A provider that refuses, or a lease already past its
 * expiry, marks the attachment `unavailable` under a `lease.expired`
 * event and records a release obligation: the runtime's authority ran
 * out, and that alone proves nothing about the provider side.
 */
export async function renewAttachment(
  store: ControlStore,
  sessionId: string,
  policyRef: string,
  attachmentId: string,
  options: RenewOptions,
): Promise<RenewOutcome> {
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs <= 0) {
    throw invalidRequestError("The renewal duration must be a positive whole number.");
  }
  const denied = options.authority.checkLifetime(options.durationMs);
  if (denied !== null) {
    throw denied;
  }
  const attachment = requireAttachment(store, sessionId, attachmentId);
  if (attachment.status !== "active") {
    throw invalidRequestError(
      `Attachment ${attachmentId} is ${attachment.status}; only active attachments renew.`,
      { attachmentId, status: attachment.status },
    );
  }
  const acquisition = requireAcquisition(store, sessionId, attachmentId);
  const request = storedRequestOf(acquisition);
  if (request === undefined) {
    throw invalidRequestError(
      `The acquisition of ${attachmentId} carries no stored request; it predates this runtime.`,
      { attachmentId },
    );
  }

  const stream = new SessionEventStream(store, sessionId, options.redactor);
  const token = takeMutationLease(store, sessionId, attachmentId, leaseTtlMs);
  try {
    // Idempotent acquisition returns the lease of the same environment.
    const lease = await options.adapter.acquire({
      acquisitionId: acquisition.acquisitionId,
      request,
      authority: { principal: options.principal, policyRef },
      limits: options.authority.acquisitionLimits(),
    });
    const expiresAt = offsetMs(nowUtcTimestamp(), options.durationMs);
    const status = await lease.renew(expiresAt);
    if (status.status === "active") {
      if (!status.renewalSupported) {
        return { status: "unsupported", attachment };
      }
      const newExpiry = status.expiresAt ?? expiresAt;
      // Renewal cannot outlive the acquisition's lifetime ceiling:
      // the span is measured from the moment the acquire was
      // authorized, so repeated renewals never widen it.
      const authorizedAt = dispatchedAtOf(acquisition);
      if (authorizedAt !== undefined) {
        const grant = options.authority.checkLeaseGrant({
          authorizedAt,
          expiresAt: newExpiry,
        });
        if (grant !== null) {
          throw grant;
        }
      }
      const next: AttachmentSummary = { ...attachment, leaseExpiresAt: newExpiry };
      fenced(store, sessionId, attachmentId, token, () => {
        store.casAttachment(attachmentId, { status: attachment.status }, next);
        store.casAcquisition(acquisition.acquisitionId, { state: acquisition.state }, {
          ...acquisition,
          expiresAt: newExpiry,
        });
      });
      return { status: "renewed", attachment: next };
    }
    // The provider refused or the lease already ran out: authority is
    // gone, provider termination is not confirmed.
    return await markExpired(store, stream, sessionId, attachmentId, token, {
      attachment,
      acquisition,
      lease,
      reason: status.renewalSupported ? "provider-refused" : "unsupported-after-expiry",
    });
  } finally {
    store.releaseMutationLease(sessionId, attachmentId, token);
  }
}

/**
 * Run one cleanup pass over the session's pending obligations
 * (SPEC.md sections 8 and 8.1).
 *
 * Release obligations retry the idempotent release of exactly the
 * environment they name; unresolved allocations ask the adapter for
 * the truth first and never clear without it. An obligation clears
 * only on provider confirmation, and only from the pass of a provider
 * the adapter offers — one provider never confirms another's release.
 * Obligations that stay pending remain visible through inspection.
 */
export async function runCleanup(
  store: ControlStore,
  sessionId: string,
  policyRef: string,
  options: CleanupOptions,
): Promise<CleanupReport> {
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const stream = new SessionEventStream(store, sessionId, options.redactor);
  const pending = store.listCleanup(sessionId, "pending");
  const outcomes: CleanupOutcome[] = [];
  // The providers this pass's adapter offers. One provider may not
  // confirm another provider's release, so a pass settles only the
  // obligations of providers it serves; the rest stay pending for the
  // pass that owns them.
  const servedProviders = new Set(
    (await options.adapter.describe()).map((offer) => offer.providerId),
  );

  for (const { record } of pending) {
    const attachmentId = typeof record.extensions?.[ATTACHMENT_KEY] === "string"
      ? (record.extensions[ATTACHMENT_KEY] as string)
      : undefined;
    const acquisitionId = typeof record.extensions?.[ACQUISITION_KEY] === "string"
      ? (record.extensions[ACQUISITION_KEY] as string)
      : undefined;
    try {
      const outcome = await settleObligation(store, stream, sessionId, policyRef, options, {
        record,
        attachmentId,
        acquisitionId,
        leaseTtlMs,
        servedProviders,
      });
      outcomes.push(outcome);
    } catch (error) {
      // One obligation never fails the pass: the rest still run.
      outcomes.push({
        cleanupId: record.id,
        kind: record.kind,
        outcome: "pending",
        reason: errorMessage(error),
      });
    }
  }

  const remaining = store.listCleanup(sessionId, "pending").length;
  return { outcomes, remaining };
}

/**
 * Whether an attachment still accepts new operations (SPEC.md 8.1).
 *
 * Expiry of runtime authority and unreachability of the environment
 * are separate refusals with separate codes: `LeaseExpired` says the
 * lease ran out, `ProviderUnavailable` says the attachment awaits
 * reconciliation. Neither claims provider termination.
 */
export function checkAttachmentAcceptsOperations(
  attachment: AttachmentSummary,
): PortableError | null {
  if (attachment.status === "unavailable") {
    return providerUnavailableError(
      `Attachment ${attachment.attachmentId} is unavailable pending reconciliation.`,
      { attachmentId: attachment.attachmentId, status: attachment.status },
    );
  }
  if (attachment.status === "released" || attachment.status === "failed") {
    return invalidRequestError(
      `Attachment ${attachment.attachmentId} is ${attachment.status}.`,
      { attachmentId: attachment.attachmentId, status: attachment.status },
    );
  }
  const expiresAt = attachment.leaseExpiresAt;
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()) {
    return leaseExpiredError(`environment ${attachment.environmentId}`, expiresAt);
  }
  return null;
}

// -- Renewal internals -------------------------------------------------------

/** Records one attachment whose environment authority ran out. */
async function markExpired(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  attachmentId: string,
  token: number,
  facts: {
    attachment: AttachmentSummary;
    acquisition: AcquisitionStatus;
    lease: EnvironmentLease;
    reason: string;
  },
): Promise<RenewOutcome> {
  const { attachment, acquisition, lease, reason } = facts;
  const expiredAt = attachment.leaseExpiresAt ?? nowUtcTimestamp();
  const cleanupId = `cln-${randomUUID()}`;
  const environmentId = attachment.environmentId ?? acquisition.environmentId;
  const owed = store
    .listCleanup(sessionId, "pending")
    .some((entry) => entry.record.targetId === environmentId || entry.record.targetId === acquisition.acquisitionId);

  fenced(store, sessionId, attachmentId, token, () => {
    stream.commitWith(
      "lease.expired",
      attachmentId,
      {
        attachmentId,
        leaseKind: "environment",
        expiredAt,
        generation: attachment.generation,
      },
      () => {
        store.casAttachment(
          attachmentId,
          { status: attachment.status },
          { ...attachment, status: "unavailable" },
        );
        if (!owed && environmentId !== undefined) {
          store.insertCleanup(sessionId, {
            id: cleanupId,
            kind: "release",
            targetId: environmentId,
            detail: `Lease of ${attachmentId} ran out; provider termination unconfirmed.`,
            createdAt: nowUtcTimestamp(),
            extensions: {
              [ATTACHMENT_KEY]: attachmentId,
              [ACQUISITION_KEY]: acquisition.acquisitionId,
            },
          });
        }
      },
    );
  });

  // One best-effort release with the lease in hand. The obligation
  // above already makes the cleanup durable if this attempt dies.
  if (environmentId !== undefined) {
    const released = await releaseOf(lease);
    if (released.status === "released") {
      confirmReleased(store, stream, sessionId, attachmentId, token, {
        attachment,
        acquisition,
        cleanupId: owed ? undefined : cleanupId,
      });
      return {
        status: "unavailable",
        attachment: requireAttachment(store, sessionId, attachmentId),
        reason: `${reason}-released`,
      };
    }
  }
  return {
    status: "unavailable",
    attachment: requireAttachment(store, sessionId, attachmentId),
    reason,
  };
}

/** Mark one attachment released after the provider confirmed it. */
function confirmReleased(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  attachmentId: string,
  token: number,
  facts: {
    attachment: AttachmentSummary;
    acquisition: AcquisitionStatus;
    cleanupId: string | undefined;
  },
): void {
  const { acquisition, cleanupId } = facts;
  // Re-read: the unavailable transition may have moved the record
  // since this flow last loaded it.
  const attachment = store.getAttachment(attachmentId) ?? facts.attachment;
  fenced(store, sessionId, attachmentId, token, () => {
    stream.commitWith(
      "attachment.released",
      attachmentId,
      {
        attachmentId,
        generation: attachment.generation,
        reason: "cleanup-confirmed",
        ...(cleanupId !== undefined ? { cleanupIds: [cleanupId] } : {}),
      },
      () => {
        store.casAcquisition(acquisition.acquisitionId, { state: acquisition.state }, {
          ...acquisition,
          state: "released",
        });
        store.casAttachment(
          attachmentId,
          { status: attachment.status },
          { ...attachment, status: "released" },
        );
        if (cleanupId !== undefined) {
          store.casCleanupStatus(cleanupId, "pending", "satisfied");
        }
      },
    );
  });
}

// -- Cleanup internals -------------------------------------------------------

/** Settle one obligation, touching only the records it names. */
async function settleObligation(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  policyRef: string,
  options: CleanupOptions,
  names: {
    record: CleanupObligation;
    attachmentId: string | undefined;
    acquisitionId: string | undefined;
    leaseTtlMs: number;
    servedProviders: Set<string>;
  },
): Promise<CleanupOutcome> {
  const { record, attachmentId, acquisitionId } = names;
  if (record.kind === "other") {
    // Nothing to retry mechanically; operator attention resolves it.
    return {
      cleanupId: record.id,
      kind: record.kind,
      outcome: "pending",
      reason: "The obligation needs operator attention.",
    };
  }

  const acquisition = resolveAcquisition(store, sessionId, names);
  if (acquisition === null) {
    return {
      cleanupId: record.id,
      kind: record.kind,
      outcome: "pending",
      reason: "The acquisition behind the obligation cannot be found.",
    };
  }
  const request = storedRequestOf(acquisition);
  if (request === undefined) {
    return {
      cleanupId: record.id,
      kind: record.kind,
      outcome: "pending",
      reason: "The acquisition carries no stored request.",
    };
  }
  if (request.providerId !== undefined && !names.servedProviders.has(request.providerId)) {
    // One provider may not confirm another provider's release: a pass
    // settles only what its adapter offers, and the obligation stays
    // pending for the pass that owns it (SPEC.md section 8).
    return {
      cleanupId: record.id,
      kind: record.kind,
      outcome: "pending",
      reason:
        `The obligation belongs to provider ${request.providerId}; ` +
        `this pass serves ${[...names.servedProviders].join(", ")}.`,
    };
  }

  if (record.kind === "unresolved-allocation") {
    // Ask the adapter for the truth before touching anything.
    const status = await options.adapter.reconcile(acquisition.acquisitionId);
    if (status.state !== "allocated") {
      if (status.state === "failed") {
        // The provider says nothing exists: nothing to release.
        commitTerminal(store, stream, sessionId, acquisition, attachmentId, {
          eventType: "attachment.unavailable",
          data: {
            reason: "provider-reported-failure",
            providerConfirmedTermination: true,
          },
          attachmentStatus: "failed",
          acquisitionState: "failed",
        }, record.id, names.leaseTtlMs);
        return {
          cleanupId: record.id,
          kind: record.kind,
          outcome: "satisfied",
          reason: "The provider reported the acquisition failed.",
        };
      }
      return {
        cleanupId: record.id,
        kind: record.kind,
        outcome: "pending",
        reason: `The allocation is still ${status.state}; nothing may be assumed.`,
      };
    }
    if (status.environmentId === undefined) {
      return {
        cleanupId: record.id,
        kind: record.kind,
        outcome: "pending",
        reason: "The reconciled allocation names no environment.",
      };
    }
  }

  // Both kinds end at an idempotent release of the named environment.
  const lease = await options.adapter.acquire({
    acquisitionId: acquisition.acquisitionId,
    request,
    authority: { principal: options.principal, policyRef },
    limits: options.authority.acquisitionLimits(),
  });
  const released = await releaseOf(lease);
  if (released.status !== "released") {
    return {
      cleanupId: record.id,
      kind: record.kind,
      outcome: "pending",
      reason: released.detail ?? "The provider did not confirm the release.",
    };
  }
  commitTerminal(store, stream, sessionId, acquisition, attachmentId, {
    eventType: "attachment.released",
    data: {
      reason: "cleanup-confirmed",
      cleanupIds: [record.id],
    },
    attachmentStatus: "released",
    acquisitionState: "released",
  }, record.id, names.leaseTtlMs);
  return {
    cleanupId: record.id,
    kind: record.kind,
    outcome: "satisfied",
    reason: "The provider confirmed the release.",
  };
}

/** The acquisition record an obligation names, by either identifier. */
function resolveAcquisition(
  store: ControlStore,
  sessionId: string,
  names: { record: CleanupObligation; attachmentId: string | undefined; acquisitionId: string | undefined },
): AcquisitionStatus | null {
  if (names.acquisitionId !== undefined) {
    return store.getAcquisition(names.acquisitionId);
  }
  if (names.attachmentId !== undefined) {
    return store.getAcquisitionForAttachment(sessionId, names.attachmentId);
  }
  return null;
}

/**
 * Commit one terminal attachment change by explicit identifiers.
 *
 * Only the named acquisition and attachment move; every other record of
 * the session stays untouched. The change serializes on the attachment
 * mutation lease, like every release (SPEC.md section 8.1). A missing
 * attachment record skips its part; the acquisition and the obligation
 * still settle.
 */
function commitTerminal(
  store: ControlStore,
  stream: SessionEventStream,
  sessionId: string,
  acquisition: AcquisitionStatus,
  attachmentId: string | undefined,
  next: {
    eventType: "attachment.released" | "attachment.unavailable";
    /** Event data; attachmentId and generation are added here. */
    data: Record<string, unknown>;
    attachmentStatus: "released" | "failed";
    acquisitionState: AcquisitionStatus["state"];
  },
  satisfyCleanupId: string,
  leaseTtlMs: number,
): void {
  const attachment =
    attachmentId !== undefined ? store.getAttachment(attachmentId) : undefined;
  const body = (): void => {
    store.casAcquisition(acquisition.acquisitionId, { state: acquisition.state }, {
      ...acquisition,
      state: next.acquisitionState,
    });
    if (attachment !== undefined && attachment !== null) {
      stream.commitWith(
        next.eventType,
        attachment.attachmentId,
        {
          attachmentId: attachment.attachmentId,
          generation: attachment.generation,
          ...next.data,
        },
        () => {
          store.casAttachment(
            attachment.attachmentId,
            { status: attachment.status },
            { ...attachment, status: next.attachmentStatus },
          );
        },
      );
    }
    store.casCleanupStatus(satisfyCleanupId, "pending", "satisfied");
  };
  try {
    if (attachmentId === undefined) {
      store.transaction(body);
      return;
    }
    const lease = store.acquireMutationLease(
      sessionId,
      attachmentId,
      `cleanup:${sessionId}`,
      leaseTtlMs,
    );
    try {
      store.mutateWithLease(sessionId, attachmentId, lease.fencingToken, body);
    } finally {
      store.releaseMutationLease(sessionId, attachmentId, lease.fencingToken);
    }
  } catch (error) {
    throw mapStoreError(error);
  }
}

// -- Shared plumbing ---------------------------------------------------------

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
  ttlMs: number,
): number {
  try {
    return store.acquireMutationLease(sessionId, attachmentId, `lifecycle:${sessionId}`, ttlMs)
      .fencingToken;
  } catch (error) {
    throw mapStoreError(error);
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
    throw mapStoreError(error);
  }
}

/** Release, mapping only genuine Portable errors upward. */
async function releaseOf(lease: EnvironmentLease): Promise<ReleaseResult> {
  return lease.release();
}

/** Convert store failures to their Portable form; pass the rest through. */
function mapStoreError(error: unknown): unknown {
  if (error instanceof StoreError) {
    return error.toPortableError();
  }
  return error;
}

/** A UTC timestamp the given duration after another one. */
function offsetMs(timestamp: string, durationMs: number): string {
  return new Date(Date.parse(timestamp) + durationMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One-line message of an unknown error. */
function errorMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
