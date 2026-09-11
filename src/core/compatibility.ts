import { portableError } from "./errors.js";
import type { PortableError } from "../schema/error.js";

/** A parsed capability identifier (SPEC.md section 6.1). */
export interface ParsedCapabilityId {
  name: string;
  major: number;
}

/**
 * Parse a capability identifier in `name@major` form.
 *
 * Returns null for malformed identifiers. The major version is a positive
 * integer.
 */
export function parseCapabilityId(id: string): ParsedCapabilityId | null {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) {
    return null;
  }
  const name = id.slice(0, at);
  const majorText = id.slice(at + 1);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return null;
  }
  if (!/^\d+$/.test(majorText)) {
    return null;
  }
  const major = Number(majorText);
  if (!Number.isSafeInteger(major) || major < 1) {
    return null;
  }
  return { name, major };
}

/**
 * True when the actual capability satisfies the required identifier.
 *
 * Breaking semantic changes require a new major version, so a requirement
 * is satisfied only by the exact same name and major version. Optional
 * additive fields stay within one major version and do not affect this
 * check (SPEC.md section 6.1).
 */
export function capabilityIdSatisfies(required: string, actual: string): boolean {
  const requiredId = parseCapabilityId(required);
  const actualId = parseCapabilityId(actual);
  if (requiredId === null || actualId === null) {
    return false;
  }
  return requiredId.name === actualId.name && requiredId.major === actualId.major;
}

/**
 * True when the capability name uses a domain namespace, such as
 * `com.example.video.render`. Third-party names SHOULD use one
 * (SPEC.md section 6.1).
 *
 * Core names such as `exec.process` segment with one dot, so this check
 * requires at least two dot-separated segments beyond the first.
 */
export function isDomainNamespaced(capabilityId: string): boolean {
  const name = parseCapabilityId(capabilityId)?.name ?? capabilityId;
  return /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*){2,}$/.test(name);
}

/**
 * List required extensions this consumer cannot process.
 *
 * An extension that affects correctness MUST be declared in
 * `requiredExtensions`. A consumer that lacks one MUST reject the request
 * or bundle (SPEC.md section 20).
 */
export function missingRequiredExtensions(
  required: readonly string[],
  supported: readonly string[],
): string[] {
  const supportedSet = new Set(supported);
  return required.filter((extension) => !supportedSet.has(extension));
}

/**
 * Check a `requiredExtensions` list against supported extensions.
 *
 * Returns an `InvalidRequest` error naming the missing extensions, or null
 * when the consumer supports everything the request requires.
 */
export function requireExtensions(
  required: readonly string[],
  supported: readonly string[],
): PortableError | null {
  const missing = missingRequiredExtensions(required, supported);
  if (missing.length === 0) {
    return null;
  }
  return portableError(
    "InvalidRequest",
    "The request requires extensions this consumer does not support.",
    { details: { missingExtensions: missing, requiredExtensions: required } },
  );
}

/**
 * Check capability requirements against known capability identifiers.
 *
 * Unknown requirements MUST be rejected, not ignored (SPEC.md section 6.2).
 * Returns a `RequirementUnsatisfied` error naming the unknown keys, or null.
 */
export function checkUnknownRequirements(
  requires: Record<string, unknown>,
  knownCapabilities: readonly string[],
): PortableError | null {
  const known = new Set(knownCapabilities);
  const unknown = Object.keys(requires).filter((key) => !known.has(key));
  if (unknown.length === 0) {
    return null;
  }
  return portableError(
    "RequirementUnsatisfied",
    `Unknown capability requirements: ${unknown.join(", ")}.`,
    { details: { unknownRequirements: unknown, knownCapabilities } },
  );
}

/**
 * Check policy constraints against recognized constraint names.
 *
 * Unknown policy constraints MUST be rejected (SPEC.md section 6.2).
 * Returns an `InvalidRequest` error naming the unknown constraints, or null.
 */
export function checkUnknownConstraints(
  constraints: Record<string, unknown>,
  recognized: readonly string[],
): PortableError | null {
  const known = new Set(recognized);
  const unknown = Object.keys(constraints).filter((key) => !known.has(key));
  if (unknown.length === 0) {
    return null;
  }
  return portableError(
    "InvalidRequest",
    `Unknown policy constraints: ${unknown.join(", ")}.`,
    { details: { unknownConstraints: unknown, recognizedConstraints: recognized } },
  );
}

/**
 * Keep only the extensions this implementation recognizes.
 *
 * Unknown descriptive extensions are tolerated: they pass validation and
 * are ignored here rather than rejected (SPEC.md sections 6.2 and 20).
 */
export function recognizedExtensions(
  extensions: Record<string, unknown> | undefined,
  recognized: readonly string[],
): Record<string, unknown> {
  if (extensions === undefined) {
    return {};
  }
  const kept: Record<string, unknown> = {};
  for (const key of recognized) {
    if (Object.hasOwn(extensions, key)) {
      kept[key] = extensions[key];
    }
  }
  return kept;
}
