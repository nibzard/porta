import { randomUUID } from "node:crypto";
import { invalidRequestError, invalidRequestFromValidation } from "../core/errors.js";
import { ValidationError } from "../schema/validate.js";
import type { PortableError } from "../schema/error.js";
import { assertValid, jsonRoundTrip } from "../schema/validate.js";
import {
  sessionDescriptionSchema,
  sessionOptionsSchema,
  sessionRecordSchema,
} from "../schema/session.js";
import type {
  SessionDescription,
  SessionOptions,
  SessionRecord,
} from "../schema/session.js";
import type { ControlStore } from "../store/control-store.js";
import { attachEnvironment, reconcileAcquisition } from "./acquisition.js";
import type { AttachOptions, ReconcileOptions } from "./acquisition.js";
import {
  renewAttachment as renewAttachmentFlow,
  runCleanup as runCleanupFlow,
} from "./lifecycle.js";
import type { CleanupOptions, CleanupReport, RenewOptions, RenewOutcome } from "./lifecycle.js";
import {
  acceptProposal,
  checkpointWorkspace,
  materializeRevision,
  proposeWorkspaceChange,
} from "./workspace.js";
import { exportRevision, recoverBridgeExport } from "./export.js";
import { WorkspaceFiles } from "./workspace-capability.js";
import { admitInvocation } from "./admission.js";
import type { AdmissionOptions, AdmissionOutcome } from "./admission.js";
import {
  markOperationDispatched,
  reconcileOperation,
  settleOperation,
} from "./outcomes.js";
import type {
  OperationOutcome,
  OperationResolution,
  OutcomeOptions,
} from "./outcomes.js";
import type {
  AcceptOutcome,
  CheckpointOptions,
  CheckpointOutcome,
  MaterializeFlowOptions,
  MaterializedCopy,
  ProposalOutcome,
  ProposeOptions,
} from "./workspace.js";
import type { ProposalRequest } from "../schema/workspace.js";
import type { ExportFlowOptions, ExportOutcome, ExportRequest } from "./export.js";
import type { BlobStore } from "../store/blob-store.js";
import type { CheckpointRequest } from "../schema/workspace.js";
import type { InvocationRequest, OperationRecord } from "../schema/operation.js";
import type { AttachmentSummary } from "../schema/session.js";

/**
 * Session identity and inspection (SPEC.md sections 5.1 and 15).
 *
 * A session is a durable record in the control store. Creating one
 * establishes the workspace identity and the policy reference of the
 * authenticated authority. Inspection reports the persisted state only:
 * attachments, workspace head, unresolved allocations, and pending
 * cleanup. Reopening restores this metadata; it does not restore a
 * harness conversation or continue a model loop.
 */
export class PortableRuntime {
  private readonly store: ControlStore;

  constructor(store: ControlStore) {
    this.store = store;
  }

  /** The underlying control store, for runtime internals and tests. */
  get controlStore(): ControlStore {
    return this.store;
  }

  /**
   * Create a durable session.
   *
   * The policy reference names the authenticated authority of the
   * embedding application. Model-controlled input cannot supply it, so
   * the option is validated here before any record is written.
   */
  async createSession(options: SessionOptions): Promise<ManagedSession> {
    check(sessionOptionsSchema, options, "The session options failed validation.");
    const record: SessionRecord = {
      id: `sess-${randomUUID()}`,
      schemaVersion: 1,
      status: "open",
      workspaceId: `ws-${randomUUID()}`,
      eventSequence: 0,
      policyRef: options.policyRef,
      createdAt: new Date().toISOString(),
    };
    check(sessionRecordSchema, record, "The generated session record failed validation.");
    this.store.createSession(record);
    return new ManagedSession(this.store, record.id);
  }

  /**
   * Open an existing session by identifier.
   *
   * Opening resolves durable metadata and reports actual state. It does
   * not claim to restore any harness conversation (SPEC.md section 5.1).
   */
  async openSession(sessionId: string): Promise<ManagedSession> {
    const session = this.store.getSession(sessionId);
    if (session === null) {
      throw sessionMissing(sessionId);
    }
    return new ManagedSession(this.store, sessionId);
  }
}

