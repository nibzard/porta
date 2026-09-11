import { createHash, randomUUID } from "node:crypto";
import {
  invalidRequestError,
  providerUnavailableError,
  requestConflictError,
  staleHandleError,
} from "../core/errors.js";
import type { PolicyAuthority } from "../core/policy.js";
import { matchEnvironment, validateManifest } from "../core/matching.js";
import { nowUtcTimestamp } from "../core/time.js";
import { ValidationError, assertValid } from "../schema/validate.js";
import { environmentRequestSchema } from "../schema/capability.js";
import type { EnvironmentManifest, EnvironmentRequest } from "../schema/capability.js";
import type {
  AcquisitionStatus,
  EnvironmentAdapter,
  EnvironmentLease,
} from "../schema/adapter.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { PortableError } from "../schema/error.js";
import type { EventRedactor } from "../store/event-stream.js";
import { SessionEventStream } from "../store/event-stream.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore } from "../store/control-store.js";

/**
 * Durable acquisition and reconciliation (SPEC.md section 5.2).
 *
 * An attachment is acquired under a durable identity, never under a
 * transient call. The flow persists the acquisition identity before the
 * adapter runs, so an interrupted request leaves evidence instead of a
 * guess. A repeated request key recovers the same logical acquisition or
 * rejects the conflicting input. A response that never arrives leads to
 * reconciliation by identity before any new allocation, and an
 * allocation nobody can identify stays visible as unresolved until
 * cleanup completes.
 *
 * Acquired environments are validated against their request before
 * activation: the manifest is the proof, the offer was only a hint. A
 * failed validation records a release obligation, so the allocation
 * stays visible until cleanup completes.
 */

