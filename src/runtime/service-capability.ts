import { invalidRequestError, invalidRequestFromValidation } from "../core/errors.js";
import { DEFS } from "../schema/defs.js";
import type { CapabilityDescriptor } from "../schema/capability.js";
import type { ResourceRef } from "../schema/resource.js";
import { ValidationError, assertValid } from "../schema/validate.js";

/**
 * The `service.port@1` capability contract (SPEC.md section 14.6).
 *
 * Three operations — `expose`, `connect`, and `close` — carry
 * validated requests and results. This module is the contract, not
 * the connector: authorized service connections (SPEC.md section 10)
 * implement it against the exposure's provider endpoint.
 *
 * A service is dependent state. Its reference identifies the compute
 * generation that exposes it — the resource owner — and replacing or
 * releasing that generation invalidates the service and every
 * connection made to it. The browser session on the other end may
 * stay alive; reconnecting it to a reconstructed server requires a
 * new service binding, never a revived one.
 */

/** Identifier of the capability this module contracts. */
export const SERVICE_CAPABILITY_ID = "service.port@1";

/** Operations version one requires (SPEC.md section 14.6). */
export const SERVICE_OPERATIONS = ["expose", "connect", "close"] as const;

/** One operation name of `service.port@1`. */
export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];

/** Resource type of one exposed service. */
export const SERVICE_RESOURCE_TYPE = "service.port";

/** Resource type of one authorized connection. */
export const CONNECTION_RESOURCE_TYPE = "service.connection";

/** Who may connect to one exposed service. */
export interface ServiceAudience {
  kind: "session" | "attachment" | "public";
  /** The one attachment allowed, when the kind is `attachment`. */
  attachmentId?: string;
}

/** How one exposure ends. */
export interface ServiceExpiration {
  mode: "duration" | "absolute";
  /** Milliseconds from the exposure, in `duration` mode. */
  durationMs?: number;
  /** Fixed end time, in `absolute` mode. */
  expiresAt?: string;
}

/** Explicit authorization for public exposure (SPEC.md section 14.6). */
export interface PublicExposureAuthorization {
  /** Only `true` authorizes; there is no default. */
  publicExposure: true;
  /** The principal or policy reference that granted it. */
  grantedBy: string;
}

/** Input of the `expose` operation. */
export interface ServiceExposeInput {
  /** The process resource that serves the port. */
  processResourceId: string;
  /** TCP port the process listens on. */
  port: number;
  /** Application protocol the port speaks. */
  protocol: string;
  /** Who may connect. */
  audience: ServiceAudience;
  /** When the exposure ends. */
  expiration: ServiceExpiration;
  /** Required exactly when the audience is public and unauthenticated. */
  authorization?: PublicExposureAuthorization;
}

/** The endpoint one exposure or connection reaches. */
export interface ServiceEndpoint {
  /** Host the provider resolves the service at. */
  host: string;
  /** Port the provider maps the service to. */
  port: number;
  /** Application protocol, as exposed. */
  protocol: string;
}

/** Input of the `connect` operation. */
export interface ServiceConnectInput {
  /** The exposed service resource to reach. */
  serviceId: string;
  /** The attachment that consumes the service, such as a browser owner. */
  consumer: {
    attachmentId: string;
    generation: number;
  };
}

/** Input of the `close` operation. */
export interface ServiceCloseInput {
  /** The service or connection resource to close. */
  resourceId: string;
  /** What the resource is, when the caller wants to state it. */
  kind?: "service" | "connection";
}

/** Result of the `expose` operation. */
export interface ServiceExposeResult {
  /** The service resource this expose established. */
  resource: ResourceRef;
  endpoint: ServiceEndpoint;
  audience: ServiceAudience;
  /** The compute generation that serves this exposure. */
  compute: { attachmentId: string; generation: number };
  /** Resolved end time of the exposure. */
  expiresAt: string;
  exposedAt: string;
}

/** Result of the `connect` operation. */
export interface ServiceConnectResult {
  /** The connection resource this connect established. */
  connection: ResourceRef;
  /** The service this connection reaches. */
  serviceId: string;
  endpoint: ServiceEndpoint;
  connectedAt: string;
}

/** Result of the `close` operation. */
export interface ServiceCloseResult {
  resourceId: string;
  /** What closed: the service itself or one connection. */
  kind: "service" | "connection";
  /** `true` only when the provider confirmed the close. */
  confirmed: boolean;
  /** Connections closed with a service close. */
  connectionsClosed: number;
}

