import { invalidRequestFromValidation, policyDeniedError } from "./errors.js";
import type { PortableError } from "../schema/error.js";
import { ValidationError, assertValid, jsonRoundTrip } from "../schema/validate.js";
import { acquisitionLimitsSchema, policySchema } from "../schema/policy.js";
import type {
  AcquisitionLimits,
  EgressMode,
  ExecutionLocation,
  PortablePolicy,
  PolicyResourceLimits,
} from "../schema/policy.js";
import type {
  EnforcementFacts,
  EnvironmentRequest,
  ResourceRequirements,
  ResourceSummary,
} from "../schema/capability.js";

/**
 * Trusted policy evaluation (SPEC.md sections 6.4 and 7).
 *
 * The embedding application builds the authority from its own
 * authenticated context. Model-controlled invocation input never builds
 * one: request constraints, preferences, and extensions are not read by
 * any check here, and a derived authority can only narrow limits, never
 * widen them.
 *
 * Checks run before acquisition, invocation, resource binding, workspace
 * transfer, and service exposure; the calling task owns that ordering.
 * An omitted permission grants nothing at the root of a policy and
 * inherits the configured value inside a narrowing.
 */

/** Rank of each egress mode. Lower is stricter. */
const EGRESS_RANK: Record<EgressMode, number> = {
  none: 0,
  allowlist: 1,
  unrestricted: 2,
};

/** Resource ceilings with deny-by-default zeros. */
interface EffectiveResources {
  memoryBytes: number;
  storageBytes: number;
  gpuMemoryBytes: number;
}

/** Normalized limits. Every field carries its strictest configured value. */
interface EffectiveLimits {
  providers: ReadonlySet<string>;
  operations: ReadonlySet<string>;
  locations: ReadonlySet<ExecutionLocation>;
  transferDestinations: ReadonlySet<ExecutionLocation>;
  networkEgress: EgressMode;
  egressAllowlist: ReadonlySet<string>;
  hostFilesystemAccess: boolean;
  maxEnvironmentLifetimeMs: number;
  maxResources: EffectiveResources;
  secrets: ReadonlySet<string>;
  serviceAudiences: ReadonlySet<string>;
}

/** Evaluates one approved policy document. */
export class PolicyAuthority {
  private readonly limits: EffectiveLimits;

  private constructor(limits: EffectiveLimits) {
    this.limits = limits;
  }

  /**
   * Build the authority from an embedder-supplied document.
   *
   * The document is validated first: a malformed policy refuses
   * construction instead of failing open.
   */
  static fromPolicy(policy: PortablePolicy): PolicyAuthority {
    return new PolicyAuthority(normalize(policy));
  }

  /**
   * Derive a narrowed authority.
   *
   * Present fields intersect with the current limits; omitted fields
   * inherit them. A narrowing that lists values the parent does not allow
   * loses those values, so no input can widen access through this path.
   */
  derive(narrowing: PortablePolicy): PolicyAuthority {
    const child = normalize(narrowing);
    const parent = this.limits;
    return new PolicyAuthority({
      providers:
        narrowing.providers === undefined
          ? parent.providers
          : intersect(parent.providers, child.providers),
      operations:
        narrowing.operations === undefined
          ? parent.operations
          : intersect(parent.operations, child.operations),
      locations:
        narrowing.locations === undefined
          ? parent.locations
          : intersect(parent.locations, child.locations),
      transferDestinations:
        narrowing.transferDestinations === undefined
          ? parent.transferDestinations
          : intersect(parent.transferDestinations, child.transferDestinations),
      networkEgress:
        narrowing.networkEgress === undefined
          ? parent.networkEgress
          : stricterEgress(parent.networkEgress, child.networkEgress),
      egressAllowlist:
        narrowing.egressAllowlist === undefined
          ? parent.egressAllowlist
          : intersect(parent.egressAllowlist, child.egressAllowlist),
      hostFilesystemAccess:
        narrowing.hostFilesystemAccess === undefined
          ? parent.hostFilesystemAccess
          : parent.hostFilesystemAccess && child.hostFilesystemAccess,
      maxEnvironmentLifetimeMs:
        narrowing.maxEnvironmentLifetimeMs === undefined
          ? parent.maxEnvironmentLifetimeMs
          : Math.min(parent.maxEnvironmentLifetimeMs, child.maxEnvironmentLifetimeMs),
      maxResources: minResources(
        parent.maxResources,
        narrowing.maxResources ?? {},
      ),
      secrets:
        narrowing.secrets === undefined
          ? parent.secrets
          : intersect(parent.secrets, child.secrets),
      serviceAudiences:
        narrowing.serviceAudiences === undefined
          ? parent.serviceAudiences
          : intersect(parent.serviceAudiences, child.serviceAudiences),
    });
  }

