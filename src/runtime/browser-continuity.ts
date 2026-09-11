import {
  invalidRequestError,
  staleHandleError,
} from "../core/errors.js";
import type { PolicyAuthority } from "../core/policy.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore, ResourceBindingRecord } from "../store/control-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import type { ResourceDescription } from "../schema/resource.js";
import { requireOpenSession } from "./workspace.js";
import { browserSurvivesOwnerRelease } from "./browser-capability.js";
import type { BrowserState } from "./browser-capability.js";
import {
  connectService,
  exposeService,
} from "./service-connections.js";
import type { ConnectedService, ExposedService } from "./service-connections.js";
import { SERVICE_ID_EXTENSION } from "./service-connections.js";
import type {
  ServiceAudience,
  ServiceExpiration,
} from "./service-capability.js";

/**
 * Browser continuity across compute replacement (SPEC.md sections
 * 10, 13, and 14.6).
 *
 * An independently attached browser keeps its own attachment and its
 * own generation while compute is replaced. After the switch, the
 * reconstructed server exposes a new service, and the same valid
 * browser handle connects to it through a new connection. The old
 * compute, service, and connection handles stay dead; the browser
 * generation never moved.
 *
 * Preservation is a provider-reported fact, never a claim. Before the
 * flow reconnects anything, the provider's word on the browser
 * session decides: an expired or closed session refuses the
 * reconnection and marks the binding dead, and an unknown state
 * refuses without touching the binding at all. The runtime never
 * infers survival from a lease, a clock, or the absence of bad news.
 */

/** The provider's word on one browser session, as the flow needs it. */
export interface BrowserProviderObservation {
  state: BrowserState;
  /** Why the provider says the session ended, when it expired. */
  expirationReason?: string;
}

/**
 * How the flow asks the provider about one browser session.
 *
 * The embedding backs this with the browser adapter it holds; the
 * runtime never imports an adapter directly (SPEC.md section 2).
 */
export interface BrowserContinuityTransport {
  observeSession(resourceId: string): Promise<BrowserProviderObservation>;
}

/** Input of one reconnection. */
export interface ReconnectBrowserInput {
  /** The browser session resource that outlived the replacement. */
  browserResourceId: string;
  /** A bound process on the current generation of the compute attachment. */
  processResourceId: string;
  port: number;
  protocol: string;
  /** Who may connect to the new service. */
  audience: ServiceAudience;
  /** When the new exposure ends. */
  expiration: ServiceExpiration;
  /** The service the dead connection reached, when the caller knows it. */
  supersededServiceId?: string;
}

