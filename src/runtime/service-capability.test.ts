import test from "node:test";
import assert from "node:assert/strict";
import { matchEnvironment, validateCapabilityDescriptors } from "../core/matching.js";
import type { EnvironmentOffer } from "../schema/capability.js";
import {
  CONNECTION_RESOURCE_TYPE,
  SERVICE_CAPABILITY_ID,
  SERVICE_OPERATIONS,
  SERVICE_RESOURCE_TYPE,
  checkServiceAttributes,
  connectionStillValid,
  resolveServiceExpiry,
  serviceCapabilityDescriptor,
  serviceStillValid,
  validateServiceCloseInput,
  validateServiceConnectInput,
  validateServiceExposeInput,
  validateServiceInput,
} from "./service-capability.js";
import type {
  ServiceAttributeDeclarations,
  ServiceConnectInput,
  ServiceExposeInput,
} from "./service-capability.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
function refuse(run: () => unknown): { code: string; details?: unknown } | null {
  try {
    run();
  } catch (error) {
    if (isPortableCode(error)) {
      return error;
    }
    throw error;
  }
  return null;
}

/** The reference declarations the default descriptor must carry. */
const REFERENCE: ServiceAttributeDeclarations = {
  protocols: ["http", "https", "tcp", "ws"],
  supportsTls: true,
  maxExposuresPerAttachment: 8,
  publicExposure: "denied",
};

/** The reference declarations with one field replaced. */
function declaredWith(patch: Partial<ServiceAttributeDeclarations>): Record<string, unknown> {
  return { ...REFERENCE, ...patch };
}

/** One offer whose only capability is the reference service descriptor. */
function serviceOffer(attributes?: ServiceAttributeDeclarations): EnvironmentOffer {
  const descriptor = serviceCapabilityDescriptor(attributes);
  return {
    providerId: "compute-reference",
    platform: { os: "linux", arch: "x64" },
    capabilities: [{ id: descriptor.id, attributes: descriptor.attributes }],
  };
}

test("the reference descriptor validates and parses its own attributes", () => {
  const descriptor = serviceCapabilityDescriptor();
  assert.equal(descriptor.id, SERVICE_CAPABILITY_ID);
  assert.deepEqual(Object.keys(descriptor.operations), [...SERVICE_OPERATIONS]);
  assert.equal(descriptor.operations.expose!.createsResource, SERVICE_RESOURCE_TYPE);
  assert.equal(descriptor.operations.connect!.createsResource, CONNECTION_RESOURCE_TYPE);
  assert.doesNotThrow(() => validateCapabilityDescriptors([descriptor]));

  const parsed = checkServiceAttributes(descriptor.attributes);
  assert.ok(parsed !== null);
  assert.deepEqual(parsed, REFERENCE);

  // A malformed or overclaiming declaration fails the parse, and
  // therefore matching, instead of narrowing silently.
  assert.equal(checkServiceAttributes({}), null);
  assert.equal(checkServiceAttributes(declaredWith({ protocols: [] })), null);
  assert.equal(checkServiceAttributes(declaredWith({ protocols: ["Not A Protocol"] })), null);
  assert.equal(
    checkServiceAttributes(declaredWith({ supportsTls: "yes" as unknown as boolean })),
    null,
  );
  assert.equal(checkServiceAttributes(declaredWith({ maxExposuresPerAttachment: 0 })), null);
  assert.equal(
    checkServiceAttributes(declaredWith({ publicExposure: "maybe" as ServiceAttributeDeclarations["publicExposure"] })),
    null,
  );
});

test("matching distinguishes declared protocols and exposure modes", () => {
  const offer = serviceOffer();

  const http = matchEnvironment(
    {
      name: "compute",
      requires: {
        [SERVICE_CAPABILITY_ID]: { supportsTls: { equals: true } },
      },
    },
    [offer],
  );
  assert.equal(http.providerId, "compute-reference");

  const denied = refuse(() =>
    matchEnvironment(
      {
        name: "compute",
        requires: {
          [SERVICE_CAPABILITY_ID]: { publicExposure: { equals: "supported" } },
        },
      },
      [offer],
    ),
  );
  assert.equal(denied?.code, "RequirementUnsatisfied");
});