/**
 * Declared attributes of a service provider (SPEC.md section 14.6).
 *
 * An environment that offers `service.port@1` advertises these in its
 * capability attributes; matching fails when a requirement names a
 * protocol or an exposure mode the provider does not declare.
 */
export interface ServiceAttributeDeclarations {
  /** Application protocols the provider can expose. */
  protocols: string[];
  /** Whether exposures can carry transport encryption. */
  supportsTls: boolean;
  /** Exposure ceiling per attachment generation. */
  maxExposuresPerAttachment: number;
  /** Whether unauthenticated public exposure is possible at all. */
  publicExposure: "supported" | "denied";
}

/** Attribute keys every `service.port@1` provider must declare. */
export const SERVICE_ATTRIBUTE_KEYS = [
  "protocols",
  "supportsTls",
  "maxExposuresPerAttachment",
  "publicExposure",
] as const;

const PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]*$/;

/**
 * Read one provider's declared service attributes.
 *
 * Returns the parsed declarations, or null when an attribute is
 * missing or malformed: an incomplete declaration fails matching
 * rather than narrowing silently.
 */
export function checkServiceAttributes(
  attributes: Record<string, unknown>,
): ServiceAttributeDeclarations | null {
  const { protocols, supportsTls, maxExposuresPerAttachment, publicExposure } =
    attributes as Partial<ServiceAttributeDeclarations>;
  if (
    !Array.isArray(protocols) ||
    protocols.length === 0 ||
    !protocols.every((protocol) => typeof protocol === "string" && PROTOCOL_PATTERN.test(protocol))
  ) {
    return null;
  }
  if (typeof supportsTls !== "boolean") {
    return null;
  }
  if (
    typeof maxExposuresPerAttachment !== "number" ||
    !Number.isSafeInteger(maxExposuresPerAttachment) ||
    maxExposuresPerAttachment < 1
  ) {
    return null;
  }
  if (publicExposure !== "supported" && publicExposure !== "denied") {
    return null;
  }
  return { protocols, supportsTls, maxExposuresPerAttachment, publicExposure };
}

// -- Schemas --------------------------------------------------------------------

const resourceIdProperty = { $ref: "#/$defs/identifier" };
const portProperty = { type: "integer", minimum: 1, maximum: 65535 };
const protocolProperty = { type: "string", pattern: "^[a-z][a-z0-9+.-]*$", maxLength: 32 };
const audienceSchema = {
  type: "object",
  required: ["kind"],
  additionalProperties: false,
  properties: {
    kind: { enum: ["session", "attachment", "public"] },
    attachmentId: { $ref: "#/$defs/identifier" },
  },
};
const expirationSchema = {
  type: "object",
  required: ["mode"],
  additionalProperties: false,
  properties: {
    mode: { enum: ["duration", "absolute"] },
    durationMs: { type: "integer", minimum: 1, maximum: 2147483647 },
    expiresAt: { $ref: "#/$defs/timestamp" },
  },
};
const authorizationSchema = {
  type: "object",
  required: ["publicExposure", "grantedBy"],
  additionalProperties: false,
  properties: {
    publicExposure: { const: true },
    grantedBy: { type: "string", minLength: 1, maxLength: 256 },
  },
};
const endpointSchema = {
  type: "object",
  required: ["host", "port", "protocol"],
  additionalProperties: false,
  properties: {
    host: { type: "string", minLength: 1, maxLength: 255 },
    port: portProperty,
    protocol: protocolProperty,
  },
};
const computeSchema = {
  type: "object",
  required: ["attachmentId", "generation"],
  additionalProperties: false,
  properties: {
    attachmentId: { $ref: "#/$defs/identifier" },
    generation: { $ref: "#/$defs/generation" },
  },
};

/** Schema of the `expose` input. */
export const serviceExposeInputSchema = {
  $id: "https://portable.dev/schema/service/expose-input.json",
  $defs: DEFS,
  type: "object",
  required: ["processResourceId", "port", "protocol", "audience", "expiration"],
  additionalProperties: false,
  properties: {
    processResourceId: resourceIdProperty,
    port: portProperty,
    protocol: protocolProperty,
    audience: audienceSchema,
    expiration: expirationSchema,
    authorization: authorizationSchema,
  },
} as const;

/** Schema of the `connect` input. */
export const serviceConnectInputSchema = {
  $id: "https://portable.dev/schema/service/connect-input.json",
  $defs: DEFS,
  type: "object",
  required: ["serviceId", "consumer"],
  additionalProperties: false,
  properties: {
    serviceId: resourceIdProperty,
    consumer: computeSchema,
  },
} as const;

