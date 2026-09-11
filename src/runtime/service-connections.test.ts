import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PolicyAuthority } from "../core/policy.js";
import type { PortablePolicy } from "../schema/policy.js";
import { BlobStore } from "../store/blob-store.js";
import { ControlStore } from "../store/control-store.js";
import { checkpointWorkspace } from "./workspace.js";
import { bindResource } from "./resources.js";
import type { BindResourceInput, BindTransport, ResourceFlowOptions } from "./resources.js";
import type {
  AcquisitionStatus,
  AdapterInvocation,
  AdapterOperation,
  AuthorizedAcquireRequest,
  EnvironmentLease,
} from "../schema/adapter.js";
import type { EnvironmentManifest, EnvironmentOffer } from "../schema/capability.js";
import type { EnvironmentAdapter } from "../schema/adapter.js";
import type { ResourceBindingRecord } from "../store/control-store.js";
import {
  PROCESS_CAPABILITY_ID,
  processCapabilityDescriptor,
} from "./process-capability.js";
import { SERVICE_CAPABILITY_ID, serviceCapabilityDescriptor } from "./service-capability.js";
import {
  checkpointReplacement,
  prepareDestination,
  prepareReplacement,
  switchReplacement,
  abortReplacement,
} from "./replacement.js";
import {
  SERVICE_COMPUTE_ATTACHMENT_EXTENSION,
  SERVICE_COMPUTE_GENERATION_EXTENSION,
  SERVICE_ID_EXTENSION,
  SESSION_SERVICE_HOST,
  checkConnectionStanding,
  closeService,
  connectService,
  exposeService,
  invalidateServiceDependencies,
  serviceAudienceKey,
} from "./service-connections.js";
import type { ExposedService } from "./service-connections.js";
import type { ReplaceRequest } from "../schema/handoff.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { BindingResult } from "../schema/adapter.js";

function isPortableCode(
  value: unknown,
): value is { code: string; message?: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
function refuse(
  run: () => unknown,
): { code: string; message?: string; details?: unknown } | null {
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

/** A transport that always reports the reference bound unchanged. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource } satisfies BindingResult;
  },
};

/** The base policy: every capability here, session audiences, free egress. */
function basePolicy(): PortablePolicy {
  return {
    schemaVersion: 1,
    operations: ["exec.process@1", "browser.session@1", "service.port@1"],
    transferDestinations: ["local"],
    networkEgress: "unrestricted",
    serviceAudiences: ["session", "public"],
  };
}

/** The base policy with one field replaced. */
function policyWith(patch: Partial<PortablePolicy>): ResourceFlowOptions["authority"] {
  return PolicyAuthority.fromPolicy({ ...basePolicy(), ...patch });
}

const FLOW: ResourceFlowOptions = { authority: policyWith({}) };

/** One seeded session: compute with a process, browser with a session. */
interface Fixture {
  store: ControlStore;
  blobs: BlobStore;
  cleanup: () => void;
  sessionId: string;
  computeId: string;
  browserId: string;
  processId: string;
  browserResourceId: string;
  revisionId: string;
}

async function seed(): Promise<Fixture> {
  const src = mkdtempSync(join(tmpdir(), "porta-svc-src-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-svc-blobs-"));
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(blobRoot, store);
  const sessionId = `sess-${randomUUID()}`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId: `ws-${randomUUID()}`,
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: new Date().toISOString(),
  });
  writeFileSync(join(src, "app.txt"), "base");
  const checkpoint = checkpointWorkspace(
    store,
    sessionId,
    blobs,
    { requestKey: "import-1", source: { kind: "bridge", rootPath: src } },
    { stability: { kind: "locked" } },
  );
  const compute: AttachmentSummary = {
    sessionId,
    attachmentId: "att-compute-1",
    name: "compute",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  };
  const browser: AttachmentSummary = {
    sessionId,
    attachmentId: "att-browser-1",
    name: "browser",
    generation: 2,
    status: "active",
    capabilityIds: ["browser.session@1"],
  };
  store.insertAttachment(compute);
  store.insertAttachment(browser);
  const processInput: Omit<BindResourceInput, "type" | "recovery"> = {
    owner: { sessionId, attachmentId: compute.attachmentId, generation: 1 },
    capability: "exec.process@1",
    lifetime: "attachment",
  };
  const processId = (
    await bindResource(
      store,
      sessionId,
      { ...processInput, type: "process.group", recovery: "reconstruct" },
      okTransport,
      FLOW,
    )
  ).ref.id;
  const browserResourceId = (
    await bindResource(
      store,
      sessionId,
      {
        owner: { sessionId, attachmentId: browser.attachmentId, generation: 2 },
        capability: "browser.session@1",
        lifetime: "external",
        type: "browser.session",
        recovery: "reattach",
      },
      okTransport,
      FLOW,
    )
  ).ref.id;
  return {
    store,
    blobs,
    cleanup: () => {
      rmSync(src, { recursive: true, force: true });
      rmSync(blobRoot, { recursive: true, force: true });
    },
    sessionId,
    computeId: compute.attachmentId,
    browserId: browser.attachmentId,
    processId,
    browserResourceId,
    revisionId: checkpoint.revision.id,
  };
}