test("expose names process, port, protocol, audience, and expiration", () => {
  const valid = validateServiceExposeInput({
    processResourceId: "res-process-1",
    port: 8080,
    protocol: "http",
    audience: { kind: "session" },
    expiration: { mode: "duration", durationMs: 60000 },
  });
  assert.equal(valid.port, 8080);

  // Every identifying field is required.
  for (const missing of ["processResourceId", "port", "protocol", "audience", "expiration"]) {
    const input: Record<string, unknown> = {
      processResourceId: "res-process-1",
      port: 8080,
      protocol: "http",
      audience: { kind: "session" },
      expiration: { mode: "duration", durationMs: 60000 },
    };
    delete input[missing];
    assert.equal(refuse(() => validateServiceExposeInput(input))?.code, "InvalidRequest", missing);
  }

  // Ports and protocols carry their own rules.
  assert.equal(
    refuse(() =>
      validateServiceExposeInput({
        processResourceId: "res-1",
        port: 70000,
        protocol: "http",
        audience: { kind: "session" },
        expiration: { mode: "duration", durationMs: 1000 },
      }),
    )?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() =>
      validateServiceExposeInput({
        processResourceId: "res-1",
        port: 80,
        protocol: "HTTP/1.1",
        audience: { kind: "session" },
        expiration: { mode: "duration", durationMs: 1000 },
      }),
    )?.code,
    "InvalidRequest",
  );

  // Audiences and expirations must be complete and consistent.
  assert.equal(
    (
      refuse(() =>
        validateServiceExposeInput({
          processResourceId: "res-1",
          port: 80,
          protocol: "http",
          audience: { kind: "attachment" },
          expiration: { mode: "duration", durationMs: 1000 },
        }),
      )?.details as { reason?: string }
    ).reason,
    "audience-attachment-unspecified",
  );
  assert.equal(
    (
      refuse(() =>
        validateServiceExposeInput({
          processResourceId: "res-1",
          port: 80,
          protocol: "http",
          audience: { kind: "session", attachmentId: "att-1" },
          expiration: { mode: "duration", durationMs: 1000 },
        }),
      )?.details as { reason?: string }
    ).reason,
    "audience-attachment-misplaced",
  );
  assert.equal(
    (
      refuse(() =>
        validateServiceExposeInput({
          processResourceId: "res-1",
          port: 80,
          protocol: "http",
          audience: { kind: "session" },
          expiration: { mode: "duration" },
        }),
      )?.details as { reason?: string }
    ).reason,
    "expiration-duration-missing",
  );
  assert.equal(
    (
      refuse(() =>
        validateServiceExposeInput({
          processResourceId: "res-1",
          port: 80,
          protocol: "http",
          audience: { kind: "session" },
          expiration: { mode: "absolute" },
        }),
      )?.details as { reason?: string }
    ).reason,
    "expiration-absolute-missing",
  );
});

test("public unauthenticated exposure requires explicit authorization", () => {
  const refused = refuse(() =>
    validateServiceExposeInput({
      processResourceId: "res-process-1",
      port: 80,
      protocol: "http",
      audience: { kind: "public" },
      expiration: { mode: "duration", durationMs: 60000 },
    }),
  );
  assert.equal(refused?.code, "InvalidRequest");
  assert.equal(
    (refused?.details as { reason?: string }).reason,
    "public-exposure-unauthorized",
  );

  // An explicit grant stands; there is no default one.
  const authorized = validateServiceExposeInput({
    processResourceId: "res-process-1",
    port: 80,
    protocol: "http",
    audience: { kind: "public" },
    expiration: { mode: "duration", durationMs: 60000 },
    authorization: { publicExposure: true, grantedBy: "policy://ops" },
  });
  assert.equal(authorized.audience.kind, "public");
});