/** Schema of the `close` input. */
export const serviceCloseInputSchema = {
  $id: "https://portable.dev/schema/service/close-input.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    kind: { enum: ["service", "connection"] },
  },
} as const;

const serviceResourceSchema = {
  type: "object",
  required: ["id", "sessionId", "type", "owner", "lifetime", "recovery"],
  properties: {
    id: { $ref: "#/$defs/identifier" },
    sessionId: { $ref: "#/$defs/identifier" },
    type: { enum: [SERVICE_RESOURCE_TYPE, CONNECTION_RESOURCE_TYPE] },
    owner: {
      type: "object",
      required: ["sessionId", "attachmentId", "generation"],
      properties: {
        sessionId: { $ref: "#/$defs/identifier" },
        attachmentId: { $ref: "#/$defs/identifier" },
        generation: { $ref: "#/$defs/generation" },
      },
    },
    lifetime: { enum: ["operation", "attachment", "external"] },
    recovery: { enum: ["none", "reconstruct", "reattach", "native"] },
    expiresAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
};

/** Schema of the `expose` result. */
export const serviceExposeResultSchema = {
  $id: "https://portable.dev/schema/service/expose-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resource", "endpoint", "audience", "compute", "expiresAt", "exposedAt"],
  additionalProperties: false,
  properties: {
    resource: serviceResourceSchema,
    endpoint: endpointSchema,
    audience: audienceSchema,
    compute: computeSchema,
    expiresAt: { $ref: "#/$defs/timestamp" },
    exposedAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Schema of the `connect` result. */
export const serviceConnectResultSchema = {
  $id: "https://portable.dev/schema/service/connect-result.json",
  $defs: DEFS,
  type: "object",
  required: ["connection", "serviceId", "endpoint", "connectedAt"],
  additionalProperties: false,
  properties: {
    connection: serviceResourceSchema,
    serviceId: resourceIdProperty,
    endpoint: endpointSchema,
    connectedAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Schema of the `close` result. */
export const serviceCloseResultSchema = {
  $id: "https://portable.dev/schema/service/close-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId", "kind", "confirmed", "connectionsClosed"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    kind: { enum: ["service", "connection"] },
    confirmed: { type: "boolean" },
    connectionsClosed: { type: "integer", minimum: 0, maximum: 2147483647 },
  },
} as const;

// -- Validation -------------------------------------------------------------------

/** Validate one `expose` input and enforce the authorization rule. */
export function validateServiceExposeInput(input: unknown): ServiceExposeInput {
  const valid = checked(serviceExposeInputSchema, input) as ServiceExposeInput;
  if (valid.audience.kind === "attachment" && valid.audience.attachmentId === undefined) {
    throw invalidRequestError(
      "An attachment audience must name the one attachment that may connect.",
      { reason: "audience-attachment-unspecified" },
    );
  }
  if (valid.audience.kind !== "attachment" && valid.audience.attachmentId !== undefined) {
    throw invalidRequestError(
      "Only an attachment audience names an attachment.",
      { reason: "audience-attachment-misplaced" },
    );
  }
  if (valid.expiration.mode === "duration" && valid.expiration.durationMs === undefined) {
    throw invalidRequestError(
      "A duration expiration must carry its duration.",
      { reason: "expiration-duration-missing" },
    );
  }
  if (valid.expiration.mode === "absolute" && valid.expiration.expiresAt === undefined) {
    throw invalidRequestError(
      "An absolute expiration must carry its end time.",
      { reason: "expiration-absolute-missing" },
    );
  }
  // Public unauthenticated exposure requires explicit authorization;
  // there is no default grant (SPEC.md section 14.6).
  if (valid.audience.kind === "public" && valid.authorization === undefined) {
    throw invalidRequestError(
      "Public unauthenticated exposure requires explicit authorization.",
      { reason: "public-exposure-unauthorized" },
    );
  }
  return valid;
}

/** Validate one `connect` input. */
export function validateServiceConnectInput(input: unknown): ServiceConnectInput {
  return checked(serviceConnectInputSchema, input) as ServiceConnectInput;
}

/** Validate one `close` input. */
export function validateServiceCloseInput(input: unknown): ServiceCloseInput {
  return checked(serviceCloseInputSchema, input) as ServiceCloseInput;
}

/** Any validated `service.port@1` input. */
export type ServiceInput =
  | ServiceExposeInput
  | ServiceConnectInput
  | ServiceCloseInput;

/** Validate the input of one named operation. */
export function validateServiceInput(operation: ServiceOperation, input: unknown): ServiceInput {
  switch (operation) {
    case "expose":
      return validateServiceExposeInput(input);
    case "connect":
      return validateServiceConnectInput(input);
    case "close":
      return validateServiceCloseInput(input);
  }
}

function checked(schema: object, input: unknown): unknown {
  try {
    assertValid(schema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  return input;
}

// -- Field semantics -----------------------------------------------------------

/**
 * The validity rule of service bindings (SPEC.md sections 10, 14.6).
 *
 * A service is pinned to the compute generation that exposes it. The
 * service stays valid exactly while that attachment still stands
 * active at that generation; replacing or releasing the generation
 * invalidates the service and its connections. This is the dependent
 * counterpart of the browser's independent rule.
 */
export function serviceStillValid(
  service: { attachmentId: string; generation: number },
  compute: { attachmentId: string; generation: number; status: string },
): boolean {
  return (
    service.attachmentId === compute.attachmentId &&
    service.generation === compute.generation &&
    compute.status === "active"
  );
}

/** The current state of one attachment generation, for validity checks. */
export interface AttachmentGenerationState {
  attachmentId: string;
  generation: number;
  status: string;
}

/**
 * The validity rule of service connections (SPEC.md section 14.6).
 *
 * A connection dies with either end: the service's compute
 * generation must still stand, and the consumer attachment must
 * still stand at the generation that connected. The browser session
 * itself may outlive both — reconnecting it needs a new binding.
 */
export function connectionStillValid(liveness: {
  service: { attachmentId: string; generation: number };
  consumer: { attachmentId: string; generation: number };
  compute: AttachmentGenerationState;
  consumerAttachment: AttachmentGenerationState;
}): boolean {
  return (
    serviceStillValid(liveness.service, liveness.compute) &&
    liveness.consumer.attachmentId === liveness.consumerAttachment.attachmentId &&
    liveness.consumer.generation === liveness.consumerAttachment.generation &&
    liveness.consumerAttachment.status === "active"
  );
}

/**
 * Resolve the end time of one exposure.
 *
 * A duration runs from the exposure time; an absolute time stands as
 * given. The earlier of a duration end and an absolute clamp wins,
 * so a caller can tighten but never extend past a declared bound.
 */
export function resolveServiceExpiry(
  expiration: ServiceExpiration,
  exposedAt: string,
  absoluteClamp?: string,
): string {
  const ends = [];
  if (expiration.mode === "duration") {
    ends.push(new Date(Date.parse(exposedAt) + (expiration.durationMs ?? 0)).toISOString());
  }
  if (expiration.expiresAt !== undefined) {
    ends.push(expiration.expiresAt);
  }
  if (absoluteClamp !== undefined) {
    ends.push(absoluteClamp);
  }
  return ends.reduce((earliest, candidate) =>
    Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest,
  );
}

// -- Reference descriptor --------------------------------------------------------

/**
 * The reference descriptor of `service.port@1`.
 *
 * The operation table states the shape of every input and output;
 * the attributes declare the protocols, transport encryption, the
 * exposure ceiling, and whether public exposure is possible at all.
 * A concrete adapter overrides the attributes with its own truth; an
 * incomplete declaration fails `checkServiceAttributes` and
 * therefore matching.
 */
export function serviceCapabilityDescriptor(
  attributes: ServiceAttributeDeclarations = {
    protocols: ["http", "https", "tcp", "ws"],
    supportsTls: true,
    maxExposuresPerAttachment: 8,
    publicExposure: "denied",
  },
): CapabilityDescriptor {
  return {
    id: SERVICE_CAPABILITY_ID,
    operations: {
      expose: {
        inputSchema: serviceExposeInputSchema,
        outputSchema: serviceExposeResultSchema,
        stateful: true,
        effects: "external",
        retry: "unsafe",
        cancellation: "unsupported",
        streaming: false,
        createsResource: SERVICE_RESOURCE_TYPE,
      },
      connect: {
        inputSchema: serviceConnectInputSchema,
        outputSchema: serviceConnectResultSchema,
        stateful: true,
        effects: "external",
        retry: "deduplicated",
        cancellation: "unsupported",
        streaming: false,
        createsResource: CONNECTION_RESOURCE_TYPE,
      },
      close: {
        inputSchema: serviceCloseInputSchema,
        outputSchema: serviceCloseResultSchema,
        stateful: true,
        effects: "external",
        retry: "deduplicated",
        cancellation: "unsupported",
        streaming: false,
      },
    },
    attributes: {
      protocols: attributes.protocols,
      supportsTls: attributes.supportsTls,
      maxExposuresPerAttachment: attributes.maxExposuresPerAttachment,
      publicExposure: attributes.publicExposure,
    },
  };
}
