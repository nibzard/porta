import {
  ambiguousEnvironmentError,
  invalidRequestError,
  invalidRequestFromValidation,
  requirementUnsatisfiedError,
} from "./errors.js";
import type { PolicyAuthority } from "./policy.js";
import { capabilityIdSatisfies, checkUnknownConstraints } from "./compatibility.js";
import {
  ValidationError,
  assertValid,
  checkJsonSchemaCompiles,
  validateAgainstSchema,
} from "../schema/validate.js";
import {
  capabilityDescriptorSchema,
  environmentManifestSchema,
  environmentRequestSchema,
} from "../schema/capability.js";
import type {
  CapabilityDescriptor,
  EnforcementFacts,
  EnvironmentManifest,
  EnvironmentOffer,
  EnvironmentRequest,
  ResourceSummary,
} from "../schema/capability.js";
import type { PortableError } from "../schema/error.js";

/**
 * Capability discovery and matching (SPEC.md sections 6.2 to 6.4).
 *
 * Every `requires` entry, platform field, resource minimum, and
 * constraint is mandatory: a target that lacks one is refused, never
 * silently downgraded. Matching rules come from the capability
 * contract, expressed as a fixed matcher vocabulary over declared
 * attributes. Arbitrary object similarity is never used.
 *
 * Version one supports explicit provider selection. Without a provider
 * identifier, zero matches return `RequirementUnsatisfied` and multiple
 * matches return `AmbiguousEnvironment`. Automatic ranking and fallback
 * do not exist, and a preference never weakens a constraint.
 */

/**
 * The requirement-matcher vocabulary of version one.
 *
 * Each requirement entry maps an attribute name to exactly one of these
 * matchers. The same vocabulary applies to policy constraints, matched
 * against the target's declared enforcement.
 */
export type RequirementMatcher =
  | { equals: string | number | boolean | null }
  | { min: number }
  | { max: number }
  | { oneOf: Array<string | number | boolean | null> };

/** Primitive values a matcher can compare. */
type Primitive = string | number | boolean | null;

/**
 * The matching surface shared by offers and manifests.
 *
 * Offers are discovery hints; manifests describe the acquired
 * environment. Both are checked by the same rules, so an acquired
 * allocation cannot claim less than the request demanded.
 */
export interface MatchTarget {
  providerId: string;
  platform?: { os?: string; arch?: string } | undefined;
  capabilities: Array<{
    id: string;
    attributes: Record<string, unknown>;
  }>;
  resources?: ResourceSummary | undefined;
  enforcement?: Record<string, unknown> | undefined;
  /** Typed enforcement facts policy checks authorize against. */
  facts?: EnforcementFacts | undefined;
}

/** Options for selecting one environment. */
export interface MatchOptions {
  /**
   * Constraint names the configured adapters recognize. Unlisted
   * constraint names are rejected as unknown. When omitted, the union of
   * the enforcement keys the offers declare is used.
   */
  recognizedConstraints?: readonly string[];
  /**
   * The trusted policy every candidate must satisfy before selection.
   * Offers the policy denies never reach matching, so a request that
   * omits its provider cannot bypass the provider allowlist.
   */
  authority?: PolicyAuthority | undefined;
}

/** The single environment a request selected. */
export interface MatchResult {
  providerId: string;
  target: MatchTarget;
}

/** Why one target failed the request. */
export interface MatchFailure {
  providerId: string;
  reason: string;
}

/** Project one discovery offer onto the shared matching surface. */
export function offerTarget(offer: EnvironmentOffer): MatchTarget {
  return {
    providerId: offer.providerId,
    platform: offer.platform,
    capabilities: offer.capabilities.map((capability) => ({
      id: capability.id,
      attributes: capability.attributes,
    })),
    resources: offer.resources,
    enforcement: offer.enforcement,
    facts: offer.enforcementFacts,
  };
}

/**
 * Project one acquired manifest onto the shared matching surface.
 *
 * The manifest is validated first: an unparseable or schema-invalid
 * manifest never reaches matching.
 */
export function manifestTarget(manifest: EnvironmentManifest): MatchTarget {
  check(() => assertValid(environmentManifestSchema, manifest));
  validateCapabilityDescriptors(manifest.capabilities);
  return {
    providerId: manifest.providerId,
    platform: manifest.platform,
    capabilities: manifest.capabilities.map((capability) => ({
      id: capability.id,
      attributes: capability.attributes,
    })),
    resources: manifest.resources,
    enforcement: manifest.enforcement,
    facts: manifest.enforcementFacts,
  };
}