  /**
   * The effective policy as a validated, JSON-serializable document.
   *
   * Allow lists carry their resolved contents, so the result states the
   * access it grants rather than the access it omits. A lifetime of zero
   * stays omitted: it grants no environment lifetime at all.
   */
  effectivePolicy(): PortablePolicy {
    const policy: PortablePolicy = {
      schemaVersion: 1,
      providers: [...this.limits.providers].sort(),
      operations: [...this.limits.operations].sort(),
      locations: [...this.limits.locations].sort(),
      transferDestinations: [...this.limits.transferDestinations].sort(),
      networkEgress: this.limits.networkEgress,
      egressAllowlist: [...this.limits.egressAllowlist].sort(),
      hostFilesystemAccess: this.limits.hostFilesystemAccess,
      ...(this.limits.maxEnvironmentLifetimeMs > 0
        ? { maxEnvironmentLifetimeMs: this.limits.maxEnvironmentLifetimeMs }
        : {}),
      maxResources: { ...this.limits.maxResources },
      secrets: [...this.limits.secrets].sort(),
      serviceAudiences: [...this.limits.serviceAudiences].sort(),
    };
    return jsonRoundTrip(policySchema, policy) as PortablePolicy;
  }

  // -- Providers and operations ---------------------------------------------

  /** Check one provider against the acquisition allow list. */
  checkProvider(providerId: string): PortableError | null {
    if (this.limits.providers.has(providerId)) {
      return null;
    }
    return denied("providers", `Provider ${providerId} is not allowed.`, {
      providerId,
    });
  }

  /**
   * Check one capability operation.
   *
   * A grant of `name@major` covers every operation of the capability; a
   * grant of `name@major/operation` covers that operation alone.
   */
  checkOperation(capabilityId: string, operation: string): PortableError | null {
    if (
      this.limits.operations.has(capabilityId) ||
      this.limits.operations.has(`${capabilityId}/${operation}`)
    ) {
      return null;
    }
    return denied(
      "operations",
      `Operation ${operation} of ${capabilityId} is not allowed.`,
      { capabilityId, operation },
    );
  }

  // -- Locations and transfers ------------------------------------------------

  /** Check one execution location. */
  checkLocation(location: ExecutionLocation): PortableError | null {
    if (this.limits.locations.has(location)) {
      return null;
    }
    return denied("locations", `Execution location ${location} is not allowed.`, {
      location,
    });
  }

  /** Check one workspace transfer destination. */
  checkTransferDestination(destination: ExecutionLocation): PortableError | null {
    if (this.limits.transferDestinations.has(destination)) {
      return null;
    }
    return denied(
      "transferDestinations",
      `Workspace transfer to ${destination} is not allowed.`,
      { destination },
    );
  }

  // -- Network egress ---------------------------------------------------------

  /**
   * Check a requested egress mode.
   *
   * The request must stay at or below the allowed mode. A request for
   * `unrestricted` under an `allowlist` policy is denied.
   */
  checkEgress(mode: EgressMode): PortableError | null {
    if (EGRESS_RANK[mode] <= EGRESS_RANK[this.limits.networkEgress]) {
      return null;
    }
    return denied(
      "networkEgress",
      `Egress mode ${mode} exceeds the allowed mode ${this.limits.networkEgress}.`,
      { requested: mode, allowed: this.limits.networkEgress },
    );
  }

  /**
   * Check one egress target host.
   *
   * `unrestricted` allows every host. `none` denies every host. Under
   * `allowlist`, an entry matches its exact host, any port of that host,
   * and a `*.` prefix entry matches the host and every subdomain.
   */
  checkEgressTarget(host: string): PortableError | null {
    if (this.limits.networkEgress === "unrestricted") {
      return null;
    }
    if (this.limits.networkEgress === "none") {
      return denied("networkEgress", "Network egress is not allowed.", { host });
    }
    const [name, port] = splitHost(host);
    for (const entry of this.limits.egressAllowlist) {
      if (hostMatches(name, port, entry)) {
        return null;
      }
    }
    return denied(
      "egressAllowlist",
      `Host ${host} is not on the egress allowlist.`,
      { host },
    );
  }