test("connect names the service and the consumer generation", () => {
  const connected = validateServiceConnectInput({
    serviceId: "res-service-1",
    consumer: { attachmentId: "att-browser-1", generation: 2 },
  });
  assert.equal(connected.consumer.generation, 2);
  assert.equal(
    refuse(() => validateServiceConnectInput({ serviceId: "res-service-1" }))?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() =>
      validateServiceConnectInput({ consumer: { attachmentId: "att-1", generation: 1 } }),
    )?.code,
    "InvalidRequest",
  );

  validateServiceCloseInput({ resourceId: "res-service-1", kind: "service" });
  validateServiceCloseInput({ resourceId: "res-connection-1" });
  assert.equal(
    refuse(() => validateServiceCloseInput({ resourceId: "" }))?.code,
    "InvalidRequest",
  );

  // The dispatcher routes each operation to its own schema.
  const exposed = validateServiceInput("expose", {
    processResourceId: "res-1",
    port: 80,
    protocol: "http",
    audience: { kind: "session" },
    expiration: { mode: "duration", durationMs: 1000 },
  }) as ServiceExposeInput;
  assert.equal(exposed.port, 80);
  const routed = validateServiceInput("connect", {
    serviceId: "res-service-1",
    consumer: { attachmentId: "att-1", generation: 1 },
  }) as ServiceConnectInput;
  assert.equal(routed.serviceId, "res-service-1");
});

test("service and connection validity follow the compute generation", () => {
  const service = { attachmentId: "att-compute-1", generation: 4 };
  const computeActive = { attachmentId: "att-compute-1", generation: 4, status: "active" };
  assert.equal(serviceStillValid(service, computeActive), true);

  // A replaced or released compute generation invalidates the
  // service, even though the attachment record lives on.
  assert.equal(
    serviceStillValid(service, { ...computeActive, generation: 5 }),
    false,
  );
  assert.equal(
    serviceStillValid(service, { ...computeActive, status: "replacing" }),
    false,
  );
  assert.equal(
    serviceStillValid(service, { ...computeActive, status: "released" }),
    false,
  );

  const consumer = { attachmentId: "att-browser-1", generation: 2 };
  const consumerActive = { attachmentId: "att-browser-1", generation: 2, status: "active" };
  assert.equal(
    connectionStillValid({ service, consumer, compute: computeActive, consumerAttachment: consumerActive }),
    true,
  );
  // The connection dies with the server generation, while the
  // browser attachment stands untouched.
  assert.equal(
    connectionStillValid({
      service,
      consumer,
      compute: { ...computeActive, generation: 5 },
      consumerAttachment: consumerActive,
    }),
    false,
  );
  // It also dies with the consumer generation: the browser owner
  // that connected is gone.
  assert.equal(
    connectionStillValid({
      service,
      consumer,
      compute: computeActive,
      consumerAttachment: { ...consumerActive, generation: 3 },
    }),
    false,
  );
});

test("the expiry resolver tightens but never extends", () => {
  const exposedAt = "2026-09-11T10:00:00.000Z";
  assert.equal(
    resolveServiceExpiry({ mode: "duration", durationMs: 60000 }, exposedAt),
    "2026-09-11T10:01:00.000Z",
  );
  assert.equal(
    resolveServiceExpiry({ mode: "absolute", expiresAt: "2026-09-11T12:00:00.000Z" }, exposedAt),
    "2026-09-11T12:00:00.000Z",
  );
  // A clamp earlier than the asked duration wins; a later one does
  // not extend the exposure past what was asked.
  assert.equal(
    resolveServiceExpiry(
      { mode: "duration", durationMs: 60000 },
      exposedAt,
      "2026-09-11T10:00:30.000Z",
    ),
    "2026-09-11T10:00:30.000Z",
  );
  assert.equal(
    resolveServiceExpiry(
      { mode: "duration", durationMs: 60000 },
      exposedAt,
      "2026-09-11T11:00:00.000Z",
    ),
    "2026-09-11T10:01:00.000Z",
  );
});