/** A durable session handle. Inspection reads persisted state only. */
export class ManagedSession {
  private readonly store: ControlStore;
  readonly id: string;

  constructor(store: ControlStore, id: string) {
    this.store = store;
    this.id = id;
  }

  /** The underlying control store, for runtime internals and tests. */
  get controlStore(): ControlStore {
    return this.store;
  }

  /** The durable session record. */
  record(): SessionRecord {
    const session = this.store.getSession(this.id);
    if (session === null) {
      throw sessionMissing(this.id);
    }
    return session;
  }

  /**
   * Describe the actual persisted state of the session.
   *
   * The result contains the session record, its attachments, the
   * workspace head, unresolved allocations, and pending cleanup. It
   * reports nothing beyond durable state and satisfies the public
   * session description schema.
   */
  async describe(): Promise<SessionDescription> {
    const record = this.record();
    const head = this.store.getWorkspaceHead(record.workspaceId);
    const description: SessionDescription = {
      session: record,
      attachments: this.store.listAttachments(this.id),
      workspace:
        head === null
          ? { workspaceId: record.workspaceId }
          : { workspaceId: record.workspaceId, headRevisionId: head },
      unresolvedAllocations: this.store.listUnresolvedAcquisitions(this.id),
      pendingCleanup: this.store
        .listCleanup(this.id, "pending")
        .map((entry) => entry.record.id),
    };
    // Public results stay JSON-serializable and schema-valid.
    return jsonRoundTrip(sessionDescriptionSchema, description) as SessionDescription;
  }

  /**
   * Attach one environment through the durable acquisition protocol.
   *
   * The request key names the logical request: a repeated key recovers
   * the same acquisition, and a conflicting request under it is
   * rejected. A lost acquisition response reconciles by identity before
   * any new allocation (SPEC.md section 5.2).
   */
  async attach(options: AttachOptions): Promise<AttachmentSummary> {
    return attachEnvironment(this.store, this.id, this.record().policyRef, options);
  }

  /**
   * Reconcile one acquisition by its request key.
   *
   * The pass asks the adapter for the truth behind the durable identity
   * and activates, fails, or reports the allocation as unresolved. It
   * never allocates.
   */
  async reconcileAttachment(
    requestKey: string,
    options: ReconcileOptions,
  ): Promise<AttachmentSummary> {
    return reconcileAcquisition(this.store, this.id, requestKey, options);
  }

  /**
   * Renew the environment lease of one attachment.
   *
   * A refusal or an expired lease marks the attachment unavailable and
   * records a release obligation: runtime authority expiring proves
   * nothing about the provider side (SPEC.md section 8).
   */
  async renewAttachment(attachmentId: string, options: RenewOptions): Promise<RenewOutcome> {
    return renewAttachmentFlow(this.store, this.id, this.record().policyRef, attachmentId, options);
  }

  /**
   * Checkpoint the local directory bridge into a workspace revision.
   *
   * The first import creates the workspace's first revision; later
   * imports name the head they expect. The caller declares how the
   * source's writers were made quiescent, and the runtime refuses an
   * undeclared source (SPEC.md section 11.4).
   */
  async checkpoint(
    blobs: BlobStore,
    request: CheckpointRequest,
    options?: CheckpointOptions,
  ): Promise<CheckpointOutcome> {
    return checkpointWorkspace(this.store, this.id, blobs, request, options);
  }

  /**
   * Materialize one revision into a local directory.
   *
   * Transfer policy is checked before any byte is read, the manifest
   * must hash to the revision's root hash, and a `proposal` copy
   * reaches the authoritative head only through an accepted proposal
   * (SPEC.md sections 11.3 and 11.6).
   */
  async materialize(
    blobs: BlobStore,
    revisionId: string,
    destination: string,
    options: MaterializeFlowOptions,
  ): Promise<MaterializedCopy> {
    return materializeRevision(this.store, this.id, blobs, revisionId, destination, options);
  }