/**
 * Validate the capability descriptors of an offer or manifest.
 *
 * Each descriptor satisfies the public schema, and every operation
 * input and output schema compiles as JSON Schema draft 2020-12.
 */
export function validateCapabilityDescriptors(
  capabilities: readonly CapabilityDescriptor[],
): void {
  for (const capability of capabilities) {
    check(() => assertValid(capabilityDescriptorSchema, capability));
    for (const [name, operation] of Object.entries(capability.operations)) {
      for (const field of ["inputSchema", "outputSchema"] as const) {
        const issues = checkJsonSchemaCompiles(operation[field]);
        if (issues.length > 0) {
          throw invalidRequestError(
            `Operation ${name} of ${capability.id} has an invalid ${field}.`,
            {
              capabilityId: capability.id,
              operation: name,
              field,
              issues,
            },
          );
        }
      }
    }
  }
}

/**
 * Select the single environment that satisfies a request.
 *
 * Throws `InvalidRequest` for malformed requests and matchers,
 * `PolicyDenied` when the trusted policy excluded every candidate,
 * `RequirementUnsatisfied` when no target qualifies, and
 * `AmbiguousEnvironment` when several do and the request names no
 * provider. Each non-matching target contributes its reason to the
 * failure details.
 */
export function matchEnvironment(
  request: EnvironmentRequest,
  offers: readonly EnvironmentOffer[],
  options: MatchOptions = {},
): MatchResult {
  check(() => assertValid(environmentRequestSchema, request));
  validateOfferDescriptors(offers);
  const targets = offers.map(offerTarget);
  const recognized =
    options.recognizedConstraints ??
    [...new Set(targets.flatMap((target) => Object.keys(target.enforcement ?? {})))];
  const constraintProblem = checkUnknownConstraints(request.constraints ?? {}, recognized);
  if (constraintProblem !== null) {
    throw constraintProblem;
  }

  // Policy runs before selection: an offer the policy denies never
  // reaches matching, so an omitted provider cannot bypass the
  // allowlist (SPEC.md section 7).
  const candidates: MatchTarget[] = [];
  const policyDenials: Array<{ providerId: string; error: PortableError }> = [];
  for (const target of targets) {
    if (options.authority === undefined) {
      candidates.push(target);
      continue;
    }
    const denial = options.authority.checkAcquisitionTarget({
      providerId: target.providerId,
      facts: target.facts,
      resources: target.resources,
    });
    if (denial === null) {
      candidates.push(target);
    } else {
      policyDenials.push({ providerId: target.providerId, error: denial });
    }
  }

  const named =
    request.providerId === undefined
      ? candidates
      : candidates.filter((target) => target.providerId === request.providerId);

  const failures: MatchFailure[] = policyDenials.map((entry) => ({
    providerId: entry.providerId,
    reason: entry.error.message,
  }));
  const matches: MatchTarget[] = [];
  for (const target of named) {
    const problem = checkTargetSatisfies(request, target);
    if (problem === null) {
      matches.push(target);
    } else {
      failures.push({ providerId: target.providerId, reason: problem.message });
    }
  }

  if (matches.length === 0) {
    if (candidates.length === 0 && policyDenials.length > 0) {
      // Every offered environment was excluded by the trusted policy
      // alone: the refusal names the policy, not the requirements.
      throw policyDenials[0]!.error;
    }
    throw requirementUnsatisfiedError(
      request.providerId === undefined
        ? "No configured environment satisfies the request."
        : `Provider ${request.providerId} does not satisfy the request.`,
      {
        providerId: request.providerId,
        failures,
        consideredProviders: named.map((target) => target.providerId),
      },
    );
  }
  if (matches.length > 1) {
    throw ambiguousEnvironmentError(
      "Several environments satisfy the request; name one provider explicitly.",
      { providers: [...new Set(matches.map((target) => target.providerId))] },
    );
  }
  return { providerId: matches[0]!.providerId, target: matches[0]! };
}

/**
 * Validate an acquired manifest against its request before activation.
 *
 * The manifest passes the same platform, resource, requirement, and
 * constraint checks as discovery, plus its own schema and descriptor
 * validation. Offers are hints; the manifest is the proof.
 */
