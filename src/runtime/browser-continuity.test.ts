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
import type { ResourceBindingRecord } from "../store/control-store.js";
import { checkpointWorkspace } from "./workspace.js";
import { bindResource } from "./resources.js";
import type { BindResourceInput, BindTransport, ResourceFlowOptions } from "./resources.js";
import type {
  AcquisitionStatus,
  AuthorizedAcquireRequest,
  EnvironmentLease,
} from "../schema/adapter.js";
import type { EnvironmentManifest, EnvironmentOffer } from "../schema/capability.js";
import type { EnvironmentAdapter } from "../schema/adapter.js";
import type { AttachmentSummary } from "../schema/session.js";
import type { BindingResult } from "../schema/adapter.js";
import type { ReplaceRequest } from "../schema/handoff.js";
import { PROCESS_CAPABILITY_ID, processCapabilityDescriptor } from "./process-capability.js";
import { SERVICE_CAPABILITY_ID, serviceCapabilityDescriptor } from "./service-capability.js";
import { exposeService, connectService } from "./service-connections.js";
import { reconnectBrowserService } from "./browser-continuity.js";
import type { BrowserContinuityTransport } from "./browser-continuity.js";
import {
  checkpointReplacement,
  prepareDestination,
  prepareReplacement,
  switchReplacement,
} from "./replacement.js";
import { BrowserAdapter } from "../adapters/browser-adapter.js";
import { PROVIDER_SESSION_EXTENSION } from "../adapters/browser-adapter.js";
import type { BrowserLease } from "../adapters/browser-adapter.js";
import type {
  BrowserDriver,
  BrowserDriverCapture,
  BrowserDriverCreate,
  BrowserDriverNavigation,
  BrowserDriverObservation,
  BrowserDriverSession,
} from "../adapters/browser-adapter.js";

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
async function refuse(
  run: () => unknown | Promise<unknown>,
): Promise<{ code: string; message?: string; details?: unknown } | null> {
  try {
    await run();
  } catch (error) {
    if (isPortableCode(error)) {
      return error;
    }
    throw error;
  }
  return null;
}

// -- Scripted browser provider ---------------------------------------------------

/** One scripted provider session the test flips by hand. */
class ScriptedSession implements BrowserDriverSession {
  expired = false;
  expirationReason: string | undefined;
  closed = false;

  constructor(readonly providerSessionId: string) {}

  async navigate(url: string): Promise<BrowserDriverNavigation> {
    return { finalUrl: url, status: 200 };
  }

  async screenshot(): Promise<BrowserDriverCapture> {
    return { bytes: new Uint8Array([1, 2, 3]), truncated: false };
  }

  async observe(): Promise<BrowserDriverObservation> {
    if (this.expired) {
      return { state: "expired", expirationReason: this.expirationReason ?? "unknown" };
    }
    if (this.closed) {
      return { state: "closed" };
    }
    return { state: "active", url: "https://example.test/start", title: "Example" };
  }

  async close(): Promise<boolean> {
    const wasLive = !this.closed && !this.expired;
    this.closed = true;
    return wasLive;
  }
}

/** The driver the browser adapter translates. */
class ScriptedDriver implements BrowserDriver {
  readonly sessions = new Map<string, ScriptedSession>();
  private counter = 0;

  async createSession(input: BrowserDriverCreate): Promise<BrowserDriverSession> {
    void input;
    const session = new ScriptedSession(`provider-session-${(this.counter += 1)}`);
    this.sessions.set(session.providerSessionId, session);
    return session;
  }
}

// -- Destination adapter ----------------------------------------------------------

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

  async invoke() {
    return { operationId: `op-${randomUUID()}`, status: "completed" as const, result: { ran: true } };
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
    return {
      providerId: this.id,
      platform: { os: "linux", arch: "x64" },
      capabilities: [
        { id: PROCESS_CAPABILITY_ID, attributes: processCapabilityDescriptor().attributes },
        { id: SERVICE_CAPABILITY_ID, attributes: serviceCapabilityDescriptor().attributes },
      ],
    };
  }
}

// -- Fixture ----------------------------------------------------------------------

/** The base policy: every capability here, session audiences, free egress. */
function basePolicy(): PortablePolicy {
  return {
    schemaVersion: 1,
    operations: ["exec.process@1", "browser.session@1", "service.port@1"],
    transferDestinations: ["local"],
    networkEgress: "unrestricted",
    serviceAudiences: ["session"],
  };
}

