/**
 * Public entry point of the Portable library.
 *
 * SPEC.md section 15 requires a library-first implementation: the CLI and any
 * harness integration call the contracts exported from this module. Public
 * records stay JSON-serializable so other language bindings can follow.
 *
 * Intended module boundaries (SPEC.md section 2):
 *
 * - `src/runtime`: request validation, attachment routing, lifecycle, journal,
 *   and replacement recovery. This code never imports an adapter directly.
 * - `src/store`: the durable control store and the content-addressed
 *   workspace store.
 * - `src/adapters`: translation between Portable contracts and provider
 *   behavior. Each adapter is an independent module that the runtime loads
 *   behind the adapter interfaces.
 * - `src/cli`: thin CLI. It calls library contracts and implements no
 *   lifecycle rules of its own.
 * - `src/schema`: the public contracts. Types, JSON Schema draft 2020-12
 *   schemas, and validation.
 */

export { VERSION } from "./version.js";

// Scalar contract types and shared schema definitions.
export * from "./schema/defs.js";

// Validation.
export {
  ValidationError,
  assertValid,
  checkJsonSchemaCompiles,
  jsonRoundTrip,
  validateAgainstSchema,
} from "./schema/validate.js";
export type { ValidationIssue } from "./schema/validate.js";

// Errors and compatibility.
export {
  ALL_ERROR_CODES,
  ERROR_TAXONOMY,
  ambiguousEnvironmentError,
  cleanupPendingError,
  failureCategory,
  handoffBlockedError,
  integrityFailureError,
  invalidRequestError,
  invalidRequestFromValidation,
  isProviderFailure,
  isSafeRetry,
  leaseExpiredError,
  operationUnknownError,
  policyDeniedError,
  portableError,
  providerUnavailableError,
  requestConflictError,
  requirementUnsatisfiedError,
  sanitizeError,
  scrubStringValue,
  scrubValue,
  serializeError,
  staleHandleError,
  toPortableError,
  unsupportedOperationError,
  workspaceConflictError,
  workspaceUnstableError,
} from "./core/errors.js";
export type { ErrorSpec, FailureCategory, PortableErrorOptions } from "./core/errors.js";
export {
  capabilityIdSatisfies,
  checkUnknownConstraints,
  checkUnknownRequirements,
  isDomainNamespaced,
  missingRequiredExtensions,
  parseCapabilityId,
  recognizedExtensions,
  requireExtensions,
} from "./core/compatibility.js";
export type { ParsedCapabilityId } from "./core/compatibility.js";

// Capability discovery and matching.
export {
  checkTargetSatisfies,
  manifestTarget,
  matchEnvironment,
  offerTarget,
  validateCapabilityDescriptors,
  validateManifest,
} from "./core/matching.js";
export type {
  MatchFailure,
  MatchOptions,
  MatchResult,
  MatchTarget,
  RequirementMatcher,
} from "./core/matching.js";

// Time helpers.
export { isUtcTimestamp, nowUtcTimestamp } from "./core/time.js";

// Trusted policy evaluation.
export { PolicyAuthority } from "./core/policy.js";

// Authorized secret resolution.
export {
  AuthorizedSecretResolver,
  ResolvedSecret,
  checkRawTransfer,
  checkRetrievalLocation,
} from "./core/secrets.js";
export type {
  CurrentAuthority,
  SecretLookup,
  SecretResolverOptions,
} from "./core/secrets.js";

// Deterministic test adapter.
export {
  FakeEnvironmentAdapter,
  FakeEnvironmentLease,
} from "./adapters/test-adapter.js";
export type {
  AcquireDirective,
  BindDirective,
  CancelDirective,
  InvokeDirective,
  ReleaseDirective,
  RenewDirective,
} from "./adapters/test-adapter.js";

// Journal stream (durability helpers over the control store).
export {
  EventDeduplicator,
  SessionEventStream,
  uniqueEventKey,
  validateStoredEvent,
} from "./store/event-stream.js";
export type { EventBatch, EventRedactor } from "./store/event-stream.js";

// Content-addressed blob storage and publication checks.
export { BlobStore } from "./store/blob-store.js";
export type { BlobLimits, BlobPutResult, BlobRef } from "./store/blob-store.js";

// Canonical workspace trees and paths.
export {
  buildTreeFromDirectory,
  canonicalTreeJson,
  checkTreeManifest,
  compareTreePaths,
  materializeTree,
  treeRootHash,
  validateWorkspacePath,
} from "./store/workspace-tree.js";
export type {
  ImportedTree,
  ImportOptions,
  TreeEntry,
  TreeEntryKind,
} from "./store/workspace-tree.js";

// Runtime: session identity and inspection.
export { ManagedSession, PortableRuntime } from "./runtime/session.js";

// Runtime: durable acquisition and reconciliation.
export {
  attachEnvironment,
  reconcileAcquisition,
} from "./runtime/acquisition.js";
export type { AttachOptions, ReconcileOptions } from "./runtime/acquisition.js";