  // -- Host access, lifetime, and resources ------------------------------------

  /** Whether environment processes may reach the host filesystem. */
  allowsHostFilesystemAccess(): boolean {
    return this.limits.hostFilesystemAccess;
  }

  /**
   * Check a declared host filesystem requirement.
   *
   * A request that needs host access is denied when the policy withholds
   * it. A request that does not need it always passes.
   */
  checkHostFilesystemRequirement(requiresHostAccess: boolean): PortableError | null {
    if (!requiresHostAccess || this.limits.hostFilesystemAccess) {
      return null;
    }
    return denied(
      "hostFilesystemAccess",
      "The request needs host filesystem access the policy does not grant.",
      { requiresHostAccess },
    );
  }

  /** Check a requested environment lifetime in whole milliseconds. */
  checkLifetime(durationMs: number): PortableError | null {
    if (
      Number.isSafeInteger(durationMs) &&
      durationMs >= 0 &&
      durationMs <= this.limits.maxEnvironmentLifetimeMs
    ) {
      return null;
    }
    return denied(
      "maxEnvironmentLifetimeMs",
      `A lifetime of ${durationMs} ms exceeds the allowed ${this.limits.maxEnvironmentLifetimeMs} ms.`,
      { requestedMs: durationMs, allowedMs: this.limits.maxEnvironmentLifetimeMs },
    );
  }

  /** Check resource minima against the configured ceilings. */
  checkResources(requirements: ResourceRequirements): PortableError | null {
    const caps = this.limits.maxResources;
    const dimensions: Array<[string, number, number]> = [
      ["memoryBytes", requirements.memoryBytes?.min ?? 0, caps.memoryBytes],
      ["storageBytes", requirements.storageBytes?.min ?? 0, caps.storageBytes],
      ["gpuMemoryBytes", requirements.gpuMemoryBytes?.min ?? 0, caps.gpuMemoryBytes],
    ];
    for (const [dimension, requested, allowed] of dimensions) {
      if (requested > allowed) {
        return denied(
          "maxResources",
          `Resource ${dimension} needs ${requested} bytes above the allowed ${allowed} bytes.`,
          { dimension, requestedBytes: requested, allowedBytes: allowed },
        );
      }
    }
    return null;
  }

  // -- Secrets and service audiences --------------------------------------------

  /** Check one secret reference against the authorized resolver set. */
  checkSecretReference(reference: string): PortableError | null {
    if (this.limits.secrets.has(reference)) {
      return null;
    }
    return denied("secrets", `Secret reference ${reference} is not authorized.`, {
      reference,
    });
  }

  /** Check one service audience against the exposure allow list. */
  checkServiceAudience(audience: string): PortableError | null {
    if (this.limits.serviceAudiences.has(audience)) {
      return null;
    }
    return denied(
      "serviceAudiences",
      `Service audience ${audience} is not allowed.`,
      { audience },
    );
  }

  // -- Composite request check ---------------------------------------------------

  /**
   * Check an environment request before acquisition.
   *
   * Reads the provider selection, the locality preference, and the
   * resource minima. A preference for a location the policy does not
   * allow is denied up front: a preference never authorizes fallback
   * to a weaker constraint (SPEC.md section 6.4). The actual execution
   * location is still checked against the acquired facts. Constraint
   * and extension fields are ignored: they are model-controlled input
   * and never carry authority.
   */
  checkEnvironmentRequest(request: EnvironmentRequest): PortableError | null {
    if (request.providerId !== undefined) {
      const provider = this.checkProvider(request.providerId);
      if (provider !== null) {
        return provider;
      }
    }
    const preferred = localityOf(request);
    if (preferred !== null) {
      const location = this.checkLocation(preferred);
      if (location !== null) {
        return location;
      }
    }
    if (request.resources !== undefined) {
      const resources = this.checkResources(request.resources);
      if (resources !== null) {
        return resources;
      }
    }
    return null;
  }

  // -- Acquisition targets and leases ---------------------------------------------