/** One session-audience exposure over the seeded compute. */
function expose(
  parts: Fixture,
  overrides: Partial<Parameters<typeof exposeService>[2]> = {},
  authority: PolicyAuthority = FLOW.authority,
): ExposedService {
  return exposeService(
    parts.store,
    parts.sessionId,
    {
      processResourceId: parts.processId,
      port: 8080,
      protocol: "http",
      audience: { kind: "session" },
      expiration: { mode: "duration", durationMs: 600_000 },
      ...overrides,
    },
    { authority },
  );
}


/**
 * One adapter whose environments offer the process and the service
 * capabilities, so candidate bindings of both pass their guards.
 */
class ServiceAwareLease implements EnvironmentLease {
  constructor(
    private readonly provider: ServiceAwareAdapter,
    readonly environmentId: string,
  ) {}

  async manifest(): Promise<EnvironmentManifest> {
    return this.provider.manifestOf(this.environmentId);
  }

  async invoke(request: AdapterInvocation): Promise<AdapterOperation> {
    return { operationId: request.operationId, status: "completed", result: { ran: true } };
  }

  async inspect(operationId: string): Promise<{ operationId: string; status: "completed" }> {
    return { operationId, status: "completed" };
  }

  async cancel(operationId: string) {
    void operationId;
    return { outcome: "confirmed" as const, stopped: true };
  }

  async bind() {
    return { status: "unsupported" as const };
  }

  async renew(expiresAt: string) {
    return { status: "active" as const, expiresAt, renewalSupported: true };
  }

  async release() {
    return { status: "released" as const, retryable: false };
  }
}

class ServiceAwareAdapter implements EnvironmentAdapter {
  readonly id = "adapter.service-aware";
  private readonly environments = new Map<string, EnvironmentManifest>();
  private counter = 0;

  async describe(): Promise<EnvironmentOffer[]> {
    return [this.offer()];
  }

  async acquire(request: AuthorizedAcquireRequest): Promise<EnvironmentLease> {
    void request;
    const environmentId = `env-svc-${(this.counter += 1)}`;
    this.manifestOf(environmentId);
    return new ServiceAwareLease(this, environmentId);
  }

  async reconcile(acquisitionId: string): Promise<AcquisitionStatus> {
    return { acquisitionId, state: "unknown" };
  }

  lease(environmentId: string): EnvironmentLease {
    return new ServiceAwareLease(this, environmentId);
  }

  manifestOf(environmentId: string): EnvironmentManifest {
    const existing = this.environments.get(environmentId);
    if (existing !== undefined) {
      return existing;
    }
    const manifest: EnvironmentManifest = {
      environmentId,
      providerId: this.id,
      platform: { os: "linux", arch: "x64" },
      capabilities: [processCapabilityDescriptor(), serviceCapabilityDescriptor()],
      enforcement: {},
      adapterVersion: "1.0.0-test",
    };
    this.environments.set(environmentId, manifest);
    return manifest;
  }

  offer(): EnvironmentOffer {
    const service = serviceCapabilityDescriptor();
    return {
      providerId: this.id,
      platform: { os: "linux", arch: "x64" },
      capabilities: [
        { id: PROCESS_CAPABILITY_ID, attributes: processCapabilityDescriptor().attributes },
        { id: SERVICE_CAPABILITY_ID, attributes: service.attributes },
      ],
    };
  }
}