export function validateManifest(
  request: EnvironmentRequest,
  manifest: EnvironmentManifest,
): void {
  check(() => assertValid(environmentRequestSchema, request));
  const target = manifestTarget(manifest);
  const problem = checkTargetSatisfies(request, target);
  if (problem !== null) {
    throw requirementUnsatisfiedError(
      `The acquired environment from ${manifest.providerId} does not satisfy the request.`,
      { providerId: manifest.providerId, reason: problem.message },
    );
  }
}

/**
 * Check one target against every mandatory dimension of a request.
 *
 * Returns the first unsatisfied dimension as a `RequirementUnsatisfied`
 * error, or null when the target qualifies.
 */
export function checkTargetSatisfies(
  request: EnvironmentRequest,
  target: MatchTarget,
): PortableError | null {
  if (request.providerId !== undefined && target.providerId !== request.providerId) {
    return requirementUnsatisfiedError(
      `Provider ${target.providerId} is not the requested ${request.providerId}.`,
      { providerId: target.providerId },
    );
  }
  const platform = platformProblem(request, target);
  if (platform !== null) {
    return platform;
  }
  const resources = resourcesProblem(request, target);
  if (resources !== null) {
    return resources;
  }
  const requirements = requirementsProblem(request, target);
  if (requirements !== null) {
    return requirements;
  }
  return constraintsProblem(request, target);
}

// -- Dimension checks ---------------------------------------------------------

/** Exact platform matching. A missing field on the target refuses it. */
function platformProblem(
  request: EnvironmentRequest,
  target: MatchTarget,
): PortableError | null {
  for (const field of ["os", "arch"] as const) {
    const expected = request.platform?.[field];
    if (expected === undefined) {
      continue;
    }
    const actual = target.platform?.[field];
    if (actual !== expected) {
      return requirementUnsatisfiedError(
        `Platform ${field} ${actual ?? "unreported"} does not satisfy ${expected}.`,
        { field, expected, actual },
      );
    }
  }
  return null;
}

/** Resource minima. An unreported quantity counts as zero. */
function resourcesProblem(
  request: EnvironmentRequest,
  target: MatchTarget,
): PortableError | null {
  const minima: Record<string, number | undefined> = {
    memoryBytes: request.resources?.memoryBytes?.min,
    storageBytes: request.resources?.storageBytes?.min,
    gpuMemoryBytes: request.resources?.gpuMemoryBytes?.min,
  };
  for (const [field, minimum] of Object.entries(minima)) {
    if (minimum === undefined) {
      continue;
    }
    const actual = target.resources?.[field as keyof ResourceSummary];
    if ((actual ?? 0) < minimum) {
      return requirementUnsatisfiedError(
        `Resource ${field} has ${actual ?? 0} bytes below the required ${minimum}.`,
        { field, required: minimum, actual: actual ?? 0 },
      );
    }
  }
  return null;
}

/**
 * Capability requirements.
 *
 * The requirement key must be a capability identifier in `name@major`
 * form that the target provides. A minor or major difference is a
 * different contract and never satisfies the requirement silently.
 */
function requirementsProblem(
  request: EnvironmentRequest,
  target: MatchTarget,
): PortableError | null {
  for (const [requiredId, matchers] of Object.entries(request.requires)) {
    const providers = target.capabilities.filter((capability) =>
      capabilityIdSatisfies(requiredId, capability.id),
    );
    if (providers.length === 0) {
      return requirementUnsatisfiedError(
        `The environment does not provide ${requiredId}.`,
        { capabilityId: requiredId },
      );
    }
    const satisfied = providers.some((capability) => {
      for (const [attribute, matcher] of Object.entries(matchers)) {
        const problem = applyMatcher(
          `${requiredId}.${attribute}`,
          matcher,
          capability.attributes[attribute],
        );
        if (problem !== null) {
          return false;
        }
      }
      return true;
    });
    if (!satisfied) {
      return requirementUnsatisfiedError(
        `The ${requiredId} attributes do not satisfy the requirement.`,
        { capabilityId: requiredId, requirement: matchers },
      );
    }
  }
  return null;
}