  /**
   * Check one acquisition target — an offer or an acquired manifest —
   * against the trusted policy.
   *
   * The provider must be allowed even when the request omitted it.
   * Typed enforcement facts must be present and within the policy:
   * missing evidence never becomes an implicit grant. Declared
   * resource quantities must stay under the ceilings.
   */
  checkAcquisitionTarget(target: {
    providerId: string;
    facts: EnforcementFacts | undefined;
    resources?: ResourceSummary | undefined;
  }): PortableError | null {
    const provider = this.checkProvider(target.providerId);
    if (provider !== null) {
      return provider;
    }
    if (target.facts === undefined) {
      return denied(
        "enforcementFacts",
        `Provider ${target.providerId} declares no typed enforcement facts; access cannot be verified.`,
        { providerId: target.providerId },
      );
    }
    if (!this.limits.locations.has(target.facts.executionLocation)) {
      return denied(
        "locations",
        `Execution location ${target.facts.executionLocation} is not allowed.`,
        { location: target.facts.executionLocation },
      );
    }
    if (EGRESS_RANK[target.facts.networkEgress] > EGRESS_RANK[this.limits.networkEgress]) {
      return denied(
        "networkEgress",
        `Enforced egress ${target.facts.networkEgress} exceeds the allowed mode ${this.limits.networkEgress}.`,
        { enforced: target.facts.networkEgress, allowed: this.limits.networkEgress },
      );
    }
    if (target.facts.hostFilesystemAccess && !this.limits.hostFilesystemAccess) {
      return denied(
        "hostFilesystemAccess",
        "The environment reaches the host filesystem; the policy does not grant that.",
        { enforced: target.facts.hostFilesystemAccess },
      );
    }
    return this.checkActualResources(target.resources);
  }

  /**
   * Check one lease grant against the lifetime ceiling.
   *
   * The adapter contract grants no lease beyond
   * `maxEnvironmentLifetimeMs` from the acquire, and every grant
   * names its end. A grant without an expiration, one already past,
   * or one beyond the ceiling is denied.
   */
  checkLeaseGrant(grant: {
    authorizedAt: string;
    expiresAt: string | undefined;
  }): PortableError | null {
    if (grant.expiresAt === undefined) {
      return denied(
        "maxEnvironmentLifetimeMs",
        "The provider granted no lease expiration; the lifetime ceiling cannot be verified.",
      );
    }
    const span = Date.parse(grant.expiresAt) - Date.parse(grant.authorizedAt);
    if (!Number.isFinite(span)) {
      return denied("maxEnvironmentLifetimeMs", "The lease expiration is not a moment.", {
        expiresAt: grant.expiresAt,
      });
    }
    if (span <= 0) {
      return denied("maxEnvironmentLifetimeMs", "The lease is already expired.", {
        expiresAt: grant.expiresAt,
      });
    }
    if (span > this.limits.maxEnvironmentLifetimeMs) {
      return denied(
        "maxEnvironmentLifetimeMs",
        `The lease span of ${span} ms exceeds the allowed ${this.limits.maxEnvironmentLifetimeMs} ms.`,
        { grantedMs: span, allowedMs: this.limits.maxEnvironmentLifetimeMs },
      );
    }
    return null;
  }

  /**
   * The effective acquisition limits of this authority
   * (SPEC.md sections 7 and 8).
   *
   * The record is validated and JSON-serializable, so it travels with
   * an authorized acquire request. Nothing derived from a request can
   * widen it: only `fromPolicy` and `derive` build one, and `derive`
   * can only narrow.
   */
  acquisitionLimits(): AcquisitionLimits {
    const limits: AcquisitionLimits = {
      executionLocations: [...this.limits.locations].sort(),
      networkEgress: this.limits.networkEgress,
      egressAllowlist: [...this.limits.egressAllowlist].sort(),
      hostFilesystemAccess: this.limits.hostFilesystemAccess,
      maxEnvironmentLifetimeMs: this.limits.maxEnvironmentLifetimeMs,
      maxResources: { ...this.limits.maxResources },
    };
    return jsonRoundTrip(acquisitionLimitsSchema, limits) as AcquisitionLimits;
  }