  /**
   * Offer one private working copy's content as a proposal.
   *
   * The candidate revision this call records is not the head until
   * `accept` compares the current head with the proposal's base.
   */
  async propose(
    blobs: BlobStore,
    request: ProposalRequest,
    options: ProposeOptions = {},
  ): Promise<ProposalOutcome> {
    return proposeWorkspaceChange(this.store, this.id, blobs, request, options);
  }

  /** Accept one proposal and move the workspace head atomically. */
  async accept(proposalId: string): Promise<AcceptOutcome> {
    return acceptProposal(this.store, this.id, proposalId);
  }

  /**
   * Export one revision into a local directory.
   *
   * The destination is verified against its recorded base before any
   * file changes, and an interrupted apply is recovered first.
   */
  async export(blobs: BlobStore, request: ExportRequest, options: ExportFlowOptions): Promise<ExportOutcome> {
    return exportRevision(this.store, this.id, blobs, request, options);
  }

  /**
   * The `fs.workspace@1` operations bound to this session's copies.
   *
   * The returned instance holds no durable state; every call
   * authorizes against the session and its registered copies.
   */
  files(): WorkspaceFiles {
    return new WorkspaceFiles(this.store, this.id);
  }

  /**
   * Admit one invocation and record its operation durably.
   *
   * Session, attachment, generation, policy, and lease check in one
   * transaction with the insert. A repeated request key returns its
   * existing operation; the same key with different input conflicts
   * (SPEC.md sections 5.3 and 9.1).
   */
  async admit(
    request: InvocationRequest,
    options: AdmissionOptions,
  ): Promise<AdmissionOutcome> {
    return admitInvocation(this.store, this.id, request, options);
  }

  /**
   * Record that provider execution of one operation started.
   *
   * The record moves `accepted` to `running` under compare-and-set.
   * A settled or unknown operation refuses, so an unsafe effect is
   * never replayed (SPEC.md section 9.2).
   */
  async markDispatched(operationId: string, options?: OutcomeOptions): Promise<OperationRecord> {
    return markOperationDispatched(this.store, this.id, operationId, options ?? {});
  }

  /**
   * Settle one operation with a known outcome.
   *
   * A nonzero process exit is completed with its exit code, not a
   * transport failure. A lost response settles as `unknown`, because
   * a timeout does not establish cancellation.
   */
  async settle(
    operationId: string,
    outcome: OperationOutcome,
    options?: OutcomeOptions,
  ): Promise<OperationRecord> {
    return settleOperation(this.store, this.id, operationId, outcome, options ?? {});
  }

  /**
   * Reconcile one unknown operation with provider evidence.
   *
   * The original uncertainty stays on the record and in the journal;
   * every pass appends its observation to the trail.
   */
  async reconcile(
    operationId: string,
    resolution: OperationResolution,
    options?: OutcomeOptions,
  ): Promise<OperationRecord> {
    return reconcileOperation(this.store, this.id, operationId, resolution, options ?? {});
  }

  /** Complete or restore one interrupted export of a destination. */
  async recoverExport(
    blobs: BlobStore,
    destination: string,
    options: ExportFlowOptions,
  ): Promise<ExportOutcome> {
    return recoverBridgeExport(this.store, this.id, blobs, destination, options);
  }

  /**
   * Run one cleanup pass over the session's pending obligations.
   *
   * Each retry releases exactly the environment its obligation names.
   * Obligations survive restart and stay visible until the provider
   * confirms the release.
   */
  async runCleanup(options: CleanupOptions): Promise<CleanupReport> {
    return runCleanupFlow(this.store, this.id, this.record().policyRef, options);
  }
}

/** Error for a session identifier that names no durable record. */
function sessionMissing(sessionId: string): PortableError {
  return invalidRequestError(`Session ${sessionId} does not exist.`, {
    sessionId,
  });
}

/** Validate input, reporting field-specific Portable errors. */
function check(schema: object, value: unknown, message: string): void {
  try {
    assertValid(schema, value);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw invalidRequestError(message);
  }
}