const FLOW: ResourceFlowOptions = { authority: PolicyAuthority.fromPolicy(basePolicy()) };

/** One seeded session: compute with a process, browser with a live session. */
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
  driver: ScriptedDriver;
  transport: BrowserContinuityTransport;
}

async function seed(): Promise<Fixture> {
  const src = mkdtempSync(join(tmpdir(), "porta-cont-src-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-cont-blobs-"));
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
    generation: 3,
    status: "active",
    capabilityIds: ["browser.session@1"],
  };
  store.insertAttachment(compute);
  store.insertAttachment(browser);

  const okTransport: BindTransport = {
    async bind(resource) {
      return { status: "bound", binding: resource } satisfies BindingResult;
    },
  };
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

  // The browser session is real: it is created through the adapter and
  // its provider identity is what the store binding adopts.
  const driver = new ScriptedDriver();
  const adapter = new BrowserAdapter({ driver });
  const lease = (await adapter.acquire({
    acquisitionId: `acq-${randomUUID()}`,
    request: { name: "browser-env", requires: {} },
    authority: { principal: "tester", policyRef: "policy://test" },
  })) as BrowserLease;
  const answered = await lease.invoke({
    operationId: `op-${randomUUID()}`,
    capability: "browser.session@1",
    operation: "create",
    input: {},
    environmentId: lease.environmentId,
    limits: {},
    extensions: {
      "portable.runtime.session-id": sessionId,
      "portable.runtime.attachment-id": browser.attachmentId,
      "portable.runtime.generation": 3,
    },
  });
  assert.equal(answered.status, "completed");
  const created = (answered.result ?? {}) as unknown as {
    resource: { id: string; extensions?: Record<string, string> };
    providerSessionId: string;
  };
  const providerSessionId = created.providerSessionId;
  const browserEnvId = lease.environmentId;
  const browserResourceId = (
    await bindResource(
      store,
      sessionId,
      {
        owner: { sessionId, attachmentId: browser.attachmentId, generation: 3 },
        capability: "browser.session@1",
        lifetime: "external",
        type: "browser.session",
        recovery: "reattach",
      },
      {
        async bind(resource) {
          return {
            status: "bound",
            binding: {
              ...resource,
              extensions: { [PROVIDER_SESSION_EXTENSION]: providerSessionId },
            },
          } satisfies BindingResult;
        },
      },
      FLOW,
    )
  ).ref.id;

  // The continuity transport an embedding backs with its adapter: the
  // provider's word, reached through the binding's provider identity.
  const transport: BrowserContinuityTransport = {
    async observeSession(resourceId) {
      const binding = store.getResourceBinding(sessionId, resourceId);
      const providerId = binding?.extensions?.[PROVIDER_SESSION_EXTENSION];
      if (typeof providerId !== "string") {
        return { state: "unknown" };
      }
      const record = adapter
        .sessionRecordsOf(browserEnvId)
        .find((entry) => entry.providerSessionId === providerId);
      if (record === undefined) {
        return { state: "unknown" };
      }
      const state = await adapter.sessionStateOf(record.resourceId);
      if (state !== "expired") {
        return { state };
      }
      const observed = await driver.sessions.get(providerId)!.observe();
      return {
        state,
        ...(observed.expirationReason !== undefined
          ? { expirationReason: observed.expirationReason }
          : {}),
      };
    },
  };

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
    driver,
    transport,
  };
}

/** One session-audience exposure over the seeded compute. */
function expose(fx: Fixture, processResourceId = fx.processId) {
  return exposeService(
    fx.store,
    fx.sessionId,
    {
      processResourceId,
      port: 8080,
      protocol: "http",
      audience: { kind: "session" },
      expiration: { mode: "duration", durationMs: 600_000 },
    },
    { authority: FLOW.authority },
  );
}