test("expose records the serving generation and holds its own policy", async () => {
  const parts = await seed();
  try {
    const exposed = expose(parts);
    assert.equal(exposed.service.validity, "valid");
    assert.equal(exposed.service.ref.type, "service.port");
    assert.equal(exposed.service.ref.owner.attachmentId, parts.computeId);
    assert.equal(exposed.service.ref.owner.generation, 1);
    assert.equal(exposed.service.ref.recovery, "reconstruct");
    assert.deepEqual(exposed.endpoint, {
      host: SESSION_SERVICE_HOST,
      port: 8080,
      protocol: "http",
    });
    assert.deepEqual(exposed.compute, { attachmentId: parts.computeId, generation: 1 });
    assert.equal(
      Date.parse(exposed.expiresAt) - Date.parse(exposed.exposedAt),
      600_000,
    );

    // The binding carries what later connects must check.
    const record = parts.store.getResourceBinding(parts.sessionId, exposed.service.ref.id)!;
    assert.equal(record.extensions?.[SERVICE_COMPUTE_ATTACHMENT_EXTENSION], parts.computeId);
    assert.equal(record.extensions?.[SERVICE_COMPUTE_GENERATION_EXTENSION], 1);
    assert.ok(
      parts.store
        .listEvents(parts.sessionId, 0)
        .some((event) => event.type === "resource.bound" && event.subjectId === record.id),
    );

    // The audience key names exactly what a policy authorizes.
    assert.equal(serviceAudienceKey({ kind: "session" }), "session");
    assert.equal(
      serviceAudienceKey({ kind: "attachment", attachmentId: "att-b" }),
      "attachment:att-b",
    );

    // An audience the policy does not authorize refuses the exposure.
    const noAudience = refuse(() =>
      exposeService(
        parts.store,
        parts.sessionId,
        {
          processResourceId: parts.processId,
          port: 8080,
          protocol: "http",
          audience: { kind: "attachment", attachmentId: parts.browserId },
          expiration: { mode: "duration", durationMs: 1000 },
        },
        { authority: policyWith({ serviceAudiences: ["session"] }) },
      ),
    );
    assert.equal(noAudience?.code, "PolicyDenied");
    assert.equal((noAudience?.details as { dimension?: string }).dimension, "serviceAudiences");

    // Public unauthenticated exposure needs an explicit grant in the
    // input and `public` in the policy; neither implies the other.
    const ungranted = refuse(() =>
      expose(parts, { audience: { kind: "public" } }),
    );
    assert.equal(
      (ungranted?.details as { reason?: string }).reason,
      "public-exposure-unauthorized",
    );
    const unallowed = refuse(() =>
      expose(
        parts,
        {
          audience: { kind: "public" },
          authorization: { publicExposure: true, grantedBy: "policy://ops" },
        },
        policyWith({ serviceAudiences: ["session"] }),
      ),
    );
    assert.equal(unallowed?.code, "PolicyDenied");
    assert.equal(
      (unallowed?.details as { dimension?: string }).dimension,
      "serviceAudiences",
    );

    // The exposure names a process, or refuses.
    assert.equal(
      (refuse(() => expose(parts, { processResourceId: "res-none" }))?.details as {
        reason?: string;
      }).reason,
      "process-unknown",
    );
    assert.equal(
      (refuse(() => expose(parts, { processResourceId: parts.browserResourceId }))?.details as {
        reason?: string;
      }).reason,
      "process-required",
    );
  } finally {
    parts.cleanup();
  }
});

