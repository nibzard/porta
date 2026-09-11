import { randomUUID } from "node:crypto";
import {
  invalidRequestError,
  policyDeniedError,
  staleHandleError,
} from "../core/errors.js";
import type { PolicyAuthority } from "../core/policy.js";
import { StoreError } from "../store/control-store.js";
import type { ControlStore, ResourceBindingRecord } from "../store/control-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import type { EventRedactor } from "../store/event-stream.js";
import type { ResourceDescription, ResourceRef } from "../schema/resource.js";
import type { AttachmentSummary } from "../schema/session.js";
import { requireOpenSession } from "./workspace.js";
import { PROCESS_CAPABILITY_ID } from "./process-capability.js";
import {
  CONNECTION_RESOURCE_TYPE,
  SERVICE_CAPABILITY_ID,
  SERVICE_RESOURCE_TYPE,
  connectionStillValid,
  resolveServiceExpiry,
  serviceStillValid,
  validateServiceCloseInput,
  validateServiceConnectInput,
  validateServiceExposeInput,
} from "./service-capability.js";
import type {
  ServiceAudience,
  ServiceCloseInput,
  ServiceConnectInput,
  ServiceEndpoint,
  ServiceExposeInput,
} from "./service-capability.js";

/**
 * Authorized service exposure and connections (SPEC.md sections 10
 * and 14.6).
 *
 * An exposed application port is dependent state: its binding names
 * the compute generation that serves it, and replacing or releasing
 * that generation invalidates the service. A connection is dependent
 * twice over — it dies with the serving generation or with the
 * consumer generation that made it — while the browser session that
 * owns the connection keeps its own attachment and stays valid.
 * Reconnecting a live browser to a reconstructed server requires a
 * new connection, never a revived one.
 *
 * Exposure and consumer policy are checked independently: `expose`
 * checks the exposure audience against the policy's authorized
 * service audiences, and `connect` checks the consumer's operation
 * grant and network egress against the endpoint it reaches. Neither
 * check can stand in for the other.
 */

/** Endpoint host of every session-internal exposure, version one. */
export const SESSION_SERVICE_HOST = "session.local";

/** Extension key: host of the exposed endpoint. */
export const SERVICE_HOST_EXTENSION = "portable.service.host";

/** Extension key: port of the exposed endpoint. */
export const SERVICE_PORT_EXTENSION = "portable.service.port";

/** Extension key: protocol of the exposed endpoint. */
export const SERVICE_PROTOCOL_EXTENSION = "portable.service.protocol";

/** Extension key: audience kind the exposure allows. */
export const SERVICE_AUDIENCE_KIND_EXTENSION = "portable.service.audience-kind";

/** Extension key: the one attachment an attachment audience allows. */
export const SERVICE_AUDIENCE_ATTACHMENT_EXTENSION =
  "portable.service.audience-attachment";

/** Extension key: the compute attachment that serves the exposure. */
export const SERVICE_COMPUTE_ATTACHMENT_EXTENSION =
  "portable.service.compute-attachment";

/** Extension key: the compute generation that serves the exposure. */
export const SERVICE_COMPUTE_GENERATION_EXTENSION =
  "portable.service.compute-generation";

/** Extension key, on connections: the service they depend on. */
export const SERVICE_ID_EXTENSION = "portable.service.service-id";

/** Options shared by every service flow. */
export interface ServiceFlowOptions {
  /** The policy authority in force for the call. */
  authority: PolicyAuthority;
  /** Redactor applied to journal event data. */
  redactor?: EventRedactor;
}

/** One exposed service, as `expose` established it. */
export interface ExposedService {
  /** The service resource this exposure established. */
  service: ResourceDescription;
  endpoint: ServiceEndpoint;
  audience: ServiceAudience;
  /** The compute generation that serves this exposure. */
  compute: { attachmentId: string; generation: number };
  /** Resolved end time of the exposure. */
  expiresAt: string;
  exposedAt: string;
}

/** One authorized connection, as `connect` established it. */
export interface ConnectedService {
  /** The connection resource this connect established. */
  connection: ResourceDescription;
  /** The service this connection reaches. */
  serviceId: string;
  endpoint: ServiceEndpoint;
  connectedAt: string;
}

