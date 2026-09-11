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

// Runtime: session identity and inspection.
export { ManagedSession, PortableRuntime } from "./runtime/session.js";

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
