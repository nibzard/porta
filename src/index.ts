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
  jsonRoundTrip,
  validateAgainstSchema,
} from "./schema/validate.js";
export type { ValidationIssue } from "./schema/validate.js";

// Time helpers.
export { isUtcTimestamp, nowUtcTimestamp } from "./core/time.js";

// Records and schemas.
export * from "./schema/error.js";
export * from "./schema/event.js";
export * from "./schema/session.js";
export * from "./schema/capability.js";
export * from "./schema/adapter.js";
export * from "./schema/operation.js";
export * from "./schema/resource.js";
export * from "./schema/workspace.js";
export * from "./schema/handoff.js";
export * from "./schema/bundle.js";
export * from "./schema/library.js";