  /**
   * Check the resources one environment actually reported.
   *
   * Reported quantities must stay under the ceilings. An unreported
   * dimension makes no claim; request minima are checked separately,
   * and adapters that allocate bounded resources must report them.
   */
  private checkActualResources(reported: ResourceSummary | undefined): PortableError | null {
    if (reported === undefined) {
      return null;
    }
    const caps = this.limits.maxResources;
    const dimensions: Array<[string, number | undefined, number]> = [
      ["memoryBytes", reported.memoryBytes, caps.memoryBytes],
      ["storageBytes", reported.storageBytes, caps.storageBytes],
      ["gpuMemoryBytes", reported.gpuMemoryBytes, caps.gpuMemoryBytes],
    ];
    for (const [dimension, actual, allowed] of dimensions) {
      if (actual !== undefined && actual > allowed) {
        return denied(
          "maxResources",
          `Resource ${dimension} allocated ${actual} bytes above the allowed ${allowed} bytes.`,
          { dimension, allocatedBytes: actual, allowedBytes: allowed },
        );
      }
    }
    return null;
  }
}

/** Validate a policy document and resolve its strict defaults. */
function normalize(policy: PortablePolicy): EffectiveLimits {
  try {
    assertValid(policySchema, policy);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  return {
    providers: new Set(policy.providers ?? []),
    operations: new Set(policy.operations ?? []),
    locations: new Set(policy.locations ?? []),
    transferDestinations: new Set(policy.transferDestinations ?? []),
    networkEgress: policy.networkEgress ?? "none",
    egressAllowlist: new Set(
      (policy.egressAllowlist ?? []).map((entry) => entry.toLowerCase()),
    ),
    hostFilesystemAccess: policy.hostFilesystemAccess ?? false,
    maxEnvironmentLifetimeMs: policy.maxEnvironmentLifetimeMs ?? 0,
    maxResources: {
      memoryBytes: policy.maxResources?.memoryBytes ?? 0,
      storageBytes: policy.maxResources?.storageBytes ?? 0,
      gpuMemoryBytes: policy.maxResources?.gpuMemoryBytes ?? 0,
    },
    secrets: new Set(policy.secrets ?? []),
    serviceAudiences: new Set(policy.serviceAudiences ?? []),
  };
}

/** Intersect two sets into a new one. */
function intersect<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): Set<T> {
  const result = new Set<T>();
  for (const value of left) {
    if (right.has(value)) {
      result.add(value);
    }
  }
  return result;
}

/** The strictest of two resource ceiling pairs. Omitted child fields inherit. */
function minResources(
  parent: EffectiveResources,
  child: Partial<PolicyResourceLimits>,
): EffectiveResources {
  return {
    memoryBytes: Math.min(parent.memoryBytes, child.memoryBytes ?? Infinity),
    storageBytes: Math.min(parent.storageBytes, child.storageBytes ?? Infinity),
    gpuMemoryBytes: Math.min(parent.gpuMemoryBytes, child.gpuMemoryBytes ?? Infinity),
  };
}

/** The stricter of two egress modes. */
function stricterEgress(parent: EgressMode, child: EgressMode): EgressMode {
  return EGRESS_RANK[child] < EGRESS_RANK[parent] ? child : parent;
}

/** Split a host string into a lowercase name and an optional port. */
function splitHost(host: string): [string, string | null] {
  const lowered = host.toLowerCase();
  const at = lowered.lastIndexOf(":");
  if (at > 0 && lowered.slice(at + 1).match(/^[0-9]+$/) !== null) {
    return [lowered.slice(0, at), lowered.slice(at + 1)];
  }
  return [lowered, null];
}

/** Whether an allowlist entry matches a host name and port. */
function hostMatches(name: string, port: string | null, entry: string): boolean {
  const [entryName, entryPort] = splitHost(entry);
  if (entryPort !== null && port !== entryPort) {
    return false;
  }
  if (entryName.startsWith("*.")) {
    const base = entryName.slice(2);
    return name === base || name.endsWith(`.${base}`);
  }
  return name === entryName;
}

/** Build a policy denial with its dimension. */
function denied(
  dimension: string,
  message: string,
  details?: Record<string, unknown>,
): PortableError {
  return policyDeniedError(message, { dimension, ...details });
}

/** The location a locality preference ranks first, or null when absent. */
function localityOf(request: EnvironmentRequest): ExecutionLocation | null {
  switch (request.preferences?.locality) {
    case "local-first":
      return "local";
    case "remote-first":
      return "remote";
    default:
      return null;
  }
}