/** Run one full replacement of the compute attachment; return the switch. */
async function replaceCompute(fx: Fixture, serviceId: string) {
  const copyRoot = mkdtempSync(join(tmpdir(), "porta-cont-sw-"));
  const adapter = new ServiceAwareAdapter();
  const request: ReplaceRequest = {
    source: { sessionId: fx.sessionId, attachmentId: fx.computeId, generation: 1 },
    destination: { requires: {} },
    workspaceRevisionId: fx.revisionId,
    requiredResources: [],
    reconstruct: [
      {
        id: "recipe-worker",
        inputRevisionId: fx.revisionId,
        requiredCapabilities: ["exec.process@1"],
        steps: [
          { capability: "exec.process@1", operation: "run", input: { command: "npm", args: ["ci"] } },
        ],
        outputs: [`process.group ${fx.processId}`, `service.port ${serviceId}`],
        failureConditions: ["ProviderUnavailable"],
      },
    ],
    activeOperations: "reject",
    requestKey: `replace-${randomUUID()}`,
  };
  const prepared = await prepareReplacement(fx.store, request);
  checkpointReplacement(fx.store, prepared.transitionId);
  await prepareDestination(fx.store, prepared.transitionId, {
    adapter,
    leaseOf: (environmentId) => Promise.resolve(adapter.lease(environmentId)),
    bind: {
      async bind(resource) {
        return { status: "bound", binding: resource } satisfies BindingResult;
      },
    },
    blobs: fx.blobs,
    copyRoot,
    principal: "tester",
    authority: FLOW.authority,
  });
  try {
    return switchReplacement(fx.store, prepared.transitionId);
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
}

/** The adopted process binding a switch left on the new generation. */
function adoptedProcessOf(fx: Fixture, report: { adoptedResourceIds: string[] }): string {
  const adopted = report.adoptedResourceIds
    .map((id) => fx.store.getResourceBinding(fx.sessionId, id))
    .find((binding) => binding?.type === "process.group");
  assert.ok(adopted !== null && adopted !== undefined);
  return adopted.id;
}

// -- Tests ------------------------------------------------------------------------

test("the same browser handle reconnects after compute replacement", async () => {
  const fx = await seed();
  try {
    const exposed = expose(fx);
    const connected = connectService(
      fx.store,
      fx.sessionId,
      { serviceId: exposed.service.ref.id, consumer: { attachmentId: fx.browserId, generation: 3 } },
      { authority: FLOW.authority },
    );
    const report = await replaceCompute(fx, exposed.service.ref.id);
    assert.equal(report.newGeneration, 2);

    // Old handles fail — each by its own record, none by accident.
    for (const deadId of [fx.processId, exposed.service.ref.id, connected.connection.ref.id]) {
      const record = fx.store.getResourceBinding(fx.sessionId, deadId)!;
      assert.equal(record.status, "invalidated", `${deadId} must be dead`);
    }

    // The browser generation never moved and its handle stayed valid.
    const browserAttachment = fx.store.getAttachment(fx.browserId)!;
    assert.equal(browserAttachment.status, "active");
    assert.equal(browserAttachment.generation, 3);
    const browserBinding = fx.store.getResourceBinding(fx.sessionId, fx.browserResourceId)!;
    assert.equal(browserBinding.status, "bound");
    assert.equal(browserBinding.owner.generation, 3);
    const providerId = browserBinding.extensions?.[PROVIDER_SESSION_EXTENSION];
    assert.ok(typeof providerId === "string");
    assert.equal(fx.driver.sessions.get(providerId)!.expired, false);

    // The same valid browser handle connects to the replacement server.
    const reconnected = await reconnectBrowserService(
      fx.store,
      fx.sessionId,
      {
        browserResourceId: fx.browserResourceId,
        processResourceId: adoptedProcessOf(fx, report),
        port: 8080,
        protocol: "http",
        audience: { kind: "session" },
        expiration: { mode: "duration", durationMs: 600_000 },
        supersededServiceId: exposed.service.ref.id,
      },
      { authority: FLOW.authority, transport: fx.transport },
    );
    // The browser handle is the same one, at the same generation.
    assert.equal(reconnected.browser.ref.id, fx.browserResourceId);
    assert.equal(reconnected.browser.validity, "valid");
    assert.equal(reconnected.browser.ref.owner.attachmentId, fx.browserId);
    assert.equal(reconnected.browser.ref.owner.generation, 3);
    // The dead connection is reported as the one that died, with why.
    assert.equal(reconnected.supersededConnection?.ref.id, connected.connection.ref.id);
    assert.equal(reconnected.supersededConnection?.validity, "released");
    assert.match(
      reconnected.supersededConnection?.detail ?? "",
      /compute-generation-replaced/,
    );
    // The new service serves the replacement generation; the new
    // connection belongs to the browser at its unchanged generation.
    assert.equal(reconnected.service.compute.generation, 2);
    assert.equal(reconnected.connection.connection.validity, "valid");
    assert.equal(reconnected.connection.connection.ref.owner.attachmentId, fx.browserId);
    assert.equal(reconnected.connection.connection.ref.owner.generation, 3);
    assert.notEqual(reconnected.connection.connection.ref.id, connected.connection.ref.id);
  } finally {
    fx.cleanup();
  }
});

test("an expired provider session is reported, never claimed preserved", async () => {
  const fx = await seed();
  try {
    const exposed = expose(fx);
    connectService(
      fx.store,
      fx.sessionId,
      { serviceId: exposed.service.ref.id, consumer: { attachmentId: fx.browserId, generation: 3 } },
      { authority: FLOW.authority },
    );
    const report = await replaceCompute(fx, exposed.service.ref.id);
    const adoptedProcess = adoptedProcessOf(fx, report);

    // The provider says the session expired, and why.
    const session = [...fx.driver.sessions.values()][0]!;
    session.expired = true;
    session.expirationReason = "idle-timeout";

    const refused = await refuse(() =>
      reconnectBrowserService(
        fx.store,
        fx.sessionId,
        {
          browserResourceId: fx.browserResourceId,
          processResourceId: adoptedProcess,
          port: 8080,
          protocol: "http",
          audience: { kind: "session" },
          expiration: { mode: "duration", durationMs: 600_000 },
          supersededServiceId: exposed.service.ref.id,
        },
        { authority: FLOW.authority, transport: fx.transport },
      ),
    );
    assert.equal(refused?.code, "InvalidRequest");
    const details = refused?.details as {
      reason?: string;
      preserved?: boolean;
      expirationReason?: string;
    };
    assert.equal(details.reason, "browser-session-expired");
    assert.equal(details.preserved, false);
    assert.equal(details.expirationReason, "idle-timeout");

    // The binding stopped claiming a valid handle, and the record says
    // exactly what the provider said. The attachment record and its
    // generation are facts the expiry does not rewrite.
    const binding = fx.store.getResourceBinding(fx.sessionId, fx.browserResourceId)!;
    assert.equal(binding.status, "invalidated");
    assert.equal(binding.invalidationReason, "browser-session-expired:idle-timeout");
    const event = fx.store
      .listEvents(fx.sessionId, 0)
      .find(
        (entry) =>
          entry.type === "resource.invalidated" && entry.subjectId === fx.browserResourceId,
      )!;
    assert.ok(event !== undefined);
    assert.equal((event.data as { reason?: string }).reason, "browser-session-expired:idle-timeout");
    assert.equal(fx.store.getAttachment(fx.browserId)!.generation, 3);

    // A repeated reconnect says the handle is dead, not that the
    // session expired again: the store answer comes first.
    const repeat = await refuse(() =>
      reconnectBrowserService(
        fx.store,
        fx.sessionId,
        {
          browserResourceId: fx.browserResourceId,
          processResourceId: adoptedProcess,
          port: 8080,
          protocol: "http",
          audience: { kind: "session" },
          expiration: { mode: "duration", durationMs: 600_000 },
        },
        { authority: FLOW.authority, transport: fx.transport },
      ),
    );
    assert.equal(
      (repeat?.details as { reason?: string }).reason,
      "browser-not-bound",
    );

    // No new service appeared: the reconnection refused before it
    // exposed anything, so the bound services are exactly the adopted
    // candidate the switch transferred.
    const boundServices = fx.store
      .listResourceBindings(fx.sessionId)
      .filter((binding) => binding.type === "service.port" && binding.status === "bound");
    assert.equal(boundServices.length, 1);
    assert.ok(report.adoptedResourceIds.includes(boundServices[0]!.id));
  } finally {
    fx.cleanup();
  }
});

test("refusals report exactly what the provider and the store say", async () => {
  const fx = await seed();
  try {
    // A browser-like binding that dies with its owner has no
    // continuity to integrate.
    const dependent: ResourceBindingRecord = {
      id: "res-browser-dependent",
      sessionId: fx.sessionId,
      type: "browser.session",
      capability: "browser.session@1",
      owner: { sessionId: fx.sessionId, attachmentId: fx.browserId, generation: 3 },
      lifetime: "attachment",
      recovery: "none",
      status: "bound",
      boundAt: new Date().toISOString(),
    };
    fx.store.insertResourceBinding(dependent);
    assert.equal(
      (
        (await refuse(() =>
          reconnectBrowserService(
            fx.store,
            fx.sessionId,
            {
              browserResourceId: dependent.id,
              processResourceId: fx.processId,
              port: 8080,
              protocol: "http",
              audience: { kind: "session" },
              expiration: { mode: "duration", durationMs: 600_000 },
            },
            { authority: FLOW.authority, transport: fx.transport },
          ),
        ))?.details as { reason?: string }
      ).reason,
      "browser-not-independent",
    );

    // A binding whose provider session nobody can find reports
    // unknown; unknown is not dead, so the binding stands.
    const orphan: ResourceBindingRecord = {
      ...dependent,
      id: "res-browser-orphan",
      lifetime: "external",
      recovery: "reattach",
      extensions: { [PROVIDER_SESSION_EXTENSION]: "provider-session-gone" },
    };
    fx.store.insertResourceBinding(orphan);
    assert.equal(
      (
        (await refuse(() =>
          reconnectBrowserService(
            fx.store,
            fx.sessionId,
            {
              browserResourceId: orphan.id,
              processResourceId: fx.processId,
              port: 8080,
              protocol: "http",
              audience: { kind: "session" },
              expiration: { mode: "duration", durationMs: 600_000 },
            },
            { authority: FLOW.authority, transport: fx.transport },
          ),
        ))?.details as { reason?: string }
      ).reason,
      "browser-session-unknown",
    );
    assert.equal(fx.store.getResourceBinding(fx.sessionId, orphan.id)!.status, "bound");

    // A stale owner generation is a stale handle, before any provider
    // word is asked for.
    const stale: ResourceBindingRecord = {
      ...dependent,
      id: "res-browser-stale",
      lifetime: "external",
      recovery: "reattach",
      owner: { sessionId: fx.sessionId, attachmentId: fx.browserId, generation: 1 },
    };
    fx.store.insertResourceBinding(stale);
    assert.equal(
      (await refuse(() =>
        reconnectBrowserService(
          fx.store,
          fx.sessionId,
          {
            browserResourceId: stale.id,
            processResourceId: fx.processId,
            port: 8080,
            protocol: "http",
            audience: { kind: "session" },
            expiration: { mode: "duration", durationMs: 600_000 },
          },
          { authority: FLOW.authority, transport: fx.transport },
        ),
      ))?.code,
      "StaleHandle",
    );

    // A binding whose recorded expiry passed reports that fact; it is
    // never kept alive by the reconnection.
    const past = new Date(Date.now() - 1000).toISOString();
    const expired: ResourceBindingRecord = {
      ...dependent,
      id: "res-browser-expired",
      lifetime: "external",
      recovery: "reattach",
      extensions: { [PROVIDER_SESSION_EXTENSION]: [...fx.driver.sessions.keys()][0]! },
      expiresAt: past,
    };
    fx.store.insertResourceBinding(expired);
    assert.equal(
      (
        (await refuse(() =>
          reconnectBrowserService(
            fx.store,
            fx.sessionId,
            {
              browserResourceId: expired.id,
              processResourceId: fx.processId,
              port: 8080,
              protocol: "http",
              audience: { kind: "session" },
              expiration: { mode: "duration", durationMs: 600_000 },
            },
            { authority: FLOW.authority, transport: fx.transport },
          ),
        ))?.details as { reason?: string }
      ).reason,
      "browser-expired",
    );

    // An unknown resource is unknown.
    assert.equal(
      (
        (await refuse(() =>
          reconnectBrowserService(
            fx.store,
            fx.sessionId,
            {
              browserResourceId: "res-none",
              processResourceId: fx.processId,
              port: 8080,
              protocol: "http",
              audience: { kind: "session" },
              expiration: { mode: "duration", durationMs: 600_000 },
            },
            { authority: FLOW.authority, transport: fx.transport },
          ),
        ))?.details as { reason?: string }
      ).reason,
      "browser-unknown",
    );
  } finally {
    fx.cleanup();
  }
});