// Runtime: workspace import, checkpoints, materialization, and proposals.
export {
  acceptProposal,
  checkpointWorkspace,
  materializeRevision,
  proposeWorkspaceChange,
} from "./runtime/workspace.js";
export type {
  AcceptOutcome,
  CheckpointOptions,
  CheckpointOutcome,
  MaterializeFlowOptions,
  MaterializedCopy,
  ProposalOutcome,
  ProposeOptions,
  SourceStability,
} from "./runtime/workspace.js";

// Runtime: the fs.workspace@1 capability over authorized copies.
export {
  WORKSPACE_CAPABILITY_ID,
  WorkspaceFiles,
  workspaceCapabilityDescriptor,
} from "./runtime/workspace-capability.js";
export type {
  WorkspaceDeleteInput,
  WorkspaceDeleteResult,
  WorkspaceEncoding,
  WorkspaceListInput,
  WorkspaceListedEntry,
  WorkspaceReadInput,
  WorkspaceReadResult,
  WorkspaceStatInput,
  WorkspaceStatResult,
  WorkspaceWriteInput,
  WorkspaceWriteResult,
} from "./runtime/workspace-capability.js";

// Runtime: local export and bridge crash recovery.
export { exportRevision, recoverBridgeExport } from "./runtime/export.js";
export type { ExportFlowOptions, ExportOutcome, ExportRequest } from "./runtime/export.js";

// Runtime: lease renewal and allocation cleanup.
export {
  checkAttachmentAcceptsOperations,
  renewAttachment,
  runCleanup,
} from "./runtime/lifecycle.js";
export type {
  CleanupOptions,
  CleanupOutcome,
  CleanupReport,
  RenewOptions,
  RenewOutcome,
} from "./runtime/lifecycle.js";

// Runtime: invocation admission and request deduplication.
export { admitInvocation } from "./runtime/admission.js";
export type { AdmissionOptions, AdmissionOutcome } from "./runtime/admission.js";

// Runtime: operation outcomes and reconciliation.
export {
  markOperationDispatched,
  reconcileOperation,
  settleOperation,
} from "./runtime/outcomes.js";
export type {
  OperationOutcome,
  OperationResolution,
  OutcomeOptions,
  ReconciliationObservation,
  ReconciliationTrail,
} from "./runtime/outcomes.js";

// Runtime: cancellation and deadlines.
export {
  cancelOperation,
  deadlineFromTimeoutMs,
  waitForOperation,
} from "./runtime/cancellation.js";
export type {
  CancelTransport,
  CancellationAttempt,
  CancellationTrail,
  WaitOutcome,
} from "./runtime/cancellation.js";

// Runtime: streamed output and result artifacts.
export {
  readArtifact,
  readOutputStream,
  recordOutputChunk,
  recordResultArtifact,
} from "./runtime/output.js";
export type { ArtifactInput, ChunkInput, OutputOptions } from "./runtime/output.js";

// Runtime: resource binding, resolution, invalidation, and reattachment.
export {
  bindResource,
  invalidateOwnedResources,
  reattachResource,
  resolveResource,
} from "./runtime/resources.js";
export type {
  BindResourceInput,
  BindTransport,
  ResolveResourceOptions,
  ResourceFlowOptions,
} from "./runtime/resources.js";

// Runtime: the exec.process@1 capability contract.
export {
  PROCESS_ATTRIBUTE_KEYS,
  PROCESS_CAPABILITY_ID,
  PROCESS_OPERATIONS,
  checkProcessAttributes,
  decodeProcessStdin,
  mergeProcessEnvironment,
  processCapabilityDescriptor,
  processInspectInputSchema,
  processInspectResultSchema,
  processRunInputSchema,
  processRunResultSchema,
  processStartInputSchema,
  processStartResultSchema,
  processTerminateInputSchema,
  processTerminateResultSchema,
  resolveProcessCwd,
  shellInvocation,
  validateProcessInput,
  validateProcessInspectInput,
  validateProcessRunInput,
  validateProcessStartInput,
  validateProcessTerminateInput,
} from "./runtime/process-capability.js";
export type {
  ProcessAttributeDeclarations,
  ProcessInput,
  ProcessInspectInput,
  ProcessInspectResult,
  ProcessLaunchInput,
  ProcessOperation,
  ProcessOutputLimits,
  ProcessRunInput,
  ProcessRunResult,
  ProcessStartInput,
  ProcessStartResult,
  ProcessState,
  ProcessStdinEncoding,
  ProcessStreamCapture,
  ProcessTerminateInput,
  ProcessTerminateResult,
  WorkingCopyBound,
} from "./runtime/process-capability.js";

// Records and schemas.
export * from "./schema/error.js";
export * from "./schema/event.js";
export * from "./schema/event-payload.js";
export * from "./schema/policy.js";
export * from "./schema/session.js";
export * from "./schema/capability.js";
export * from "./schema/adapter.js";
export * from "./schema/operation.js";
export * from "./schema/resource.js";
export * from "./schema/workspace.js";
export * from "./schema/handoff.js";
export * from "./schema/bundle.js";
export * from "./schema/library.js";
