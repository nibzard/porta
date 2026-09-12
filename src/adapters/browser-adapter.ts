import { createHash, randomUUID } from "node:crypto";
import {
  invalidRequestError,
  invalidRequestFromValidation,
  leaseExpiredError,
  policyDeniedError,
  unsupportedOperationError,
} from "../core/errors.js";
import { ValidationError, assertValid } from "../schema/validate.js";
import {
  adapterInvocationSchema,
  authorizedAcquireRequestSchema,
} from "../schema/adapter.js";
import type {
  AdapterInvocation,
  AdapterOperation,
  AdapterOperationStatus,
  AcquisitionStatus,
  AuthorizedAcquireRequest,
  BindingResult,
  CancellationResult,
  EnvironmentAdapter,
  EnvironmentLease,
  LeaseStatus,
  ReleaseResult,
} from "../schema/adapter.js";
import type { AuthorizedContext } from "../schema/adapter.js";
import type {
  EnforcementFacts,
  EnvironmentManifest,
  EnvironmentOffer,
} from "../schema/capability.js";
import type { Extensions } from "../schema/defs.js";
import type { ResourceRef } from "../schema/resource.js";
import { checkTargetSatisfies, manifestTarget } from "../core/matching.js";
import {
  BROWSER_CAPABILITY_ID,
  BROWSER_RESOURCE_TYPE,
  browserCapabilityDescriptor,
  browserResourceRef,
  browserSurvivesOwnerRelease,
  validateBrowserCloseInput,
  validateBrowserCreateInput,
  validateBrowserInspectInput,
  validateBrowserNavigateInput,
  validateBrowserScreenshotInput,
} from "../runtime/browser-capability.js";
import type {
  BrowserAttributeDeclarations,
  BrowserCloseResult,
  BrowserCreateResult,
  BrowserImageCapture,
  BrowserInspectResult,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserState,
  BrowserWaitUntil,
} from "../runtime/browser-capability.js";
import { VERSION } from "../version.js";

/**
 * Reference browser adapter (SPEC.md sections 8 and 14.4).
 *
 * The adapter operates `browser.session@1` sessions that live in the
 * provider, not in any compute allocation. Each acquisition opens one
 * browser environment; sessions created through it carry the owning
 * attachment and generation, and their declared persistence decides
 * what a release means:
 *
 * - `external` sessions survive the release of the environment that
 *   created them. A later attachment reaches them again only through
 *   a binding, when the provider declares reattachment support.
 * - `attachment` sessions close at that release.
 * - `operation` sessions close when the invocation that touched them
 *   ends; they never cross operation boundaries at all.
 *
 * Closing compute never closes a browser another attachment owns: a
 * release touches exactly the sessions of its own environment. Provider
 * expiration stays a provider-reported fact — `inspect` reports what
 * the driver observes, and nothing infers an expiry from a lease or a
 * clock. Cookies and authenticated state stay inside the driver; no
 * operation result, manifest, or record carries them.
 *
 * The driver interface carries the provider calls this adapter makes.
 * Sessions live in this adapter process's memory, and the offer says
 * so: a restarted process holds none of them, and reconciliation
 * answers `unknown` rather than a guess.
 */

/** Provider identity of this adapter. */
export const BROWSER_PROVIDER_ID = "browser-reference";

/** Invocation extension naming the session that owns a resource. */
export const OWNER_SESSION_EXTENSION = "portable.runtime.session-id";

/** Invocation extension naming the attachment that owns a resource. */
export const OWNER_ATTACHMENT_EXTENSION = "portable.runtime.attachment-id";

/** Invocation extension naming the owner attachment generation. */
export const OWNER_GENERATION_EXTENSION = "portable.runtime.generation";

/** Resource extension naming the provider session behind a resource. */
export const PROVIDER_SESSION_EXTENSION = "portable.browser.provider-session-id";

/** The attachment identity one invocation acts for. */
export interface BrowserOwner {
  sessionId: string;
  attachmentId: string;
  generation: number;
}

