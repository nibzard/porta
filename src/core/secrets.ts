import { invalidRequestError, scrubStringValue, scrubValue } from "./errors.js";
import type { PortableError } from "../schema/error.js";
import type { PolicyAuthority } from "./policy.js";
import type { ExecutionLocation } from "../schema/policy.js";

/**
 * Authorized secret resolution (SPEC.md sections 7, 9.3, 10, and 19).
 *
 * The embedding application supplies the lookup function. Every
 * resolution checks the authority that is current at that moment, so a
 * committed policy update blocks later resolutions immediately. Released
 * values stay private to the resolver: `scrub` removes them from anything
 * about to be persisted, and the resolver itself serializes to its
 * reference list only.
 *
 * Checkpoints, portable resource references, and artifact retrieval
 * records carry references. They never carry values.
 */

/** Trusted lookup of one secret value, supplied by the embedding code. */
export type SecretLookup = (reference: string) => string | null;

/** Supplies the authority current at the moment of a check. */
export type CurrentAuthority = () => PolicyAuthority;

/** Options for the resolver constructor. */
export interface SecretResolverOptions {
  authority: CurrentAuthority;
  lookup: SecretLookup;
}

/** Query-string parameters that carry reusable credentials, value included. */
const CREDENTIAL_QUERY_RE =
  /(?:^|[?&])[a-z0-9_-]*(?:token|signature|api[-_]?key|secret|credential|password)[a-z0-9_-]*=[^&\s]*/gi;

/** One resolved secret. The value stays out of enumerable state. */
export class ResolvedSecret {
  readonly reference: string;
  #secretValue: string;

  constructor(reference: string, value: string) {
    this.reference = reference;
    this.#secretValue = value;
  }

  /**
   * Consume the value inside a scoped callback.
   *
   * The combinator keeps the value short-lived: it flows into the
   * consumer, for example a process environment, and not into a record
   * the caller keeps.
   */
  use<T>(consumer: (value: string) => T): T {
    return consumer(this.#secretValue);
  }

  /**
   * Serialize to the reference only. JSON.stringify, nested records,
   * and anything else that walks objects see no value.
   */
  toJSON(): { reference: string } {
    return { reference: this.reference };
  }
}

/** Resolves authorized secret references at use time. */
export class AuthorizedSecretResolver {
  #options: SecretResolverOptions;
  #released = new Map<string, string>();

  constructor(options: SecretResolverOptions) {
    this.#options = options;
  }

  /**
   * Resolve one reference under the current authority.
   *
   * Unauthorized references fail with `PolicyDenied`. A reference the
   * lookup cannot serve fails with `InvalidRequest`; it is never treated
   * as an empty secret.
   */
  resolve(reference: string): ResolvedSecret {
    const denied = this.#options.authority().checkSecretReference(reference);
    if (denied !== null) {
      throw denied;
    }
    const cached = this.#released.get(reference);
    if (cached !== undefined) {
      return new ResolvedSecret(reference, cached);
    }
    const value = this.#options.lookup(reference);
    if (typeof value !== "string") {
      throw invalidRequestError(
        `Secret reference ${reference} has no value in the configured resolver.`,
        { reference },
      );
    }
    this.#released.set(reference, value);
    return new ResolvedSecret(reference, value);
  }

  /** The references released so far. The values stay private. */
  resolvedReferences(): string[] {
    return [...this.#released.keys()].sort();
  }

  /** True when a released value appears anywhere inside a JSON value. */
  containsReleasedValue(value: unknown): boolean {
    const secrets = [...this.#released.values()];
    const walk = (candidate: unknown): boolean => {
      if (typeof candidate === "string") {
        return secrets.some((secret) => secret.length > 0 && candidate.includes(secret));
      }
      if (Array.isArray(candidate)) {
        return candidate.some(walk);
      }
      if (candidate !== null && typeof candidate === "object") {
        return Object.values(candidate).some(walk);
      }
      return false;
    };
    return walk(value);
  }

  /**
   * Remove released values from a value about to be serialized.
   *
   * Substring occurrences become `[redacted]`; then the shared credential
   * scrub drops credential-named keys and credential-shaped strings.
   * Secret references themselves survive: references are public.
   */
  scrub(value: unknown): unknown {
    const secrets = [...this.#released.values()].filter((secret) => secret.length > 0);
    const replace = (text: string): string => {
      let out = text;
      for (const secret of secrets) {
        out = out.split(secret).join("[redacted]");
      }
      return out;
    };
    const walk = (candidate: unknown): unknown => {
      if (typeof candidate === "string") {
        return replace(candidate);
      }
      if (Array.isArray(candidate)) {
        return candidate.map(walk);
      }
      if (candidate !== null && typeof candidate === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(candidate)) {
          out[key] = walk(inner);
        }
        return out;
      }
      return candidate;
    };
    return scrubValue(walk(value));
  }

  /** The resolver serializes to its reference list only. */
  toJSON(): unknown {
    return { resolvedReferences: this.resolvedReferences() };
  }
}

/**
 * Check moving raw bytes toward one destination (SPEC.md sections 9.3
 * and 11.6).
 *
 * Raw outputs and workspace files can contain sensitive data, so they
 * leave their source only for a destination the configured policy
 * allows.
 */
export function checkRawTransfer(
  authority: PolicyAuthority,
  destination: ExecutionLocation,
): PortableError | null {
  return authority.checkTransferDestination(destination);
}

/**
 * Reject retrieval locations that carry credential-shaped material
 * (SPEC.md sections 10 and 19).
 *
 * Reference serialization omits provider access tokens, signed service
 * URLs, and cookies. A location with a credential query parameter or a
 * credential-shaped value is refused instead of cleaned: the caller
 * rebuilds it from an authorized reference.
 */
export function checkRetrievalLocation(location: string): PortableError | null {
  if (scrubStringValue(location) !== location || CREDENTIAL_QUERY_RE.test(location)) {
    return invalidRequestError(
      "The retrieval location carries credential-shaped material.",
      { location: scrubStringValue(location).replace(CREDENTIAL_QUERY_RE, "") },
    );
  }
  return null;
}