/** One closed service or connection. */
export interface ClosedService {
  resourceId: string;
  /** What closed: the service itself or one connection. */
  kind: "service" | "connection";
  /** `true` only when a live binding actually closed. */
  confirmed: boolean;
  /** Connections closed with a service close. */
  connectionsClosed: number;
}

/** The audience key a policy authorizes: `session`, `public`, or one named attachment. */
export function serviceAudienceKey(audience: ServiceAudience): string {
  if (audience.kind === "attachment") {
    return `attachment:${audience.attachmentId ?? ""}`;
  }
  return audience.kind;
}

/**
 * Expose one application port as a service resource (SPEC.md 14.6).
 *
 * The exposure identifies the process resource that serves the port,
 * resolves the serving compute generation from that process's owner,
 * checks the audience against the policy's authorized service
 * audiences, and records the endpoint and audience as binding
 * extensions. Public unauthenticated exposure needs both an explicit
 * input grant and `public` in the policy's audience list.
 */
export function exposeService(
  store: ControlStore,
  sessionId: string,
  input: ServiceExposeInput,
  options: ServiceFlowOptions,
): ExposedService {
  const valid = validateServiceExposeInput(input);
  try {
    return store.transaction(() => {
      requireOpenSession(store, sessionId);

      // The process names the compute that serves the port.
      const process = requireProcessBinding(store, sessionId, valid.processResourceId);
      const compute = requireActiveOwner(store, sessionId, process);

      // Exposure policy: the operation grant and the audience. These
      // checks are the exposure side alone; the consumer side runs at
      // connect and cannot be satisfied here (SPEC.md sections 7, 14.6).
      const deniedOperation = options.authority.checkOperation(
        SERVICE_CAPABILITY_ID,
        "expose",
      );
      if (deniedOperation !== null) {
        throw deniedOperation;
      }
      const deniedAudience = options.authority.checkServiceAudience(
        serviceAudienceKey(valid.audience),
      );
      if (deniedAudience !== null) {
        throw deniedAudience;
      }

      const exposedAt = new Date().toISOString();
      const expiresAt = resolveServiceExpiry(valid.expiration, exposedAt);
      const endpoint: ServiceEndpoint = {
        host: SESSION_SERVICE_HOST,
        port: valid.port,
        protocol: valid.protocol,
      };
      const resourceId = `res-service-${randomUUID()}`;
      const record: ResourceBindingRecord = {
        id: resourceId,
        sessionId,
        type: SERVICE_RESOURCE_TYPE,
        capability: SERVICE_CAPABILITY_ID,
        owner: {
          sessionId,
          attachmentId: compute.attachmentId,
          generation: compute.generation,
        },
        // An application server is reconstructable state: it crosses a
        // handoff by reconstruction, never by revival (SPEC.md 12).
        lifetime: "attachment",
        recovery: "reconstruct",
        status: "bound",
        expiresAt,
        extensions: {
          [SERVICE_HOST_EXTENSION]: endpoint.host,
          [SERVICE_PORT_EXTENSION]: endpoint.port,
          [SERVICE_PROTOCOL_EXTENSION]: endpoint.protocol,
          [SERVICE_AUDIENCE_KIND_EXTENSION]: valid.audience.kind,
          ...(valid.audience.attachmentId !== undefined
            ? { [SERVICE_AUDIENCE_ATTACHMENT_EXTENSION]: valid.audience.attachmentId }
            : {}),
          [SERVICE_COMPUTE_ATTACHMENT_EXTENSION]: compute.attachmentId,
          [SERVICE_COMPUTE_GENERATION_EXTENSION]: compute.generation,
        },
        boundAt: exposedAt,
      };
      store.insertResourceBinding(record);
      const stream = new SessionEventStream(store, sessionId, options.redactor);
      stream.append("resource.bound", record.id, {
        resourceId: record.id,
        type: record.type,
        ownerAttachmentId: record.owner.attachmentId,
        ownerGeneration: record.owner.generation,
        lifetime: record.lifetime,
        recovery: record.recovery,
      });
      return {
        service: describeBinding(record, "valid"),
        endpoint,
        audience: valid.audience,
        compute: { attachmentId: compute.attachmentId, generation: compute.generation },
        expiresAt,
        exposedAt,
      };
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/**
 * Connect one consumer attachment to an exposed service
 * (SPEC.md section 14.6).
 *
 * The exposure side and the consumer side are checked independently:
 * the service must still stand on its serving compute generation
 * under its audience, and the consumer attachment must stand at the
 * generation it claims with a policy that grants `connect` and allows
 * egress to the endpoint host. Neither check can stand in for the
 * other.
 */
export function connectService(
  store: ControlStore,
  sessionId: string,
  input: ServiceConnectInput,
  options: ServiceFlowOptions,
): ConnectedService {
  const valid = validateServiceConnectInput(input);
  try {
    return store.transaction(() => {
      requireOpenSession(store, sessionId);

      // -- Exposure side -----------------------------------------------------
      const service = requireServiceBinding(store, sessionId, valid.serviceId);
      checkServiceStanding(store, sessionId, service);

      // The audience decides which attachments may connect at all.
      const audienceKind = service.extensions?.[SERVICE_AUDIENCE_KIND_EXTENSION];
      if (audienceKind === "attachment") {
        const allowed = service.extensions?.[SERVICE_AUDIENCE_ATTACHMENT_EXTENSION];
        if (allowed !== valid.consumer.attachmentId) {
          throw policyDeniedError(
            "Only the attachment this service names may connect to it.",
            {
              reason: "audience-attachment-mismatch",
              allowedAttachmentId: allowed,
              consumerAttachmentId: valid.consumer.attachmentId,
            },
          );
        }
      }

      // -- Consumer side -------------------------------------------------------
      const consumer = requireAttachment(store, sessionId, valid.consumer.attachmentId);
      if (consumer.generation !== valid.consumer.generation) {
        throw staleHandleError(
          { kind: "attachment-generation", value: valid.consumer.generation },
          { kind: "attachment-generation", value: consumer.generation },
        );
      }
      if (consumer.status !== "active") {
        throw invalidRequestError(
          `Attachment ${consumer.attachmentId} is ${consumer.status}; it accepts no new connections.`,
          { attachmentId: consumer.attachmentId, status: consumer.status },
        );
      }
      const deniedOperation = options.authority.checkOperation(
        SERVICE_CAPABILITY_ID,
        "connect",
      );
      if (deniedOperation !== null) {
        throw deniedOperation;
      }
      const endpoint = endpointOf(service);
      const deniedEgress = options.authority.checkEgressTarget(endpoint.host);
      if (deniedEgress !== null) {
        throw deniedEgress;
      }

      const connectedAt = new Date().toISOString();
      const resourceId = `res-connection-${randomUUID()}`;
      const record: ResourceBindingRecord = {
        id: resourceId,
        sessionId,
        type: CONNECTION_RESOURCE_TYPE,
        capability: SERVICE_CAPABILITY_ID,
        owner: {
          sessionId,
          attachmentId: consumer.attachmentId,
          generation: consumer.generation,
        },
        // A connection dies with either end and is recreated
        // explicitly; no handoff revives it (SPEC.md sections 10, 12).
        lifetime: "attachment",
        recovery: "none",
        status: "bound",
        // A connection cannot outlive the service it reaches.
        expiresAt: service.expiresAt,
        extensions: {
          [SERVICE_ID_EXTENSION]: service.id,
          [SERVICE_COMPUTE_ATTACHMENT_EXTENSION]:
            service.extensions?.[SERVICE_COMPUTE_ATTACHMENT_EXTENSION],
          [SERVICE_COMPUTE_GENERATION_EXTENSION]:
            service.extensions?.[SERVICE_COMPUTE_GENERATION_EXTENSION],
        },
        boundAt: connectedAt,
      };
      store.insertResourceBinding(record);
      const stream = new SessionEventStream(store, sessionId, options.redactor);
      stream.append("resource.bound", record.id, {
        resourceId: record.id,
        type: record.type,
        ownerAttachmentId: record.owner.attachmentId,
        ownerGeneration: record.owner.generation,
        lifetime: record.lifetime,
        recovery: record.recovery,
        serviceId: service.id,
      });
      return {
        connection: describeBinding(record, "valid"),
        serviceId: service.id,
        endpoint,
        connectedAt,
      };
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/**
 * Close one service or one connection (SPEC.md section 14.6).
 *
 * Closing a service closes every connection that depends on it.
 * Closing is explicit and final: a closed binding never becomes
 * valid again, and reconnecting means a new connect.
 */
export function closeService(
  store: ControlStore,
  sessionId: string,
  input: ServiceCloseInput,
  options: ServiceFlowOptions,
): ClosedService {
  const valid = validateServiceCloseInput(input);
  try {
    return store.transaction(() => {
      requireOpenSession(store, sessionId);
      const deniedOperation = options.authority.checkOperation(
        SERVICE_CAPABILITY_ID,
        "close",
      );
      if (deniedOperation !== null) {
        throw deniedOperation;
      }
      const binding = store.getResourceBinding(sessionId, valid.resourceId);
      if (binding === null) {
        throw invalidRequestError(
          `Resource ${valid.resourceId} does not exist in this session.`,
          { sessionId, resourceId: valid.resourceId, reason: "resource-unknown" },
        );
      }
      const kind: "service" | "connection" | null =
        valid.kind ??
        (binding.type === CONNECTION_RESOURCE_TYPE
          ? "connection"
          : binding.type === SERVICE_RESOURCE_TYPE
            ? "service"
            : null);
      if (kind === null) {
        throw invalidRequestError(
          `Resource ${valid.resourceId} is neither a service nor a connection; name its kind.`,
          { resourceId: valid.resourceId, type: binding.type, reason: "kind-unknown" },
        );
      }

      const stream = new SessionEventStream(store, sessionId, options.redactor);
      const now = new Date().toISOString();
      const closed =
        store.markResourceBindingInvalidated(binding.id, "service-closed", now) !== null;
      if (closed) {
        stream.append("resource.invalidated", binding.id, {
          resourceId: binding.id,
          reason: "service-closed",
          ownerGeneration: binding.owner.generation,
          attachmentId: binding.owner.attachmentId,
        });
      }
      let connectionsClosed = 0;
      if (kind === "service") {
        for (const dependent of connectionsOf(store, sessionId, binding.id)) {
          const updated = store.markResourceBindingInvalidated(
            dependent.id,
            "service-closed",
            now,
          );
          if (updated !== null) {
            connectionsClosed += 1;
            stream.append("resource.invalidated", updated.id, {
              resourceId: updated.id,
              reason: "service-closed",
              ownerGeneration: updated.owner.generation,
              attachmentId: updated.owner.attachmentId,
            });
          }
        }
      }
      return {
        resourceId: binding.id,
        kind,
        confirmed: closed,
        connectionsClosed,
      };
    });
  } catch (error) {
    if (error instanceof StoreError) {
      throw error.toPortableError();
    }
    throw error;
  }
}

/**
 * Invalidate every connection that depends on one compute generation
 * (SPEC.md sections 10 and 14.6).
 *
 * Replacement and release of a serving generation call this sweep
 * after they end the generation's own bindings. The sweep touches
 * only connections: the browser sessions that own them keep their
 * own attachments and stay valid, and reconnecting to a reconstructed
 * server means a new connect, never a revived connection.
 */
export function invalidateServiceDependencies(
  store: ControlStore,
  sessionId: string,
  compute: { attachmentId: string; generation: number },
  reason: string,
  options?: Pick<ServiceFlowOptions, "redactor">,
): ResourceDescription[] {
  const stream =
    options === undefined
      ? new SessionEventStream(store, sessionId)
      : new SessionEventStream(store, sessionId, options.redactor);
  const swept: ResourceDescription[] = [];
  for (const binding of connectionsOfCompute(store, sessionId, compute)) {
    const updated = store.markResourceBindingInvalidated(binding.id, reason, new Date().toISOString());
    if (updated === null) {
      continue;
    }
    stream.append("resource.invalidated", updated.id, {
      resourceId: updated.id,
      reason,
      ownerGeneration: updated.owner.generation,
      attachmentId: updated.owner.attachmentId,
    });
    swept.push(describeBinding(updated, "released", { detail: reason }));
  }
  return swept;
}

/**
 * The validity rule of one connection against current state.
 *
 * Reports both ends: the serving generation and the consumer
 * generation must each still stand. Callers use this to decide
 * whether a connection is worth keeping before they act on it.
 */
export function checkConnectionStanding(
  store: ControlStore,
  sessionId: string,
  connection: ResourceBindingRecord,
): { valid: boolean; detail: string } {
  const serviceId = connection.extensions?.[SERVICE_ID_EXTENSION];
  if (typeof serviceId !== "string") {
    return { valid: false, detail: "The connection names no service." };
  }
  const service = store.getResourceBinding(sessionId, serviceId);
  if (service === null) {
    return { valid: false, detail: `The service ${serviceId} no longer exists.` };
  }
  const compute = computeOf(service);
  const computeAttachment = store.getAttachment(compute.attachmentId);
  if (computeAttachment === null || computeAttachment.sessionId !== sessionId) {
    return { valid: false, detail: `The serving attachment ${compute.attachmentId} is gone.` };
  }
  const consumerAttachment = store.getAttachment(connection.owner.attachmentId);
  if (consumerAttachment === null || consumerAttachment.sessionId !== sessionId) {
    return {
      valid: false,
      detail: `The consumer attachment ${connection.owner.attachmentId} is gone.`,
    };
  }
  const standing = connectionStillValid({
    service: compute,
    consumer: {
      attachmentId: connection.owner.attachmentId,
      generation: connection.owner.generation,
    },
    compute: {
      attachmentId: computeAttachment.attachmentId,
      generation: computeAttachment.generation,
      status: computeAttachment.status,
    },
    consumerAttachment: {
      attachmentId: consumerAttachment.attachmentId,
      generation: consumerAttachment.generation,
      status: consumerAttachment.status,
    },
  });
  return {
    valid: standing,
    detail: standing
      ? "Both the serving generation and the consumer generation stand."
      : "The serving generation or the consumer generation moved on.",
  };
}

// -- Guards and helpers -----------------------------------------------------------

/** The process binding an exposure names, or a refusal. */
function requireProcessBinding(
  store: ControlStore,
  sessionId: string,
  resourceId: string,
): ResourceBindingRecord {
  const binding = store.getResourceBinding(sessionId, resourceId);
  if (binding === null) {
    throw invalidRequestError(`Process resource ${resourceId} does not exist.`, {
      sessionId,
      resourceId,
      reason: "process-unknown",
    });
  }
  if (binding.capability !== PROCESS_CAPABILITY_ID) {
    throw invalidRequestError(
      `Resource ${resourceId} is not a process of ${PROCESS_CAPABILITY_ID}.`,
      { resourceId, capability: binding.capability, reason: "process-required" },
    );
  }
  if (binding.status !== "bound") {
    throw invalidRequestError(`Process resource ${resourceId} is no longer bound.`, {
      resourceId,
      reason: "process-not-bound",
    });
  }
  return binding;
}

/** The serving attachment of one process binding, active right now. */
function requireActiveOwner(
  store: ControlStore,
  sessionId: string,
  binding: ResourceBindingRecord,
): { attachmentId: string; generation: number } {
  const owner = requireAttachment(store, sessionId, binding.owner.attachmentId);
  if (owner.generation !== binding.owner.generation) {
    // The process handle names a replaced generation; the caller
    // holds a stale handle, not a live server.
    throw staleHandleError(
      { kind: "attachment-generation", value: binding.owner.generation },
      { kind: "attachment-generation", value: owner.generation },
    );
  }
  if (owner.status !== "active") {
    throw invalidRequestError(
      `Attachment ${owner.attachmentId} is ${owner.status}; it serves no ports.`,
      { attachmentId: owner.attachmentId, status: owner.status },
    );
  }
  return { attachmentId: owner.attachmentId, generation: owner.generation };
}

/** The service binding a connect names, or a refusal. */
function requireServiceBinding(
  store: ControlStore,
  sessionId: string,
  resourceId: string,
): ResourceBindingRecord {
  const binding = store.getResourceBinding(sessionId, resourceId);
  if (binding === null) {
    throw invalidRequestError(`Service ${resourceId} does not exist.`, {
      sessionId,
      resourceId,
      reason: "service-unknown",
    });
  }
  if (binding.type !== SERVICE_RESOURCE_TYPE) {
    throw invalidRequestError(`Resource ${resourceId} is not an exposed service.`, {
      resourceId,
      type: binding.type,
      reason: "service-required",
    });
  }
  return binding;
}

/** Whether one service still stands, and why not when it does not. */
function checkServiceStanding(
  store: ControlStore,
  sessionId: string,
  service: ResourceBindingRecord,
): void {
  if (service.status !== "bound") {
    throw invalidRequestError(`Service ${service.id} is no longer bound.`, {
      resourceId: service.id,
      reason: "service-not-bound",
    });
  }
  if (
    service.expiresAt !== undefined &&
    Date.parse(service.expiresAt) <= Date.now()
  ) {
    throw invalidRequestError(`Service ${service.id} expired.`, {
      resourceId: service.id,
      expiresAt: service.expiresAt,
      reason: "service-expired",
    });
  }
  const compute = computeOf(service);
  const computeAttachment = store.getAttachment(compute.attachmentId);
  if (
    computeAttachment === null ||
    computeAttachment.sessionId !== sessionId ||
    !serviceStillValid(compute, {
      attachmentId: computeAttachment.attachmentId,
      generation: computeAttachment.generation,
      status: computeAttachment.status,
    })
  ) {
    // The serving generation moved on; the service and its
    // connections died with it (SPEC.md section 14.6).
    throw invalidRequestError(
      `The compute generation that serves ${service.id} no longer stands.`,
      {
        resourceId: service.id,
        computeAttachmentId: compute.attachmentId,
        computeGeneration: compute.generation,
        reason: "service-compute-invalidated",
      },
    );
  }
}

/** One attachment of one session, or a refusal. */
function requireAttachment(
  store: ControlStore,
  sessionId: string,
  attachmentId: string,
): AttachmentSummary {
  const attachment = store.getAttachment(attachmentId);
  if (attachment === null || attachment.sessionId !== sessionId) {
    throw invalidRequestError(`Attachment ${attachmentId} does not exist.`, {
      sessionId,
      attachmentId,
    });
  }
  return attachment;
}

/** The compute generation one service binding names. */
function computeOf(
  service: ResourceBindingRecord,
): { attachmentId: string; generation: number } {
  return {
    attachmentId: String(service.extensions?.[SERVICE_COMPUTE_ATTACHMENT_EXTENSION] ?? ""),
    generation: Number(service.extensions?.[SERVICE_COMPUTE_GENERATION_EXTENSION] ?? 0),
  };
}

/** The endpoint one service binding names. */
function endpointOf(service: ResourceBindingRecord): ServiceEndpoint {
  return {
    host: String(service.extensions?.[SERVICE_HOST_EXTENSION] ?? SESSION_SERVICE_HOST),
    port: Number(service.extensions?.[SERVICE_PORT_EXTENSION] ?? 0),
    protocol: String(service.extensions?.[SERVICE_PROTOCOL_EXTENSION] ?? "http"),
  };
}

/** Every connection that depends on one service. */
function connectionsOf(
  store: ControlStore,
  sessionId: string,
  serviceId: string,
): ResourceBindingRecord[] {
  return store
    .listResourceBindings(sessionId)
    .filter(
      (binding) =>
        binding.type === CONNECTION_RESOURCE_TYPE &&
        binding.status === "bound" &&
        binding.extensions?.[SERVICE_ID_EXTENSION] === serviceId,
    );
}

/** Every connection that depends on one compute generation. */
function connectionsOfCompute(
  store: ControlStore,
  sessionId: string,
  compute: { attachmentId: string; generation: number },
): ResourceBindingRecord[] {
  return store
    .listResourceBindings(sessionId)
    .filter(
      (binding) =>
        binding.type === CONNECTION_RESOURCE_TYPE &&
        binding.status === "bound" &&
        binding.extensions?.[SERVICE_COMPUTE_ATTACHMENT_EXTENSION] === compute.attachmentId &&
        binding.extensions?.[SERVICE_COMPUTE_GENERATION_EXTENSION] === compute.generation,
    );
}

/** The portable reference of one binding record. */
function refOf(binding: ResourceBindingRecord): ResourceRef {
  return {
    id: binding.id,
    sessionId: binding.sessionId,
    type: binding.type,
    owner: { ...binding.owner },
    lifetime: binding.lifetime,
    recovery: binding.recovery,
    ...(binding.expiresAt !== undefined ? { expiresAt: binding.expiresAt } : {}),
    ...(binding.extensions !== undefined ? { extensions: binding.extensions } : {}),
  };
}

/** One binding as a resolution answer. */
function describeBinding(
  binding: ResourceBindingRecord,
  validity: ResourceDescription["validity"],
  extra?: { detail?: string },
): ResourceDescription {
  return {
    ref: refOf(binding),
    validity,
    ...(binding.providerResourceId !== undefined
      ? { providerResourceId: binding.providerResourceId }
      : {}),
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
  };
}
