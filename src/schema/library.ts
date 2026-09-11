import type { Identifier } from "./defs.js";
import type { PortableEvent } from "./event.js";
import type {
  CleanupObligation,
  HandoffPlan,
  HandoffResult,
  ReplaceRequest,
} from "./handoff.js";
import type { InvocationRequest, OperationRecord } from "./operation.js";
import type { EnvironmentRequest } from "./capability.js";
import type { ResourceDescription, ResourceRef } from "./resource.js";
import type {
  AttachmentRef,
  SessionDescription,
  SessionOptions,
} from "./session.js";
import type {
  CheckpointRequest,
  WorkspaceProposal,
  WorkspaceRevision,
} from "./workspace.js";

/** Result of `Session.close()` (SPEC.md sections 5.3 and 15). */
export interface CloseResult {
  sessionId: Identifier;
  /** True when every attachment released and the session is closed. */
  closed: boolean;
  /** Durable obligations that still need cleanup or reconciliation. */
  remaining: CleanupObligation[];
}

/**
 * Root library interface (SPEC.md section 15).
 *
 * `createSession` accepts authenticated authority through options supplied
 * by the embedding application. Model-controlled input cannot supply it.
 */
export interface Portable {
  createSession(options: SessionOptions): Promise<Session>;
  openSession(sessionId: string): Promise<Session>;
}

/**
 * One durable logical session (SPEC.md section 15).
 *
 * Long operations expose durable identifiers before completion. Cancelling
 * a local wait MUST NOT implicitly cancel the remote operation.
 */
export interface Session {
  describe(): Promise<SessionDescription>;
  checkpoint(input: CheckpointRequest): Promise<WorkspaceRevision>;
  attach(request: EnvironmentRequest, requestKey: string): Promise<AttachmentRef>;
  invoke(request: InvocationRequest): Promise<OperationRecord>;
  inspectOperation(operationId: string): Promise<OperationRecord>;
  cancelOperation(operationId: string): Promise<CancelOperationResult>;
  propose(attachment: AttachmentRef): Promise<WorkspaceProposal>;
  accept(proposalId: string, expectedHead: string): Promise<WorkspaceRevision>;
  planReplace(request: ReplaceRequest): Promise<HandoffPlan>;
  replace(request: ReplaceRequest): Promise<HandoffResult>;
  resolve(resource: ResourceRef): Promise<ResourceDescription>;
  release(attachment: AttachmentRef, requestKey: string): Promise<ReleaseAttachmentResult>;
  events(afterSequence: number): AsyncIterable<PortableEvent>;
  close(requestKey: string): Promise<CloseResult>;
}

/**
 * Result of `Session.cancelOperation()`.
 *
 * Mirrors the adapter `CancellationResult` with the journal state attached.
 */
export interface CancelOperationResult {
  outcome: "confirmed" | "best-effort" | "unsupported";
  stopped: boolean;
  descendantsStopped?: boolean;
  operation: OperationRecord;
}

/** Result of `Session.release()` for one attachment. */
export interface ReleaseAttachmentResult {
  attachment: AttachmentRef;
  status: "released" | "failed";
  retryable: boolean;
  cleanup: CleanupObligation[];
}