/** Options of one reconnection. */
export interface ReconnectOptions {
  /** The policy authority in force for the call. */
  authority: PolicyAuthority;
  /** How the flow asks the provider about the browser session. */
  transport: BrowserContinuityTransport;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** The report of one completed reconnection. */
export interface BrowserReconnection {
  /** The same browser binding, valid, at its unchanged generation. */
  browser: ResourceDescription;
  /** The connection that died with the replaced generation, when one did. */
  supersededConnection: ResourceDescription | null;
  /** The new service, on the replacement generation. */
  service: ExposedService;
  /** The new connection from the same browser handle. */
  connection: ConnectedService;
}

/**
 * Reconnect one surviving browser to a reconstructed server
 * (SPEC.md sections 10 and 14.6).
 *
 * The flow checks the browser binding and the provider's word on the
 * session first, exposes the new service on the process the caller
 * names, and connects the browser's attachment to it. Every step
 * refuses on its own terms; nothing is preserved by assumption.
 */
export async function reconnectBrowserService(
  store: ControlStore,
  sessionId: string,
  input: ReconnectBrowserInput,
  options: ReconnectOptions,
): Promise<BrowserReconnection> {
  requireOpenSession(store, sessionId);

  // -- The browser handle --------------------------------------------------
  const browser = requireIndependentBrowser(store, sessionId, input.browserResourceId);
  const owner = store.getAttachment(browser.owner.attachmentId);
  if (owner === null || owner.sessionId !== sessionId) {
    throw invalidRequestError(
      `The browser attachment ${browser.owner.attachmentId} no longer exists.`,
      { sessionId, attachmentId: browser.owner.attachmentId },
    );
  }
  if (owner.generation !== browser.owner.generation) {
    throw staleHandleError(
      { kind: "attachment-generation", value: browser.owner.generation },
      { kind: "attachment-generation", value: owner.generation },
    );
  }
  if (owner.status !== "active") {
    throw invalidRequestError(
      `Attachment ${owner.attachmentId} is ${owner.status}; it accepts no connections.`,
      { attachmentId: owner.attachmentId, status: owner.status },
    );
  }

  // -- The provider's word -------------------------------------------------
  const observed = await options.transport.observeSession(input.browserResourceId);
  if (observed.state === "expired" || observed.state === "closed") {
    // The session is gone by the provider's word. The binding stops
    // claiming a valid handle, and the refusal says plainly that
    // nothing was preserved — the browser died with its provider
    // session, whatever the compute replacement did (SPEC.md 14.4).
    retireBrowserBinding(store, sessionId, browser, observed);
    throw invalidRequestError(
      `The provider reports this browser session as ${observed.state}.`,
      {
        resourceId: input.browserResourceId,
        reason: `browser-session-${observed.state}`,
        preserved: false,
        ...(observed.expirationReason !== undefined
          ? { expirationReason: observed.expirationReason }
          : {}),
      },
    );
  }
  if (observed.state === "unknown") {
    // Unknown is not dead: the binding stands, the reconnection
    // refuses, and the caller learns exactly what the provider said.
    throw invalidRequestError(
      "The provider cannot report this browser session; nothing is assumed.",
      { resourceId: input.browserResourceId, reason: "browser-session-unknown" },
    );
  }

  // -- The superseded connection --------------------------------------------
  const supersededConnection =
    input.supersededServiceId === undefined
      ? null
      : deadConnectionOf(store, sessionId, browser, input.supersededServiceId);

  // -- The new service and the new connection --------------------------------
  const service = exposeService(
    store,
    sessionId,
    {
      processResourceId: input.processResourceId,
      port: input.port,
      protocol: input.protocol,
      audience: input.audience,
      expiration: input.expiration,
    },
    { authority: options.authority, ...(options.redactor !== undefined ? { redactor: options.redactor } : {}) },
  );
  const connection = connectService(
    store,
    sessionId,
    {
      serviceId: service.service.ref.id,
      consumer: { attachmentId: owner.attachmentId, generation: owner.generation },
    },
    { authority: options.authority, ...(options.redactor !== undefined ? { redactor: options.redactor } : {}) },
  );
  return {
    browser: describeBinding(browser, "valid"),
    supersededConnection,
    service,
    connection,
  };
}

// -- Guards and helpers -----------------------------------------------------------

/** The browser binding a reconnection stands on, or a refusal. */
function requireIndependentBrowser(
  store: ControlStore,
  sessionId: string,
  resourceId: string,
): ResourceBindingRecord {
  const binding = store.getResourceBinding(sessionId, resourceId);
  if (binding === null) {
    throw invalidRequestError(`Browser resource ${resourceId} does not exist.`, {
      sessionId,
      resourceId,
      reason: "browser-unknown",
    });
  }
  if (binding.status !== "bound") {
    throw invalidRequestError(`Browser resource ${resourceId} is no longer bound.`, {
      resourceId,
      reason: "browser-not-bound",
    });
  }
  // Only independent state crosses a replacement: a browser that
  // dies with its owner, or that nothing can reattach, has no
  // continuity to integrate (SPEC.md sections 10, 12).
  if (!browserSurvivesOwnerRelease(binding)) {
    throw invalidRequestError(
      `Resource ${resourceId} does not survive its owner's release; it has no continuity across replacement.`,
      { resourceId, lifetime: binding.lifetime, recovery: binding.recovery, reason: "browser-not-independent" },
    );
  }
  if (
    binding.expiresAt !== undefined &&
    Date.parse(binding.expiresAt) <= Date.now()
  ) {
    // The binding's own recorded expiry passed; that is a fact of the
    // handle, reported as it stands.
    throw invalidRequestError(`Browser resource ${resourceId} expired.`, {
      resourceId,
      expiresAt: binding.expiresAt,
      reason: "browser-expired",
    });
  }
  return binding;
}

/** Mark one browser binding dead by the provider's word. */
function retireBrowserBinding(
  store: ControlStore,
  sessionId: string,
  binding: ResourceBindingRecord,
  observed: BrowserProviderObservation,
): void {
  // The invalidation reason carries the provider's word verbatim; the
  // refusal carries the full honest report, including that nothing
  // was preserved. The journal event stays lean by contract.
  const reason =
    `browser-session-${observed.state}` +
    (observed.expirationReason !== undefined
      ? `:${observed.expirationReason}`
      : "");
  try {
    store.transaction(() => {
      const updated = store.markResourceBindingInvalidated(
        binding.id,
        reason,
        new Date().toISOString(),
      );
      if (updated === null) {
        return;
      }
      const stream = new SessionEventStream(store, sessionId);
      stream.append("resource.invalidated", updated.id, {
        resourceId: updated.id,
        reason,
        ownerGeneration: updated.owner.generation,
        attachmentId: updated.owner.attachmentId,
      });
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/**
 * The dead connection one browser held to one superseded service.
 *
 * The sweep of the replaced generation normally invalidated it
 * already; this reads the record to report it, and refuses to
 * describe a connection that never existed.
 */
function deadConnectionOf(
  store: ControlStore,
  sessionId: string,
  browser: ResourceBindingRecord,
  supersededServiceId: string,
): ResourceDescription | null {
  const dead = store
    .listResourceBindings(sessionId)
    .find(
      (binding) =>
        binding.type === "service.connection" &&
        binding.owner.attachmentId === browser.owner.attachmentId &&
        binding.owner.generation === browser.owner.generation &&
        binding.extensions?.[SERVICE_ID_EXTENSION] === supersededServiceId,
    );
  if (dead === undefined) {
    return null;
  }
  return describeBinding(dead, "released", {
    detail: dead.invalidationReason ?? "The connection died with its compute generation.",
  });
}

/** The portable reference of one binding record. */
function describeBinding(
  binding: ResourceBindingRecord,
  validity: ResourceDescription["validity"],
  extra?: { detail?: string },
): ResourceDescription {
  return {
    ref: {
      id: binding.id,
      sessionId: binding.sessionId,
      type: binding.type,
      owner: { ...binding.owner },
      lifetime: binding.lifetime,
      recovery: binding.recovery,
      ...(binding.expiresAt !== undefined ? { expiresAt: binding.expiresAt } : {}),
      ...(binding.extensions !== undefined ? { extensions: binding.extensions } : {}),
    },
    validity,
    ...(binding.providerResourceId !== undefined
      ? { providerResourceId: binding.providerResourceId }
      : {}),
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
  };
}