/** Input of one durable acquisition. */
export interface AttachOptions {
  /** The adapter that owns the environments of this acquisition. */
  adapter: EnvironmentAdapter;
  /** The environment request, as validated against its schema. */
  request: EnvironmentRequest;
  /**
   * The durable key of the logical request. One key names one logical
   * acquisition per session: a repeated key recovers it, and a different
   * request under the same key is rejected.
   */
  requestKey: string;
  /** Authenticated principal supplied by the embedding application. */
  principal: string;
  /** The policy authority in force for this call. */
  authority: PolicyAuthority;
  /**
   * How long the flow holds the attachment mutation lease, in
   * milliseconds. Default 60000.
   */
  leaseTtlMs?: number;
  /**
   * How long to wait for the acquire response, in milliseconds. After
   * this the response counts as interrupted and the flow reconciles by
   * identity instead of waiting. Omit to wait indefinitely.
   */
  responseTimeoutMs?: number;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** Input of one explicit reconciliation pass. */
export interface ReconcileOptions {
  /** The adapter that owns the acquisition being reconciled. */
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

/** Runtime bookkeeping kept in acquisition record extensions. */
const REQUEST_KEY = "portable.runtime.request";
const INPUT_HASH_KEY = "portable.runtime.input-hash";
const ATTACHMENT_KEY = "portable.runtime.attachment-id";

const DEFAULT_LEASE_TTL_MS = 60_000;

/** The durable identity one flow call works on. */
interface AcquisitionSlot {
  acquisitionId: string;
  attachmentId: string;
  request: EnvironmentRequest | undefined;
  inputHash: string;
  state: AcquisitionStatus["state"];
}

/** Everything one flow call needs after the slot is reserved. */
interface FlowContext {
  store: ControlStore;
  stream: SessionEventStream;
  sessionId: string;
  slot: AcquisitionSlot;
  adapter: EnvironmentAdapter;
  fencingToken: number;
  /** The environment lease, when the adapter answered this flow directly. */
  environmentLease?: EnvironmentLease | undefined;
  /** The environment the provider allocated, when that is known. */
  environmentId?: string | undefined;
}

/**
 * Attach one environment to the session (SPEC.md sections 5.2 and 5.3).
 *
 * The call validates the request under the current authority, selects an
 * environment through matching, and walks the durable protocol:
 * identity first, adapter second, validation third, activation last. A
 * repeated `requestKey` never allocates a second environment; it either
 * returns the active attachment, resumes the interrupted flow through
 * reconciliation, or rejects the conflicting input.
 */
export async function attachEnvironment(
  store: ControlStore,
  sessionId: string,
  policyRef: string,
  options: AttachOptions,
): Promise<AttachmentSummary> {
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  checkAttachInput(options, leaseTtlMs);
  const denied = options.authority.checkEnvironmentRequest(options.request);
  if (denied !== null) {
    throw denied;
  }
  const { slot, fresh } = reserveSlot(store, sessionId, options);

  if (slot.state === "allocated") {
    return recoverAllocated(store, slot);
  }
  if (slot.state === "failed" || slot.state === "released") {
    throw requestConflictError(
      options.requestKey,
      `Request key ${options.requestKey} already ended in state ${slot.state}; use a new key or replacement.`,
      { state: slot.state },
    );
  }
  if (!fresh && slot.request === undefined) {
    throw requestConflictError(
      options.requestKey,
      `Request key ${options.requestKey} names an acquisition without a stored request.`,
    );
  }

  if (fresh) {
    return startAcquisition(store, sessionId, policyRef, options, slot, leaseTtlMs);
  }
  // A pending or unknown slot belongs to an interrupted attempt: the
  // flow reconciles by identity and never allocates again.
  return resolveAcquisition(store, sessionId, options, slot, leaseTtlMs);
}

/**
 * Reconcile one acquisition by its request key (SPEC.md section 5.2).
 *
 * The pass asks the adapter for the truth behind the durable identity.
 * An allocated environment is validated and activated; an allocation
 * that stays unknown is reported as unresolved. The pass never
 * allocates.
 */
export async function reconcileAcquisition(
  store: ControlStore,
  sessionId: string,
  requestKey: string,
  options: ReconcileOptions,
): Promise<AttachmentSummary> {
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const record = store.getAcquisitionByRequestKey(sessionId, requestKey);
  if (record === null) {
    throw invalidRequestError(`Request key ${requestKey} names no acquisition.`, {
      requestKey,
    });
  }
  const slot = slotOf(record);
  if (slot === null || slot.request === undefined) {
    throw invalidRequestError(
      `The acquisition of ${requestKey} carries no stored request; it predates this runtime.`,
      { requestKey },
    );
  }
  const denied = options.authority.checkEnvironmentRequest(slot.request);
  if (denied !== null) {
    throw denied;
  }
  if (slot.state === "allocated") {
    return recoverAllocated(store, slot);
  }
  if (slot.state === "failed" || slot.state === "released") {
    throw invalidRequestError(
      `The acquisition of ${requestKey} already ended in state ${slot.state}.`,
      { requestKey, state: slot.state },
    );
  }
  return resolveAcquisition(
    store,
    sessionId,
    {
      adapter: options.adapter,
      request: slot.request,
      requestKey,
      principal: options.principal,
      authority: options.authority,
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
      ...(options.redactor !== undefined ? { redactor: options.redactor } : {}),
    },
    slot,
    leaseTtlMs,
  );
}

// -- Slot management ---------------------------------------------------------

/** The slot a reservation produced, and whether this call created it. */
interface Reservation {
  slot: AcquisitionSlot;
  fresh: boolean;
}

/**
 * Reserve or recover the durable identity of one logical request.
 *
 * Runs in one transaction: the request key, its input hash, the stored
 * request, and the acquiring attachment land together or not at all.
 */
function reserveSlot(
  store: ControlStore,
  sessionId: string,
  options: AttachOptions,
): Reservation {
  const inputHash = hashOf(options.request);
  try {
    return store.transaction(() => {
      const existing = store.getAcquisitionByRequestKey(sessionId, options.requestKey);
      if (existing !== null) {
        const slot = slotOf(existing);
        if (slot === null || slot.inputHash !== inputHash) {
          throw requestConflictError(
            options.requestKey,
            `Request key ${options.requestKey} already names a different request.`,
          );
        }
        return { slot, fresh: false };
      }
      const held = store.getAttachmentByName(sessionId, options.request.name);
      if (held !== null) {
        throw requestConflictError(
          options.requestKey,
          `Attachment name ${options.request.name} is already in use by ${held.attachmentId}.`,
          { name: options.request.name, attachmentId: held.attachmentId },
        );
      }
      const acquisitionId = `acq-${randomUUID()}`;
      const attachmentId = `att-${randomUUID()}`;
      store.insertAttachment({
        sessionId,
        attachmentId,
        name: options.request.name,
        generation: 1,
        status: "acquiring",
        capabilityIds: [],
      });
      store.insertAcquisition(
        sessionId,
        options.requestKey,
        {
          acquisitionId,
          state: "pending",
          extensions: {
            [REQUEST_KEY]: options.request,
            [INPUT_HASH_KEY]: inputHash,
            [ATTACHMENT_KEY]: attachmentId,
          },
        },
        attachmentId,
      );
      return {
        slot: {
          acquisitionId,
          attachmentId,
          request: options.request,
          inputHash,
          state: "pending" as const,
        },
        fresh: true,
      };
    });
  } catch (error) {
    throw mapStoreError(error);
  }
}

/** Read the runtime bookkeeping out of one acquisition record. */
function slotOf(record: AcquisitionStatus): AcquisitionSlot | null {
  const extensions = record.extensions ?? {};
  const attachmentId = extensions[ATTACHMENT_KEY];
  const inputHash = extensions[INPUT_HASH_KEY];
  if (typeof attachmentId !== "string" || typeof inputHash !== "string") {
    return null;
  }
  const request = extensions[REQUEST_KEY];
  return {
    acquisitionId: record.acquisitionId,
    attachmentId,
    request: isEnvironmentRequest(request) ? request : undefined,
    inputHash,
    state: record.state,
  };
}

function isEnvironmentRequest(value: unknown): value is EnvironmentRequest {
  if (value === null || typeof value !== "object") {
    return false;
  }
  try {
    assertValid(environmentRequestSchema, value);
    return true;
  } catch {
    return false;
  }
}

/** Return the active attachment of an already allocated slot. */
function recoverAllocated(store: ControlStore, slot: AcquisitionSlot): AttachmentSummary {
  const attachment = store.getAttachment(slot.attachmentId);
  if (attachment === null) {
    throw staleHandleError(
      { kind: "attachment", value: slot.attachmentId },
      { kind: "attachment", value: null },
    );
  }
  if (attachment.status !== "active" && attachment.status !== "replacing") {
    throw staleHandleError(
      { kind: "attachment-status", value: "active" },
      { kind: "attachment-status", value: attachment.status },
    );
  }
  return attachment;
}

// -- Acquisition protocol ----------------------------------------------------

/** Run the adapter acquisition for a freshly reserved slot. */
async function startAcquisition(
  store: ControlStore,
  sessionId: string,
  policyRef: string,
  options: AttachOptions,
  slot: AcquisitionSlot,
  leaseTtlMs: number,
): Promise<AttachmentSummary> {
  const context = openContext(store, sessionId, options, slot, leaseTtlMs);
  try {
    // Discovery selects exactly one provider before anything is spent.
    const offers = await context.adapter.describe();
    matchEnvironment(slot.request!, offers);
    const authorized = {
      acquisitionId: slot.acquisitionId,
      request: slot.request!,
      authority: { principal: options.principal, policyRef },
    };
    const outcome = await raceAcquire(options.adapter, authorized, options.responseTimeoutMs);
    if (outcome.settled) {
      return await consumeLease(context, outcome.lease);
    }
    // The response never arrived. Reconcile by identity; never re-send.
    return await resolveThroughAdapter(context);
  } catch (error) {
    if (error instanceof AlreadyRecorded) {
      throw error.outcome;
    }
    throw await markFailed(context, error);
  } finally {
    releaseLease(context);
  }
}

/**
 * Resume a pending or unknown slot through reconciliation.
 *
 * The adapter answers for the durable identity; the runtime never
 * allocates again behind this key. An allocation that stays unknown
 * remains visible as an unresolved allocation.
 */
async function resolveAcquisition(
  store: ControlStore,
  sessionId: string,
  options: AttachOptions,
  slot: AcquisitionSlot,
  leaseTtlMs: number,
): Promise<AttachmentSummary> {
  const context = openContext(store, sessionId, options, slot, leaseTtlMs);
  try {
    return await resolveThroughAdapter(context);
  } catch (error) {
    if (error instanceof AlreadyRecorded) {
      throw error.outcome;
    }
    throw await markFailed(context, error);
  } finally {
    releaseLease(context);
  }
}

/** Take the mutation lease and build the flow context. */
function openContext(
  store: ControlStore,
  sessionId: string,
  options: AttachOptions | ReconcileOptions,
  slot: AcquisitionSlot,
  leaseTtlMs: number,
): FlowContext {
  try {
    const lease = store.acquireMutationLease(
      sessionId,
      slot.attachmentId,
      `attach:${sessionId}`,
      leaseTtlMs,
    );
    return {
      store,
      stream: new SessionEventStream(store, sessionId, options.redactor),
      sessionId,
      slot,
      adapter: options.adapter,
      fencingToken: lease.fencingToken,
    };
  } catch (error) {
    throw mapStoreError(error);
  }
}

/**
 * Ask the adapter for the truth behind one durable identity.
 *
 * An allocated environment activates after validation. A state that is
 * still unknown is recorded as an unresolved allocation and reported.
 */
async function resolveThroughAdapter(context: FlowContext): Promise<AttachmentSummary> {
  const status = await context.adapter.reconcile(context.slot.acquisitionId);
  if (status.state === "allocated") {
    if (status.environmentId === undefined || status.manifest === undefined) {
      // Allocated without proof cannot activate: the environment stays
      // unresolved and visible instead of being trusted blindly.
      markUnresolved(context);
      throw new AlreadyRecorded(
        providerUnavailableError(
          `Adapter ${context.adapter.id} reconciled acquisition ${context.slot.acquisitionId} without a manifest.`,
          { acquisitionId: context.slot.acquisitionId },
        ),
      );
    }
    context.environmentId = status.environmentId;
    return activate(context, status.manifest, status.expiresAt);
  }
  if (status.state === "failed") {
    return markFailed(
      context,
      providerUnavailableError(
        `Acquisition ${context.slot.acquisitionId} failed at the provider.`,
        { acquisitionId: context.slot.acquisitionId },
      ),
    );
  }
  markUnresolved(context);
  throw new AlreadyRecorded(
    providerUnavailableError(
      `Acquisition ${context.slot.acquisitionId} cannot be identified; it stays unresolved.`,
      { acquisitionId: context.slot.acquisitionId, state: status.state },
    ),
  );
}

// -- Activation ----------------------------------------------------------------

/**
 * Consume a lease the adapter returned.
 *
 * The manifest is validated before activation. A failed validation
 * records a release obligation so the allocation stays visible until
 * cleanup completes, then reports the refusal.
 */
async function consumeLease(
  context: FlowContext,
  lease: EnvironmentLease,
): Promise<AttachmentSummary> {
  context.environmentLease = lease;
  const manifest = await lease.manifest();
  context.environmentId = manifest.environmentId;
  return activate(context, manifest, undefined);
}

/**
 * Activate one validated environment (SPEC.md sections 5.2 and 5.3).
 *
 * The acquisition, the attachment, and the journal event commit in one
 * fenced transaction: the mutation lands only while the caller still
 * holds the current mutation lease. A worker whose lease expired cannot
 * commit, even with a successful provider response in hand.
 */
function activate(
  context: FlowContext,
  manifest: EnvironmentManifest,
  expiresAt: string | undefined,
): AttachmentSummary {
  validateManifest(context.slot.request!, manifest);
  const attachment = currentAttachment(context);
  const next: AttachmentSummary = {
    ...attachment,
    status: "active",
    environmentId: manifest.environmentId,
    providerId: manifest.providerId,
    capabilityIds: manifest.capabilities.map((capability) => capability.id),
    ...(expiresAt !== undefined ? { leaseExpiresAt: expiresAt } : {}),
  };
  const record: AcquisitionStatus = {
    acquisitionId: context.slot.acquisitionId,
    state: "allocated",
    environmentId: manifest.environmentId,
    manifest,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    extensions: extensionsOf(context.slot),
  };
  const committed = fenced(
    context,
    () =>
      context.stream.commitWith(
        "attachment.attached",
        context.slot.attachmentId,
        {
          attachmentId: context.slot.attachmentId,
          name: attachment.name,
          generation: attachment.generation,
          environmentId: manifest.environmentId,
          providerId: manifest.providerId,
          capabilityIds: next.capabilityIds,
        },
        () => {
          const acquisitionMoved =
            context.store.casAcquisition(
              context.slot.acquisitionId,
              { state: context.slot.state },
              record,
            ) === null;
          const attachmentMoved =
            context.store.casAttachment(
              context.slot.attachmentId,
              { status: attachment.status },
              next,
            ) === null;
          // Activation resolves this slot's outstanding obligations.
          for (const entry of context.store.listCleanup(context.sessionId, "pending")) {
            if (
              entry.record.targetId === context.slot.acquisitionId ||
              entry.record.targetId === context.slot.attachmentId
            ) {
              context.store.casCleanupStatus(entry.record.id, "pending", "satisfied");
            }
          }
          return acquisitionMoved || attachmentMoved ? null : next;
        },
      ).result,
  );
  if (committed === null) {
    throw staleHandleError(
      { kind: "attachment", value: context.slot.attachmentId },
      { kind: "attachment-state", value: "concurrently-modified" },
    );
  }
  return committed;
}

/**
 * Record one unresolved allocation (SPEC.md section 5.2).
 *
 * The acquisition moves to `unknown` and the attachment to
 * `unavailable`, with a journal event and a cleanup obligation. All
 * three stay visible through the session description until a later
 * pass resolves or cleans them up.
 */
function markUnresolved(context: FlowContext): void {
  const attachment = currentAttachment(context);
  const cleanupId = `cln-${randomUUID()}`;
  const detail = `Acquisition ${context.slot.acquisitionId} cannot be identified.`;
  fenced(context, () => {
    context.stream.commitWith(
      "attachment.unavailable",
      context.slot.attachmentId,
      {
        attachmentId: context.slot.attachmentId,
        generation: attachment.generation,
        reason: "acquisition-outcome-unknown",
      },
      () => {
        context.store.casAcquisition(
          context.slot.acquisitionId,
          { state: context.slot.state },
          {
            acquisitionId: context.slot.acquisitionId,
            state: "unknown",
            extensions: extensionsOf(context.slot),
          },
        );
        context.store.casAttachment(
          context.slot.attachmentId,
          { status: attachment.status },
          { ...attachment, status: "unavailable" },
        );
        // One obligation per target: repeated passes must not pile them up.
        const owed = context.store
          .listCleanup(context.sessionId, "pending")
          .some((entry) => entry.record.targetId === context.slot.acquisitionId);
        if (!owed) {
          context.store.insertCleanup(context.sessionId, {
            id: cleanupId,
            kind: "unresolved-allocation",
            targetId: context.slot.acquisitionId,
            detail,
            createdAt: nowUtcTimestamp(),
            extensions: obligationExtensionsOf(context.slot),
          });
        }
      },
    );
  });
}

/**
 * Record one failed acquisition (SPEC.md section 5.2).
 *
 * The failure commits under the mutation lease: an expired worker must
 * not commit state either. When the provider did allocate, a release
 * obligation is recorded before anything else, so the allocation stays
 * visible until cleanup completes; a lease in hand is released once,
 * best effort. The original error is re-thrown for the caller.
 */
async function markFailed(context: FlowContext, cause: unknown): Promise<never> {
  const attachment = currentAttachment(context);
  if (attachment.status !== "failed") {
    const detail = `Acquisition ${context.slot.acquisitionId} failed before activation.`;
    const environmentId = context.environmentId ?? attachment.environmentId ?? undefined;
    const targetId = environmentId ?? context.slot.attachmentId;
    const cleanupId = `cln-${randomUUID()}`;
    const causeRecord = portableRecord(cause);
    fenced(context, () => {
      context.stream.commitWith(
        "cleanup.pending",
        cleanupId,
        {
          cleanupId,
          kind: environmentId === undefined ? "other" : "release",
          targetId,
          detail,
        },
        () => {
          context.store.casAcquisition(
            context.slot.acquisitionId,
            { state: context.slot.state },
            {
              acquisitionId: context.slot.acquisitionId,
              state: "failed",
              ...(environmentId !== undefined ? { environmentId } : {}),
              ...(causeRecord !== undefined ? { error: causeRecord } : {}),
              extensions: extensionsOf(context.slot),
            },
          );
          context.store.casAttachment(
            context.slot.attachmentId,
            { status: attachment.status },
            {
              ...attachment,
              status: "failed",
              ...(environmentId !== undefined ? { environmentId } : {}),
            },
          );
          context.store.insertCleanup(context.sessionId, {
            id: cleanupId,
            kind: environmentId === undefined ? "other" : "release",
            targetId,
            detail,
            createdAt: nowUtcTimestamp(),
            extensions: obligationExtensionsOf(context.slot),
          });
        },
      );
    });
    if (context.environmentLease !== undefined && environmentId !== undefined) {
      // One best-effort release now; the obligation above already makes
      // the cleanup durable in case this attempt dies.
      try {
        const released = await context.environmentLease.release();
        if (released.status === "released") {
          context.store.casCleanupStatus(cleanupId, "pending", "satisfied");
        }
      } catch {
        // The obligation stays pending for the cleanup pass.
      }
    }
  }
  throw cause;
}

// -- Adapter plumbing --------------------------------------------------------

/** Result of one raced acquire call. */
type AcquireOutcome = { settled: true; lease: EnvironmentLease } | { settled: false };

/**
 * Wait for the adapter response, or give up after the timeout.
 *
 * Giving up cancels nothing: the allocation may still happen at the
 * provider. The caller reconciles by identity next.
 */
async function raceAcquire(
  adapter: EnvironmentAdapter,
  authorized: { acquisitionId: string; request: EnvironmentRequest; authority: { principal: string; policyRef: string } },
  timeoutMs: number | undefined,
): Promise<AcquireOutcome> {
  if (timeoutMs === undefined) {
    return { settled: true, lease: await adapter.acquire(authorized) };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const pending = adapter.acquire(authorized);
    const interrupted = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = await Promise.race([pending.then(() => true), interrupted]);
    return settled ? { settled: true, lease: await pending } : { settled: false };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Release the flow's mutation lease. A fenced-out token releases nothing. */
function releaseLease(context: FlowContext): void {
  context.store.releaseMutationLease(
    context.sessionId,
    context.slot.attachmentId,
    context.fencingToken,
  );
}

/**
 * Marks an error whose durable state this flow already recorded.
 *
 * The outer handler re-throws the wrapped cause instead of recording a
 * failure on top of an unresolved-allocation report.
 */
class AlreadyRecorded extends Error {
  readonly outcome: unknown;

  constructor(outcome: unknown) {
    super("The outcome was already recorded durably.");
    this.name = "AlreadyRecorded";
    this.outcome = outcome;
  }
}

/** Run one body under the flow's mutation lease. */
function fenced<T>(context: FlowContext, body: () => T): T {
  try {
    return context.store.mutateWithLease(
      context.sessionId,
      context.slot.attachmentId,
      context.fencingToken,
      body,
    );
  } catch (error) {
    throw mapStoreError(error);
  }
}

/** The attachment of one flow, as currently stored. */
function currentAttachment(context: FlowContext): AttachmentSummary {
  const attachment = context.store.getAttachment(context.slot.attachmentId);
  if (attachment === null) {
    throw staleHandleError(
      { kind: "attachment", value: context.slot.attachmentId },
      { kind: "attachment", value: null },
    );
  }
  return attachment;
}

/** Rebuild the runtime bookkeeping of one slot. */
function extensionsOf(slot: AcquisitionSlot): Record<string, unknown> {
  return {
    [REQUEST_KEY]: slot.request,
    [INPUT_HASH_KEY]: slot.inputHash,
    [ATTACHMENT_KEY]: slot.attachmentId,
  };
}

/** Tag an obligation with exactly the records it may touch. */
function obligationExtensionsOf(slot: AcquisitionSlot): Record<string, unknown> {
  return {
    [ATTACHMENT_KEY]: slot.attachmentId,
    "portable.runtime.acquisition-id": slot.acquisitionId,
  };
}

/**
 * The request an acquisition record stores, for flows that need to talk
 * to the adapter again behind the same durable identity.
 */
export function storedRequestOf(record: AcquisitionStatus): EnvironmentRequest | undefined {
  const request = (record.extensions ?? {})[REQUEST_KEY];
  return isEnvironmentRequest(request) ? request : undefined;
}

// -- Helpers -----------------------------------------------------------------

/** Validate the shape of one attach input before any effect. */
function checkAttachInput(options: AttachOptions, leaseTtlMs: number): void {
  if (typeof options.requestKey !== "string" || options.requestKey.length === 0) {
    throw invalidRequestError("The request key must be a non-empty string.");
  }
  for (const [name, value] of [
    ["leaseTtlMs", leaseTtlMs],
    ["responseTimeoutMs", options.responseTimeoutMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw invalidRequestError(`The ${name} option must be a positive whole number.`);
    }
  }
  try {
    assertValid(environmentRequestSchema, options.request);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestError("The environment request failed schema validation.", {
        issues: error.issues.map((issue) => ({ path: issue.instancePath, message: issue.message })),
      });
    }
    throw error;
  }
}

/** Stable hash of one environment request. */
function hashOf(request: EnvironmentRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/** JSON with sorted keys, so equal requests hash equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Convert store failures to their Portable form; pass the rest through. */
function mapStoreError(error: unknown): unknown {
  if (error instanceof StoreError) {
    return error.toPortableError();
  }
  return error;
}

/** Serialize an error for storage in an acquisition record. */
function portableRecord(cause: unknown): PortableError | undefined {
  if (
    cause !== null &&
    typeof cause === "object" &&
    typeof (cause as { code?: unknown }).code === "string"
  ) {
    return cause as PortableError;
  }
  return undefined;
}