/**
 * Read the owner identity from one invocation's extensions.
 *
 * Returns null when any owner field is missing or malformed; the
 * caller decides whether that refusal is the right answer.
 */
export function browserOwnerOf(extensions: Extensions | undefined): BrowserOwner | null {
  if (extensions === undefined) {
    return null;
  }
  const sessionId = extensions[OWNER_SESSION_EXTENSION];
  const attachmentId = extensions[OWNER_ATTACHMENT_EXTENSION];
  const generation = extensions[OWNER_GENERATION_EXTENSION];
  if (
    typeof sessionId !== "string" ||
    typeof attachmentId !== "string" ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return null;
  }
  return { sessionId, attachmentId, generation };
}

// -- Driver surface ------------------------------------------------------------

/** What one session creation asks the provider for. */
export interface BrowserDriverCreate {
  viewport?: { width: number; height: number };
  locale?: string;
  userAgent?: string;
}

/** Where one navigation ended. */
export interface BrowserDriverNavigation {
  /** URL after provider redirects. */
  finalUrl: string;
  /** Main document status, when the provider knows it. */
  status?: number;
}

/** Raw bytes one screenshot captured. */
export interface BrowserDriverCapture {
  bytes: Uint8Array;
  /** `true` when the provider dropped part of the image. */
  truncated: boolean;
}

/** What the provider observes about one session right now. */
export interface BrowserDriverObservation {
  state: "active" | "expired" | "closed" | "unknown";
  /** Why the provider says the session ended, when it expired. */
  expirationReason?: string;
  url?: string;
  title?: string;
  /** Session expiry the provider reports, when it reports one. */
  expiresAt?: string;
}

