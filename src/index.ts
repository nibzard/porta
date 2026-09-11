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
 * - `src/cli`: thin CLI. It calls library contracts only and implements no
 *   lifecycle rules of its own.
 */

export { VERSION } from "./version.js";