test("connect checks exposure standing and consumer egress independently", async () => {
  const parts = await seed();
  try {
    const exposed = expose(parts);
    const connected = connectService(
      parts.store,
      parts.sessionId,
      { serviceId: exposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
      { authority: FLOW.authority },
    );
    assert.equal(connected.connection.validity, "valid");
    assert.equal(connected.connection.ref.type, "service.connection");
    assert.equal(connected.connection.ref.owner.attachmentId, parts.browserId);
    assert.equal(connected.connection.ref.owner.generation, 2);
    assert.equal(connected.connection.ref.recovery, "none");
    // The connection cannot outlive the service it reaches.
    assert.equal(connected.connection.ref.expiresAt, exposed.expiresAt);
    assert.equal(connected.endpoint.host, SESSION_SERVICE_HOST);
    const connection = parts.store.getResourceBinding(parts.sessionId, connected.connection.ref.id)!;
    assert.equal(connection.extensions?.[SERVICE_ID_EXTENSION], exposed.service.ref.id);
    assert.equal(connection.extensions?.[SERVICE_COMPUTE_ATTACHMENT_EXTENSION], parts.computeId);
    assert.equal(connection.extensions?.[SERVICE_COMPUTE_GENERATION_EXTENSION], 1);
    assert.equal(checkConnectionStanding(parts.store, parts.sessionId, connection).valid, true);

    // Consumer side: the egress policy decides, whatever the exposure
    // allowed. Neither check can stand in for the other.
    const second = expose(parts, { port: 8081 });
    const noEgress = refuse(() =>
      connectService(
        parts.store,
        parts.sessionId,
        { serviceId: second.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
        { authority: policyWith({ networkEgress: "none" }) },
      ),
    );
    assert.equal(noEgress?.code, "PolicyDenied");
    const offList = refuse(() =>
      connectService(
        parts.store,
        parts.sessionId,
        { serviceId: second.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
        { authority: policyWith({ networkEgress: "allowlist", egressAllowlist: ["other.internal"] }) },
      ),
    );
    assert.equal(offList?.code, "PolicyDenied");
    const onList = connectService(
      parts.store,
      parts.sessionId,
      { serviceId: second.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
      { authority: policyWith({ networkEgress: "allowlist", egressAllowlist: [SESSION_SERVICE_HOST] }) },
    );
    assert.equal(onList.connection.validity, "valid");

    // Consumer side: the operation grant and the generation must hold.
    const noGrant = refuse(() =>
      connectService(
        parts.store,
        parts.sessionId,
        { serviceId: exposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
        { authority: policyWith({ operations: ["exec.process@1", "browser.session@1"] }) },
      ),
    );
    assert.equal(noGrant?.code, "PolicyDenied");
    const stale = refuse(() =>
      connectService(
        parts.store,
        parts.sessionId,
        { serviceId: exposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 9 } },
        { authority: FLOW.authority },
      ),
    );
    assert.equal(stale?.code, "StaleHandle");

    // Exposure side: an attachment audience admits its one attachment.
    const named = exposeService(
      parts.store,
      parts.sessionId,
      {
        processResourceId: parts.processId,
        port: 8082,
        protocol: "http",
        audience: { kind: "attachment", attachmentId: "att-other-1" },
        expiration: { mode: "duration", durationMs: 1000 },
      },
      { authority: policyWith({ serviceAudiences: ["session", "attachment:att-other-1"] }) },
    );
    const mismatch = refuse(() =>
      connectService(
        parts.store,
        parts.sessionId,
        { serviceId: named.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
        { authority: FLOW.authority },
      ),
    );
    assert.equal(mismatch?.code, "PolicyDenied");
    assert.equal(
      (mismatch?.details as { reason?: string }).reason,
      "audience-attachment-mismatch",
    );

    // Exposure side: an expired service admits no connections.
    const brief = expose(parts, { expiration: { mode: "duration", durationMs: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = refuse(() =>
      connectService(
        parts.store,
        parts.sessionId,
        { serviceId: brief.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
        { authority: FLOW.authority },
      ),
    );
    assert.equal(
      (expired?.details as { reason?: string }).reason,
      "service-expired",
    );
  } finally {
    parts.cleanup();
  }
});

test("close ends one connection, and a service close ends its connections", async () => {
  const parts = await seed();
  try {
    const exposed = expose(parts);
    const connected = connectService(
      parts.store,
      parts.sessionId,
      { serviceId: exposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
      { authority: FLOW.authority },
    );

    const closedConnection = closeService(
      parts.store,
      parts.sessionId,
      { resourceId: connected.connection.ref.id },
      { authority: FLOW.authority },
    );
    assert.deepEqual(closedConnection, {
      resourceId: connected.connection.ref.id,
      kind: "connection",
      confirmed: true,
      connectionsClosed: 0,
    });
    // Closing is final: a repeated close confirms nothing new.
    const repeated = closeService(
      parts.store,
      parts.sessionId,
      { resourceId: connected.connection.ref.id },
      { authority: FLOW.authority },
    );
    assert.equal(repeated.confirmed, false);

    const reconnected = connectService(
      parts.store,
      parts.sessionId,
      { serviceId: exposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
      { authority: FLOW.authority },
    );
    const closedService = closeService(
      parts.store,
      parts.sessionId,
      { resourceId: exposed.service.ref.id },
      { authority: FLOW.authority },
    );
    assert.equal(closedService.kind, "service");
    assert.equal(closedService.confirmed, true);
    assert.equal(closedService.connectionsClosed, 1);
    assert.equal(
      parts.store.getResourceBinding(parts.sessionId, reconnected.connection.ref.id)!.status,
      "invalidated",
    );
    assert.equal(
      parts.store.getResourceBinding(parts.sessionId, exposed.service.ref.id)!.status,
      "invalidated",
    );

    // A closed service admits no new connections.
    const refused = refuse(() =>
      connectService(
        parts.store,
        parts.sessionId,
        { serviceId: exposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
        { authority: FLOW.authority },
      ),
    );
    assert.equal(
      (refused?.details as { reason?: string }).reason,
      "service-not-bound",
    );

    const unknown = refuse(() =>
      closeService(parts.store, parts.sessionId, { resourceId: "res-none" }, { authority: FLOW.authority }),
    );
    assert.equal(
      (unknown?.details as { reason?: string }).reason,
      "resource-unknown",
    );
  } finally {
    parts.cleanup();
  }
});

test("replacing the serving generation kills connections and keeps the browser", async () => {
  const parts = await seed();
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-svc-sw-"));
  try {
    const exposed = expose(parts);
    const connected = connectService(
      parts.store,
      parts.sessionId,
      { serviceId: exposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
      { authority: FLOW.authority },
    );

    const adapter = new ServiceAwareAdapter();
    const request: ReplaceRequest = {
      source: { sessionId: parts.sessionId, attachmentId: parts.computeId, generation: 1 },
      destination: { requires: {} },
      workspaceRevisionId: parts.revisionId,
      requiredResources: [],
      reconstruct: [
        {
          id: "recipe-worker",
          inputRevisionId: parts.revisionId,
          requiredCapabilities: ["exec.process@1"],
          steps: [
            { capability: "exec.process@1", operation: "run", input: { command: "npm", args: ["ci"] } },
          ],
          outputs: [
            `process.group ${parts.processId}`,
            `service.port ${exposed.service.ref.id}`,
          ],
          failureConditions: ["ProviderUnavailable"],
        },
      ],
      activeOperations: "reject",
      requestKey: "replace-1",
    };
    const prepared = await prepareReplacement(parts.store, request);
    checkpointReplacement(parts.store, prepared.transitionId);
    const destination = await prepareDestination(parts.store, prepared.transitionId, {
      adapter,
      leaseOf: (environmentId) => Promise.resolve(adapter.lease(environmentId)),
      bind: okTransport,
      blobs: parts.blobs,
      copyRoot,
      principal: "tester",
      authority: FLOW.authority,
    });
    assert.equal(destination.state, "validated");
    const report = switchReplacement(parts.store, prepared.transitionId);
    assert.equal(report.newGeneration, 2);

    // The service died with its generation; the connection died with
    // the service — and the sweep named it in the report.
    assert.equal(
      parts.store.getResourceBinding(parts.sessionId, exposed.service.ref.id)!.status,
      "invalidated",
    );
    const connection = parts.store.getResourceBinding(
      parts.sessionId,
      connected.connection.ref.id,
    )!;
    assert.equal(connection.status, "invalidated");
    assert.equal(connection.invalidationReason, "compute-generation-replaced");
    assert.ok(report.invalidatedResourceIds.includes(connected.connection.ref.id));
    assert.equal(checkConnectionStanding(parts.store, parts.sessionId, connection).valid, false);

    // The browser attachment and its session binding never moved.
    const browser = parts.store.getAttachment(parts.browserId)!;
    assert.equal(browser.status, "active");
    assert.equal(browser.generation, 2);
    assert.equal(
      parts.store.getResourceBinding(parts.sessionId, parts.browserResourceId)!.status,
      "bound",
    );

    // Reconnecting the live browser means a new service on the new
    // generation and a new connection — never a revived one. The
    // process handle the caller holds is the adopted candidate.
    const adoptedProcess = report.adoptedResourceIds
      .map((id) => parts.store.getResourceBinding(parts.sessionId, id)!)
      .find((binding) => binding.type === "process.group")!;
    assert.ok(adoptedProcess !== undefined);
    const reexposed = exposeService(
      parts.store,
      parts.sessionId,
      {
        processResourceId: adoptedProcess.id,
        port: 8080,
        protocol: "http",
        audience: { kind: "session" },
        expiration: { mode: "duration", durationMs: 600_000 },
      },
      { authority: FLOW.authority },
    );
    assert.equal(reexposed.compute.generation, 2);
    const reconnected = connectService(
      parts.store,
      parts.sessionId,
      { serviceId: reexposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
      { authority: FLOW.authority },
    );
    assert.equal(reconnected.connection.validity, "valid");
  } finally {
    parts.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test("an abort keeps the serving generation and its connections standing", async () => {
  const parts = await seed();
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-svc-ab-"));
  try {
    const exposed = expose(parts);
    const connected = connectService(
      parts.store,
      parts.sessionId,
      { serviceId: exposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
      { authority: FLOW.authority },
    );

    const adapter = new ServiceAwareAdapter();
    const request: ReplaceRequest = {
      source: { sessionId: parts.sessionId, attachmentId: parts.computeId, generation: 1 },
      destination: { requires: {} },
      workspaceRevisionId: parts.revisionId,
      requiredResources: [],
      reconstruct: [
        {
          id: "recipe-worker",
          inputRevisionId: parts.revisionId,
          requiredCapabilities: ["exec.process@1"],
          steps: [
            { capability: "exec.process@1", operation: "run", input: { command: "npm", args: ["ci"] } },
          ],
          outputs: [
            `process.group ${parts.processId}`,
            `service.port ${exposed.service.ref.id}`,
          ],
          failureConditions: ["ProviderUnavailable"],
        },
      ],
      activeOperations: "reject",
      requestKey: "replace-2",
    };
    const prepared = await prepareReplacement(parts.store, request);
    checkpointReplacement(parts.store, prepared.transitionId);
    await prepareDestination(parts.store, prepared.transitionId, {
      adapter,
      leaseOf: (environmentId) => Promise.resolve(adapter.lease(environmentId)),
      bind: okTransport,
      blobs: parts.blobs,
      copyRoot,
      principal: "tester",
      authority: FLOW.authority,
    });
    abortReplacement(parts.store, prepared.transitionId);

    // The source reactivated at its unchanged generation, so the
    // service and its connection still stand.
    const compute = parts.store.getAttachment(parts.computeId)!;
    assert.equal(compute.status, "active");
    assert.equal(compute.generation, 1);
    assert.equal(
      parts.store.getResourceBinding(parts.sessionId, exposed.service.ref.id)!.status,
      "bound",
    );
    const connection = parts.store.getResourceBinding(
      parts.sessionId,
      connected.connection.ref.id,
    )!;
    assert.equal(connection.status, "bound");
    assert.equal(checkConnectionStanding(parts.store, parts.sessionId, connection).valid, true);
  } finally {
    parts.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test("the dependency sweep touches only the named generation", async () => {
  const parts = await seed();
  try {
    const exposed = expose(parts);
    const connected = connectService(
      parts.store,
      parts.sessionId,
      { serviceId: exposed.service.ref.id, consumer: { attachmentId: parts.browserId, generation: 2 } },
      { authority: FLOW.authority },
    );

    // A connection pinned to a different generation is not swept.
    const foreign: ResourceBindingRecord = {
      id: "res-connection-foreign",
      sessionId: parts.sessionId,
      type: "service.connection",
      capability: "service.port@1",
      owner: { sessionId: parts.sessionId, attachmentId: parts.browserId, generation: 2 },
      lifetime: "attachment",
      recovery: "none",
      status: "bound",
      extensions: {
        [SERVICE_ID_EXTENSION]: "res-service-elsewhere",
        [SERVICE_COMPUTE_ATTACHMENT_EXTENSION]: "att-elsewhere",
        [SERVICE_COMPUTE_GENERATION_EXTENSION]: 7,
      },
      boundAt: new Date().toISOString(),
    };
    parts.store.insertResourceBinding(foreign);

    const swept = invalidateServiceDependencies(
      parts.store,
      parts.sessionId,
      { attachmentId: parts.computeId, generation: 1 },
      "test-sweep",
    );
    assert.deepEqual(swept.map((entry) => entry.ref.id), [connected.connection.ref.id]);
    // The foreign connection stays bound; only the named generation swept.
    assert.equal(
      parts.store.getResourceBinding(parts.sessionId, foreign.id)!.status,
      "bound",
    );
  } finally {
    parts.cleanup();
  }
});