/** One provider session the adapter drives. */
export interface BrowserDriverSession {
  readonly providerSessionId: string;
  navigate(url: string, waitUntil: BrowserWaitUntil): Promise<BrowserDriverNavigation>;
  screenshot(input: {
    format: "png" | "jpeg";
    fullPage?: boolean;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<BrowserDriverCapture>;
  /** The provider's own word on this session, never an inference. */
  observe(): Promise<BrowserDriverObservation>;
  /** `true` only when the provider closed a live session. */
  close(): Promise<boolean>;
}

/** The provider calls this adapter makes; tests inject a scripted one. */
export interface BrowserDriver {
  createSession(input: BrowserDriverCreate): Promise<BrowserDriverSession>;
}

// -- Records and options ---------------------------------------------------------

/** The adapter's record of one browser session. */
export interface BrowserSessionRecord {
  resourceId: string;
  providerSessionId: string;
  /** Environment whose lease created this session. */
  environmentId: string;
  owner: BrowserOwner;
  createdAt: string;
  /** When the owning environment was released, once it was. */
  ownerReleasedAt?: string;
  /** When a binding adopted this session into a new attachment. */
  reattachedAt?: string;
  closedAt?: string;
}

/** Durable record of one acquisition identity. */
export interface BrowserAcquisitionRecord {
  acquisitionId: string;
  environmentId: string;
  createdAt: string;
  expiresAt: string;
  releasedAt?: string;
}

/** Options of one browser adapter. */
export interface BrowserAdapterOptions {
  /** Provider driver this adapter calls; required. */
  driver: BrowserDriver;
  /** Session persistence every session of this provider carries. */
  sessionPersistence?: BrowserAttributeDeclarations["sessionPersistence"];
  /** Whether a new attachment can adopt a provider session. */
  reattachment?: BrowserAttributeDeclarations["reattachment"];
  /** Origins pages may contact; the adapter enforces what is declared. */
  allowedOrigins?: string[];
  /** Whether loopback and private ranges are blocked. */
  blockPrivateRanges?: boolean;
  /** Interaction operations declared beyond the required five. */
  interactionOperations?: string[];
  /** Lease lifetime of one acquisition. */
  leaseTtlMs?: number;
  /** Captures at or below this size also return inline bytes. */
  maxInlineImageBytes?: number;
}

/** Default lease lifetime: fifteen minutes. */
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/**
 * Typed enforcement facts of this provider (SPEC.md 7).
 *
 * Sessions run in the local driver process against an origin
 * allowlist; the driver blocks private address ranges by default and
 * the provider reaches no host filesystem.
 */
const ENFORCEMENT_FACTS: EnforcementFacts = {
  executionLocation: "local",
  networkEgress: "allowlist",
  hostFilesystemAccess: false,
};

/** Default inline capture ceiling: sixty-four KiB. */
const DEFAULT_INLINE_IMAGE_BYTES = 64 * 1024;

interface SessionEntry {
  record: BrowserSessionRecord;
  driver: BrowserDriverSession;
}

export class BrowserAdapter implements EnvironmentAdapter {
  readonly id = BROWSER_PROVIDER_ID;
  private readonly driver: BrowserDriver;
  private readonly declared: BrowserAttributeDeclarations;
  private readonly leaseTtlMs: number;
  private readonly inlineCap: number;
  private readonly acquisitions = new Map<string, BrowserAcquisitionRecord>();
  private readonly byEnvironment = new Map<string, string>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly byProviderSession = new Map<string, string>();
  private readonly operations = new Map<string, AdapterOperationStatus>();
  private closed = false;

  constructor(options: BrowserAdapterOptions) {
    this.driver = options.driver;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.inlineCap = options.maxInlineImageBytes ?? DEFAULT_INLINE_IMAGE_BYTES;
    this.declared = {
      sessionPersistence: options.sessionPersistence ?? "external",
      reattachment: options.reattachment ?? "provider-session",
      interactionOperations: [
        ...(options.interactionOperations ?? ["navigate", "screenshot"]),
      ],
      networkConstraints: {
        allowedOrigins: [...(options.allowedOrigins ?? ["https://example.org"])],
        blockPrivateRanges: options.blockPrivateRanges ?? true,
      },
    };
  }

  // -- EnvironmentAdapter ------------------------------------------------------

  async describe(): Promise<EnvironmentOffer[]> {
    return [this.offer()];
  }

  async acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease> {
    checkValid(() => assertValid(authorizedAcquireRequestSchema, request));
    this.requireOpen();
    const existing = this.acquisitions.get(request.acquisitionId);
    if (existing !== undefined) {
      // One acquisition identity owns at most one environment; a
      // repeated acquire returns the same lease (SPEC.md section 5.2).
      return new BrowserLease(this, existing.environmentId);
    }
    const environmentId = `env-browser-${randomUUID()}`;
    // Requirements this provider cannot satisfy are rejected here,
    // before any session exists (SPEC.md section 7).
    const unsatisfied = checkTargetSatisfies(
      request.request,
      manifestTarget(this.manifestOf(environmentId)),
    );
    if (unsatisfied !== null) {
      throw unsatisfied;
    }
    const ttlMs = this.admissibleLeaseMs(request.limits);
    const now = new Date().toISOString();
    const record: BrowserAcquisitionRecord = {
      acquisitionId: request.acquisitionId,
      environmentId,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    this.acquisitions.set(record.acquisitionId, record);
    this.byEnvironment.set(record.environmentId, record.acquisitionId);
    return new BrowserLease(this, environmentId);
  }

  async reconcile(acquisitionId: string): Promise<AcquisitionStatus> {
    const record = this.acquisitions.get(acquisitionId);
    if (record === undefined) {
      // Sessions live in this adapter process's memory; a process
      // that restarts holds none of them. The honest answer is
      // unknown, never a guess (SPEC.md section 8).
      return { acquisitionId, state: "unknown" };
    }
    return {
      acquisitionId,
      state: record.releasedAt !== undefined ? "released" : "allocated",
      environmentId: record.environmentId,
      manifest: this.manifestOf(record.environmentId),
      expiresAt: record.expiresAt,
    };
  }

  /** Stop every live session and refuse later calls. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.sessions.values()) {
      if (entry.record.closedAt === undefined) {
        await entry.driver.close();
        entry.record.closedAt = new Date().toISOString();
      }
    }
  }

  // -- Adapter surface ------------------------------------------------------------

  /**
   * The lease span the effective limits admit, or a refusal.
   *
   * Sessions run locally in this process, so a policy that allows no
   * local execution is refused. A driver without network enforcement
   * support cannot advertise a network the policy closes entirely:
   * `none` refuses, and the allowlist contract itself is enforced by
   * the driver before requests leave it (R4 tightens redirects and
   * dependencies). The lease span is constrained to the lifetime
   * ceiling.
   */
  private admissibleLeaseMs(limits: AuthorizedAcquireRequest["limits"]): number {
    if (!limits.executionLocations.includes("local")) {
      throw policyDeniedError(
        "The browser provider executes locally; the policy allows no local execution.",
        { dimension: "locations", allowed: limits.executionLocations },
      );
    }
    if (limits.networkEgress === "none") {
      throw policyDeniedError(
        "The browser driver enforces an origin allowlist; it cannot close the network entirely.",
        { dimension: "networkEgress", allowed: limits.networkEgress },
      );
    }
    if (limits.maxEnvironmentLifetimeMs <= 0) {
      throw policyDeniedError(
        "The policy grants no environment lifetime.",
        { dimension: "maxEnvironmentLifetimeMs", allowedMs: limits.maxEnvironmentLifetimeMs },
      );
    }
    return Math.min(this.leaseTtlMs, limits.maxEnvironmentLifetimeMs);
  }

  /** The declarations every environment of this adapter carries. */
  attributes(): BrowserAttributeDeclarations {
    return {
      sessionPersistence: this.declared.sessionPersistence,
      reattachment: this.declared.reattachment,
      interactionOperations: [...this.declared.interactionOperations],
      networkConstraints: {
        allowedOrigins: [...this.declared.networkConstraints.allowedOrigins],
        blockPrivateRanges: this.declared.networkConstraints.blockPrivateRanges,
      },
    };
  }

  /** The discovery offer of this adapter. */
  offer(): EnvironmentOffer {
    const descriptor = browserCapabilityDescriptor(this.attributes());
    return {
      providerId: BROWSER_PROVIDER_ID,
      adapterId: BROWSER_PROVIDER_ID,
      platform: { os: process.platform, arch: process.arch },
      capabilities: [{ id: descriptor.id, attributes: descriptor.attributes }],
      enforcement: this.enforcement(),
      enforcementFacts: { ...ENFORCEMENT_FACTS },
    };
  }

  /** The manifest of one browser environment. */
  manifestOf(environmentId: string): EnvironmentManifest {
    return {
      environmentId,
      providerId: BROWSER_PROVIDER_ID,
      platform: { os: process.platform, arch: process.arch },
      capabilities: [browserCapabilityDescriptor(this.attributes())],
      enforcement: this.enforcement(),
      enforcementFacts: { ...ENFORCEMENT_FACTS },
      adapterVersion: VERSION,
    };
  }

  /** Enforcement this provider can honestly declare. */
  private enforcement(): Record<string, unknown> {
    return {
      isolation: "provider-driver",
      hostFilesystem: "none",
      networkEgress: this.declared.networkConstraints.blockPrivateRanges
        ? "allowlist-private-blocked"
        : "allowlist",
      sessionStore: "adapter-memory",
      reattachment: this.declared.reattachment,
    };
  }

  /** Every session record of one environment. */
  sessionRecordsOf(environmentId: string): BrowserSessionRecord[] {
    return [...this.sessions.values()]
      .filter((entry) => entry.record.environmentId === environmentId)
      .map((entry) => ({ ...entry.record }));
  }

  /** The provider's current word on one session resource. */
  async sessionStateOf(resourceId: string): Promise<BrowserState> {
    const entry = this.sessions.get(resourceId);
    if (entry === undefined) {
      return "unknown";
    }
    const observed = await entry.driver.observe();
    return observed.state;
  }

  /** Record one operation answer for later inspection. */
  recordOperation(status: AdapterOperationStatus): void {
    this.operations.set(status.operationId, status);
  }

  /** One recorded operation, or null. */
  operationOf(operationId: string): AdapterOperationStatus | null {
    return this.operations.get(operationId) ?? null;
  }

  /** The acquisition record that owns one environment. */
  acquisitionOfEnvironment(environmentId: string): BrowserAcquisitionRecord | null {
    const id = this.byEnvironment.get(environmentId);
    return id === undefined ? null : (this.acquisitions.get(id) ?? null);
  }

  /** Mark the acquisition of one environment released. */
  markReleased(environmentId: string): void {
    const record = this.acquisitionOfEnvironment(environmentId);
    if (record === null || record.releasedAt !== undefined) {
      return;
    }
    this.acquisitions.set(record.acquisitionId, {
      ...record,
      releasedAt: new Date().toISOString(),
    });
  }

  /** Whether the acquisition of one environment is released. */
  isReleased(environmentId: string): boolean {
    return this.acquisitionOfEnvironment(environmentId)?.releasedAt !== undefined;
  }

  /** The expiry the acquisition of one environment recorded. */
  expiryOf(environmentId: string): string {
    return (
      this.acquisitionOfEnvironment(environmentId)?.expiresAt ??
      new Date(0).toISOString()
    );
  }

  /** Extend the lease of one environment to an absolute time. */
  extendLease(environmentId: string, expiresAt: string): void {
    const record = this.acquisitionOfEnvironment(environmentId);
    if (record === null) {
      return;
    }
    this.acquisitions.set(record.acquisitionId, { ...record, expiresAt });
  }

  /** Run one invocation against one environment of this provider. */
  async invokeOnLease(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<AdapterOperation> {
    checkValid(() => assertValid(adapterInvocationSchema, request));
    if (this.isReleased(environmentId)) {
      throw leaseExpiredError(
        `environment ${environmentId}`,
        this.acquisitionOfEnvironment(environmentId)?.releasedAt ??
          this.expiryOf(environmentId),
      );
    }
    if (Date.now() > Date.parse(this.expiryOf(environmentId))) {
      throw leaseExpiredError(`environment ${environmentId}`, this.expiryOf(environmentId));
    }
    if (request.capability !== BROWSER_CAPABILITY_ID) {
      throw unsupportedOperationError(request.capability, request.operation, {
        reason: "The browser adapter offers only browser.session@1.",
      });
    }
    let result: unknown;
    switch (request.operation) {
      case "create":
        result = await this.create(environmentId, request);
        break;
      case "navigate":
        result = await this.navigate(environmentId, request);
        break;
      case "screenshot":
        result = await this.screenshot(environmentId, request);
        break;
      case "inspect":
        result = await this.inspect(environmentId, request);
        break;
      case "close":
        result = await this.closeSession(environmentId, request);
        break;
      default:
        throw unsupportedOperationError(request.capability, request.operation);
    }
    // Operation-scoped sessions end with the operation that touched
    // them; they never cross operation boundaries (SPEC.md 14.4).
    if (this.declared.sessionPersistence === "operation") {
      await this.closeSessionsOf(environmentId);
    }
    const status: AdapterOperationStatus = {
      operationId: request.operationId,
      status: "completed",
      result,
    };
    this.recordOperation(status);
    return { ...status };
  }

  /**
   * Adopt one provider session into a new attachment.
   *
   * A session is reachable after its environment's release only
   * through this path, and only when the provider declares
   * `provider-session` reattachment. The adoption re-parents the
   * session; it never exports provider state.
   */
  async reattach(
    environmentId: string,
    resource: ResourceRef,
    context: AuthorizedContext,
  ): Promise<BindingResult> {
    void context;
    if (this.declared.reattachment !== "provider-session") {
      return { status: "unsupported" };
    }
    if (resource.type !== BROWSER_RESOURCE_TYPE) {
      return { status: "unsupported" };
    }
    const entry = this.entryOf(resource);
    if (entry === null) {
      return {
        status: "failed",
        error: invalidRequestError(
          "The browser session named by this binding is not held by this provider.",
          { resourceId: resource.id, reason: "session-not-held" },
        ),
      };
    }
    if (entry.record.closedAt !== undefined) {
      return {
        status: "failed",
        error: invalidRequestError(
          "The browser session named by this binding is already closed.",
          { resourceId: resource.id, reason: "session-closed" },
        ),
      };
    }
    const observed = await entry.driver.observe();
    if (observed.state !== "active") {
      // The provider's word decides; the adapter never revives a
      // session the provider calls expired or closed.
      return {
        status: "failed",
        error: invalidRequestError(
          `The provider reports this session as ${observed.state}.`,
          {
            resourceId: resource.id,
            reason: `session-${observed.state}`,
            ...(observed.expirationReason !== undefined
              ? { expirationReason: observed.expirationReason }
              : {}),
          },
        ),
      };
    }
    entry.record.owner = {
      sessionId: resource.owner.sessionId,
      attachmentId: resource.owner.attachmentId,
      generation: resource.owner.generation,
    };
    entry.record.environmentId = environmentId;
    entry.record.reattachedAt = new Date().toISOString();
    return {
      status: "bound",
      binding: {
        ...resource,
        extensions: {
          ...resource.extensions,
          [PROVIDER_SESSION_EXTENSION]: entry.record.providerSessionId,
        },
      },
      extensions: { [PROVIDER_SESSION_EXTENSION]: entry.record.providerSessionId },
    };
  }

  /**
   * Resolve every session of one environment at its release.
   *
   * A session that survives its owner — external persistence with a
   * reattachment path — stays alive for a later binding. Every other
   * session closes. Sessions of other environments are never touched
   * (SPEC.md section 14.4).
   */
  async releaseEnvironment(environmentId: string, now: string): Promise<void> {
    const survives = browserSurvivesOwnerRelease({
      lifetime:
        this.declared.sessionPersistence === "external"
          ? "external"
          : this.declared.sessionPersistence,
      recovery: this.declared.reattachment === "provider-session" ? "reattach" : "none",
    });
    for (const entry of this.sessions.values()) {
      if (entry.record.environmentId !== environmentId) {
        continue;
      }
      if (entry.record.closedAt !== undefined) {
        continue;
      }
      if (survives) {
        entry.record.ownerReleasedAt = now;
        continue;
      }
      await entry.driver.close();
      entry.record.closedAt = now;
    }
    this.markReleased(environmentId);
  }

  /** Close every session of one environment. */
  async closeSessionsOf(environmentId: string): Promise<void> {
    for (const entry of this.sessions.values()) {
      if (entry.record.environmentId !== environmentId) {
        continue;
      }
      if (entry.record.closedAt === undefined) {
        await entry.driver.close();
        entry.record.closedAt = new Date().toISOString();
      }
    }
  }

  /** Resolve one session entry from a resource reference. */
  private entryOf(resource: ResourceRef): SessionEntry | null {
    const byId = this.sessions.get(resource.id);
    if (byId !== undefined) {
      return byId;
    }
    const providerSessionId = resource.extensions?.[PROVIDER_SESSION_EXTENSION];
    if (typeof providerSessionId === "string") {
      const resourceId = this.byProviderSession.get(providerSessionId);
      if (resourceId !== undefined) {
        return this.sessions.get(resourceId) ?? null;
      }
    }
    return null;
  }

  private requireOpen(): void {
    if (this.closed) {
      throw invalidRequestError("This browser adapter is closed.");
    }
  }

  // -- Operations -----------------------------------------------------------------

  private async create(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<BrowserCreateResult> {
    const input = validateBrowserCreateInput(request.input);
    const owner = browserOwnerOf(request.extensions);
    if (owner === null) {
      // Without an owner identity the session would belong to no
      // attachment, and no release or binding rule could apply.
      throw invalidRequestError(
        "A browser create must name its owning attachment and generation.",
        {
          reason: "owner-unspecified",
          expected: [
            OWNER_SESSION_EXTENSION,
            OWNER_ATTACHMENT_EXTENSION,
            OWNER_GENERATION_EXTENSION,
          ],
        },
      );
    }
    const driver = await this.driver.createSession({
      ...(input.viewport !== undefined ? { viewport: input.viewport } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });
    const resourceId = `res-browser-${randomUUID()}`;
    // The provider's own report fixes the session expiry, when it
    // reports one; the adapter never invents it.
    const observed = await driver.observe();
    const resource = {
      ...browserResourceRef(
        {
          id: resourceId,
          sessionId: owner.sessionId,
          owner,
          ...(observed.expiresAt !== undefined ? { expiresAt: observed.expiresAt } : {}),
        },
        this.declared,
      ),
      extensions: { [PROVIDER_SESSION_EXTENSION]: driver.providerSessionId },
    };
    const entry: SessionEntry = {
      record: {
        resourceId,
        providerSessionId: driver.providerSessionId,
        environmentId,
        owner,
        createdAt: new Date().toISOString(),
      },
      driver,
    };
    this.sessions.set(resourceId, entry);
    this.byProviderSession.set(driver.providerSessionId, resourceId);
    return {
      resource,
      providerSessionId: driver.providerSessionId,
      createdAt: entry.record.createdAt,
    };
  }

  private requireSession(environmentId: string, resourceId: string): SessionEntry {
    const entry = this.sessions.get(resourceId);
    if (entry === undefined) {
      throw invalidRequestError(
        `Browser session ${resourceId} is not known to this provider.`,
        { resourceId, reason: "session-unknown" },
      );
    }
    if (entry.record.closedAt !== undefined) {
      throw invalidRequestError(
        `Browser session ${resourceId} is closed.`,
        { resourceId, reason: "session-closed" },
      );
    }
    // One environment drives its own sessions and the sessions a
    // binding adopted into it — nothing else.
    if (entry.record.environmentId !== environmentId) {
      throw invalidRequestError(
        `Browser session ${resourceId} belongs to another environment.`,
        { resourceId, reason: "session-foreign" },
      );
    }
    return entry;
  }

  private async navigate(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<BrowserNavigateResult> {
    const input = validateBrowserNavigateInput(request.input);
    const entry = this.requireSession(environmentId, input.resourceId);
    this.enforceNetwork(input.url);
    const waitUntil: BrowserWaitUntil = input.waitUntil ?? "load";
    const navigation = await entry.driver.navigate(input.url, waitUntil);
    return {
      resourceId: input.resourceId,
      url: input.url,
      finalUrl: navigation.finalUrl,
      ...(navigation.status !== undefined ? { status: navigation.status } : {}),
      waitUntil,
      navigatedAt: new Date().toISOString(),
    };
  }

  private async screenshot(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<BrowserScreenshotResult> {
    const input = validateBrowserScreenshotInput(request.input);
    const entry = this.requireSession(environmentId, input.resourceId);
    const format = input.format ?? "png";
    const capture = await entry.driver.screenshot({
      format,
      ...(input.fullPage !== undefined ? { fullPage: input.fullPage } : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
    });
    const image = imageCapture(capture.bytes, capture.truncated, this.inlineCap);
    return {
      resourceId: input.resourceId,
      format,
      image,
      capturedAt: new Date().toISOString(),
    };
  }

  private async inspect(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<BrowserInspectResult> {
    const input = validateBrowserInspectInput(request.input);
    const entry = this.requireSession(environmentId, input.resourceId);
    const observed = await entry.driver.observe();
    if (observed.state === "closed" && entry.record.closedAt === undefined) {
      entry.record.closedAt = new Date().toISOString();
    }
    return {
      resourceId: input.resourceId,
      state: observed.state,
      ...(observed.expirationReason !== undefined
        ? { expirationReason: observed.expirationReason }
        : {}),
      ...(observed.url !== undefined ? { url: observed.url } : {}),
      ...(observed.title !== undefined ? { title: observed.title } : {}),
      ...(observed.expiresAt !== undefined ? { expiresAt: observed.expiresAt } : {}),
      inspectedAt: new Date().toISOString(),
    };
  }

  private async closeSession(
    environmentId: string,
    request: AdapterInvocation,
  ): Promise<BrowserCloseResult> {
    const input = validateBrowserCloseInput(request.input);
    const entry = this.requireSession(environmentId, input.resourceId);
    const confirmed = await entry.driver.close();
    if (confirmed) {
      entry.record.closedAt = new Date().toISOString();
    }
    const observed = await entry.driver.observe();
    return {
      resourceId: input.resourceId,
      confirmed,
      state: observed.state,
    };
  }

  /** Enforce the declared network constraints on one target URL. */
  private enforceNetwork(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalidRequestError(`The URL ${url} does not parse.`, {
        reason: "network-url-unparsable",
      });
    }
    if (
      this.declared.networkConstraints.blockPrivateRanges &&
      isPrivateHost(parsed.hostname)
    ) {
      throw invalidRequestError(
        `The URL ${url} reaches a private range this provider blocks.`,
        { reason: "network-private-range-blocked" },
      );
    }
    const allowed = this.declared.networkConstraints.allowedOrigins;
    if (allowed.length > 0 && !allowed.includes(parsed.origin)) {
      throw invalidRequestError(
        `The origin ${parsed.origin} is not one this provider allows.`,
        { reason: "network-origin-not-allowed" },
      );
    }
  }
}

/** Lease over one browser environment (SPEC.md section 8). */
export class BrowserLease implements EnvironmentLease {
  constructor(
    private readonly provider: BrowserAdapter,
    readonly environmentId: string,
  ) {}

  /** When the acquisition record says the lease ends. */
  get expiresAt(): string {
    return this.provider.expiryOf(this.environmentId);
  }

  async manifest(): Promise<EnvironmentManifest> {
    return this.provider.manifestOf(this.environmentId);
  }

  async invoke(request: AdapterInvocation): Promise<AdapterOperation> {
    return this.provider.invokeOnLease(this.environmentId, request);
  }

  async inspect(operationId: string): Promise<AdapterOperationStatus> {
    const status = this.provider.operationOf(operationId);
    if (status === null) {
      throw invalidRequestError(
        `Operation ${operationId} is not known to this environment.`,
        { operationId },
      );
    }
    return status;
  }

  async cancel(operationId: string): Promise<CancellationResult> {
    void operationId;
    // The descriptor declares cancellation unsupported; browser
    // operations complete or fail whole, never between.
    return {
      outcome: "unsupported",
      stopped: false,
      detail: "Browser operations accept no cancellation between limits.",
    };
  }

  async bind(resource: ResourceRef, context: AuthorizedContext): Promise<BindingResult> {
    return this.provider.reattach(this.environmentId, resource, context);
  }

  async renew(expiresAt: string): Promise<LeaseStatus> {
    this.provider.extendLease(this.environmentId, expiresAt);
    return { status: "active", expiresAt, renewalSupported: true };
  }

  async release(): Promise<ReleaseResult> {
    // Exactly the sessions of this environment resolve here. External
    // sessions survive for a later binding; every other persistence
    // closes. A session of another environment is never touched
    // (SPEC.md section 14.4).
    await this.provider.releaseEnvironment(this.environmentId, new Date().toISOString());
    return { status: "released", retryable: false };
  }
}

// -- Helpers -----------------------------------------------------------------------

/** Build one capture: digest always, inline bytes under the cap. */
function imageCapture(
  bytes: Uint8Array,
  truncated: boolean,
  inlineCap: number,
): BrowserImageCapture {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    ...(bytes.byteLength <= inlineCap
      ? { dataBase64: Buffer.from(bytes).toString("base64") }
      : {}),
    digest,
    byteLength: bytes.byteLength,
    truncated,
  };
}

/** Whether one host name is loopback, private, or link-local. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad === null) {
    return false;
  }
  const [a, b] = [Number(quad[1]), Number(quad[2])];
  if (a === 127 || a === 10 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return a === 192 && b === 168;
}

/** Validate one call and convert schema failures to InvalidRequest. */
function checkValid(run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
}