/** Policy constraints, matched against declared enforcement. */
function constraintsProblem(
  request: EnvironmentRequest,
  target: MatchTarget,
): PortableError | null {
  for (const [name, matcher] of Object.entries(request.constraints ?? {})) {
    const problem = applyMatcher(
      `constraints.${name}`,
      matcher,
      (target.enforcement ?? {})[name],
    );
    if (problem !== null) {
      return requirementUnsatisfiedError(
        `Constraint ${name} is not satisfied by the declared enforcement.`,
        { constraint: name, reason: problem.message },
      );
    }
  }
  return null;
}

// -- Matcher vocabulary -------------------------------------------------------

/**
 * Apply one matcher to one declared value.
 *
 * A matcher maps matcher verbs (`equals`, `min`, `max`, `oneOf`) to
 * arguments; every verb present must hold, so `{ min, max }` expresses a
 * range. A malformed matcher throws `InvalidRequest`: it names input the
 * contract does not define. A well-formed matcher that does not hold
 * returns a `RequirementUnsatisfied` error, or null when satisfied.
 */
function applyMatcher(
  path: string,
  matcher: unknown,
  actual: unknown,
): PortableError | null {
  if (matcher === null || typeof matcher !== "object" || Array.isArray(matcher)) {
    throw invalidRequestError(`${path} is not a requirement matcher object.`, { path });
  }
  const entries = Object.entries(matcher);
  if (entries.length === 0) {
    throw invalidRequestError(`${path} carries no matcher verb.`, { path });
  }
  for (const [verb, value] of entries) {
    switch (verb) {
      case "equals":
        if (!sameValue(actual, value as Primitive)) {
          return requirementUnsatisfiedError(
            `${path} is ${describe(actual)}, not ${describe(value)}.`,
            { path, expected: value, actual },
          );
        }
        break;
      case "min":
        if (typeof value !== "number") {
          throw invalidRequestError(`${path}.min must be a number.`, { path });
        }
        if (!(typeof actual === "number" && actual >= value)) {
          return requirementUnsatisfiedError(
            `${path} is ${describe(actual)}, below ${value}.`,
            { path, minimum: value, actual },
          );
        }
        break;
      case "max":
        if (typeof value !== "number") {
          throw invalidRequestError(`${path}.max must be a number.`, { path });
        }
        if (!(typeof actual === "number" && actual <= value)) {
          return requirementUnsatisfiedError(
            `${path} is ${describe(actual)}, above ${value}.`,
            { path, maximum: value, actual },
          );
        }
        break;
      case "oneOf":
        if (!Array.isArray(value)) {
          throw invalidRequestError(`${path}.oneOf must be an array.`, { path });
        }
        if (!value.some((option) => sameValue(actual, option as Primitive))) {
          return requirementUnsatisfiedError(
            `${path} is ${describe(actual)}, not one of the allowed values.`,
            { path, allowed: value, actual },
          );
        }
        break;
      default:
        throw invalidRequestError(`${path} uses the unknown matcher ${verb}.`, {
          path,
          verb,
        });
    }
  }
  return null;
}

/** Strict primitive comparison. */
function sameValue(actual: unknown, expected: Primitive): boolean {
  return (
    (typeof expected === "string" && actual === expected) ||
    (typeof expected === "number" && actual === expected) ||
    (typeof expected === "boolean" && actual === expected) ||
    (expected === null && actual === null)
  );
}

/** Short description of a declared value. */
function describe(value: unknown): string {
  if (value === undefined) {
    return "unreported";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return Array.isArray(value) ? "an array" : "an object";
  }
  return String(value);
}

/** Validate the descriptors carried by discovery offers. */
function validateOfferDescriptors(offers: readonly EnvironmentOffer[]): void {
  for (const offer of offers) {
    for (const capability of offer.capabilities) {
      const issues = validateDescriptorEntries(capability);
      if (issues.length > 0) {
        throw invalidRequestError(
          `Offer from ${offer.providerId} carries an invalid descriptor for ${capability.id}.`,
          { providerId: offer.providerId, capabilityId: capability.id, issues },
        );
      }
    }
  }
}

/** Schema-check the reduced descriptor shape offers carry. */
function validateDescriptorEntries(capability: {
  id: string;
  attributes: Record<string, unknown>;
}): ReturnType<typeof validateAgainstSchema> {
  const descriptor: CapabilityDescriptor = {
    id: capability.id,
    operations: {},
    attributes: capability.attributes,
  };
  return validateAgainstSchema(capabilityDescriptorSchema, descriptor);
}

/** Run a validation body, converting failures to Portable errors. */
function check(body: () => void): void {
  try {
    body();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
}
