import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchEnvironment } from "../core/matching.js";
import { BlobStore } from "../store/blob-store.js";
import { ControlStore } from "../store/control-store.js";
import {
  BROWSER_PROVIDER_ID,
  BrowserAdapter,
  BrowserLease,
  OWNER_ATTACHMENT_EXTENSION,
  OWNER_GENERATION_EXTENSION,
  OWNER_SESSION_EXTENSION,
  PROVIDER_SESSION_EXTENSION,
  browserOwnerOf,
} from "./browser-adapter.js";
import type {
  BrowserDriver,
  BrowserDriverCapture,
  BrowserDriverCreate,
  BrowserDriverNavigation,
  BrowserDriverObservation,
  BrowserDriverSession,
  BrowserOwner,
} from "./browser-adapter.js";
import {
  BROWSER_CAPABILITY_ID,
  BROWSER_RESOURCE_TYPE,
} from "../runtime/browser-capability.js";
import type { BrowserState, BrowserWaitUntil } from "../runtime/browser-capability.js";
import type {
  AdapterInvocation,
  AuthorizedAcquireRequest,
} from "../schema/adapter.js";
import type { AcquisitionLimits } from "../schema/policy.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one async call instead of throwing it. */
async function refusal(
  run: () => Promise<unknown>,
): Promise<{ code: string; details?: unknown } | null> {
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

// -- Scripted provider ------------------------------------------------------------

/** One scripted provider session; the cookie jar stays inside it. */
class ScriptedSession implements BrowserDriverSession {
  readonly jar = new Map<string, string>();
  /** Set to make the provider report an expired session. */
  expiredReason: string | undefined;
  private state: BrowserState = "active";
  private lastUrl: string | undefined;

  constructor(readonly providerSessionId: string, options: BrowserDriverCreate) {
    void options;
  }

  async navigate(url: string, waitUntil: BrowserWaitUntil): Promise<BrowserDriverNavigation> {
    void waitUntil;
    this.lastUrl = url;
    this.jar.set("auth", "provider-cookie-secret");
    return { finalUrl: url, status: 200 };
  }

  async screenshot(input: {
    format: "png" | "jpeg";
    fullPage?: boolean;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<BrowserDriverCapture> {
    void input;
    const bytes = Buffer.from(`image-of-${this.providerSessionId}`.padEnd(48, "."));
    return { bytes, truncated: false };
  }

  async observe(): Promise<BrowserDriverObservation> {
    if (this.expiredReason !== undefined) {
      return {
        state: "expired",
        expirationReason: this.expiredReason,
        ...(this.lastUrl !== undefined ? { url: this.lastUrl } : {}),
      };
    }
    return {
      state: this.state,
      ...(this.lastUrl !== undefined ? { url: this.lastUrl } : {}),
    };
  }

  async close(): Promise<boolean> {
    if (this.state === "closed") {
      return false;
    }
    this.state = "closed";
    return true;
  }
}

/** The provider driver; every session it created stays reachable. */
class ScriptedDriver implements BrowserDriver {
  readonly sessions: ScriptedSession[] = [];

  async createSession(input: BrowserDriverCreate): Promise<ScriptedSession> {
    const session = new ScriptedSession(`drv-${this.sessions.length + 1}`, input);
    this.sessions.push(session);
    return session;
  }
}

// -- Fixture ------------------------------------------------------------------------

const OWNER_A: BrowserOwner = { sessionId: "sess-1", attachmentId: "att-a", generation: 1 };
const OWNER_B: BrowserOwner = { sessionId: "sess-1", attachmentId: "att-b", generation: 4 };

/** Extensions that name one owning attachment generation. */
function ownerExtensions(owner: BrowserOwner): Record<string, unknown> {
  return {
    [OWNER_SESSION_EXTENSION]: owner.sessionId,
    [OWNER_ATTACHMENT_EXTENSION]: owner.attachmentId,
    [OWNER_GENERATION_EXTENSION]: owner.generation,
  };
}

/** Explicit grants every successful acquire in this file carries. */
const LIMITS: AcquisitionLimits = {
  executionLocations: ["local", "remote"],
  networkEgress: "unrestricted",
  egressAllowlist: [],
  hostFilesystemAccess: true,
  maxEnvironmentLifetimeMs: 86_400_000,
  maxResources: {
    memoryBytes: 4 * 1024 ** 3,
    storageBytes: 4 * 1024 ** 3,
    gpuMemoryBytes: 4 * 1024 ** 3,
  },
};

function acquireRequest(acquisitionId: string): AuthorizedAcquireRequest {
  return {
    acquisitionId,
    request: { name: "browser", requires: {} },
    authority: { principal: "tester", policyRef: "policy://test" },
    limits: LIMITS,
  };
}

let operationCount = 0;

/** Drive one operation through a lease and return its result. */
async function drive<T>(
  lease: BrowserLease,
  operation: string,
  input: unknown,
  owner?: BrowserOwner,
): Promise<T> {
  const request: AdapterInvocation = {
    operationId: `op-${++operationCount}`,
    capability: BROWSER_CAPABILITY_ID,
    operation,
    input,
    environmentId: lease.environmentId,
    limits: {},
    ...(owner !== undefined ? { extensions: ownerExtensions(owner) } : {}),
  };
  const answered = await lease.invoke(request);
  assert.equal(answered.status, "completed");
  return answered.result as T;
}

/** One adapter over one scripted driver, acquired once. */
async function fixture(
  options: Partial<ConstructorParameters<typeof BrowserAdapter>[0]> = {},
): Promise<{ adapter: BrowserAdapter; driver: ScriptedDriver; lease: BrowserLease }> {
  const driver = new ScriptedDriver();
  const adapter = new BrowserAdapter({ driver, ...options });
  const lease = await adapter.acquire(acquireRequest("acq-1"));
  return { adapter, driver, lease: lease as BrowserLease };
}

// -- Tests ---------------------------------------------------------------------------

test("the five operations run the contract and a screenshot is an addressable artifact", async () => {
  const { adapter, lease } = await fixture();

  const created = await drive<{
    resource: {
      id: string;
      type: string;
      lifetime: string;
      recovery: string;
      extensions?: Record<string, unknown>;
    };
    providerSessionId: string;
    createdAt: string;
  }>(lease, "create", { name: "docs" }, OWNER_A);
  assert.equal(created.resource.type, BROWSER_RESOURCE_TYPE);
  assert.equal(created.resource.lifetime, "external");
  assert.equal(created.resource.recovery, "reattach");
  assert.equal(
    created.resource.extensions?.[PROVIDER_SESSION_EXTENSION],
    created.providerSessionId,
  );
  assert.deepEqual(
    browserOwnerOf(ownerExtensions(OWNER_A)),
    OWNER_A,
    "the owner extensions parse back",
  );

  const navigated = await drive<{ url: string; finalUrl: string; status?: number; waitUntil: string }>(
    lease,
    "navigate",
    { resourceId: created.resource.id, url: "https://example.org/docs", waitUntil: "network-idle" },
  );
  assert.equal(navigated.finalUrl, "https://example.org/docs");
  assert.equal(navigated.status, 200);
  assert.equal(navigated.waitUntil, "network-idle");

  const shot = await drive<{
    image: { dataBase64?: string; digest?: string; byteLength: number; truncated: boolean };
    format: string;
  }>(lease, "screenshot", { resourceId: created.resource.id, format: "png" });
  const bytes = Buffer.from(shot.image.dataBase64 ?? "", "base64");
  assert.equal(shot.image.byteLength, bytes.byteLength);
  assert.equal(shot.image.truncated, false);
  // The capture names its content: the digest is the address of the
  // same bytes in any content-addressed store (SPEC.md section 9.4).
  assert.equal(
    shot.image.digest,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const blobs = new BlobStore(
    mkdtempSync(join(tmpdir(), "porta-browser-")),
    ControlStore.inMemory(),
  );
  const stored = blobs.put(bytes);
  assert.equal(stored.digest, shot.image.digest);
  assert.equal(stored.sizeBytes, shot.image.byteLength);

  const inspected = await drive<{ state: BrowserState; url?: string }>(
    lease,
    "inspect",
    { resourceId: created.resource.id },
  );
  assert.equal(inspected.state, "active");
  assert.equal(inspected.url, "https://example.org/docs");

  const closed = await drive<{ confirmed: boolean; state: BrowserState }>(
    lease,
    "close",
    { resourceId: created.resource.id },
  );
  assert.equal(closed.confirmed, true);
  assert.equal(closed.state, "closed");
  assert.equal(await adapter.sessionStateOf(created.resource.id), "closed");

  const refused = await refusal(() => drive(lease, "inspect", { resourceId: created.resource.id }));
  assert.equal(refused?.code, "InvalidRequest");
  assert.equal((refused?.details as { reason?: string }).reason, "session-closed");
});

test("an external session survives its environment's release and reattaches by binding", async () => {
  const { adapter, lease } = await fixture();

  const created = await drive<{ resource: { id: string } }>(lease, "create", {}, OWNER_A);
  await drive(lease, "navigate", { resourceId: created.resource.id, url: "https://example.org" }, OWNER_A);
  const released = await lease.release();
  assert.equal(released.status, "released");

  // The session outlived the compute that created it; only the lease
  // died. Nothing closed it and nothing inferred an expiry.
  assert.equal(await adapter.sessionStateOf(created.resource.id), "active");
  const deadLease = await refusal(() =>
    drive(lease, "inspect", { resourceId: created.resource.id }),
  );
  assert.equal(deadLease?.code, "LeaseExpired");

  // A new attachment adopts the provider session through a binding.
  const second = await adapter.acquire(acquireRequest("acq-2"));
  const binding = await second.bind(
    {
      id: created.resource.id,
      sessionId: "sess-1",
      type: BROWSER_RESOURCE_TYPE,
      owner: { sessionId: "sess-1", attachmentId: OWNER_B.attachmentId, generation: OWNER_B.generation },
      lifetime: "external",
      recovery: "reattach",
    },
    { authority: { principal: "tester", policyRef: "policy://test" }, resolveSecret: async () => "" },
  );
  assert.equal(binding.status, "bound");
  assert.equal(binding.binding?.owner.attachmentId, OWNER_B.attachmentId);

  const resumed = await drive<{ finalUrl: string }>(
    second as BrowserLease,
    "navigate",
    { resourceId: created.resource.id, url: "https://example.org/next" },
    OWNER_B,
  );
  assert.equal(resumed.finalUrl, "https://example.org/next");
  const [adopted] = adapter.sessionRecordsOf((second as BrowserLease).environmentId);
  assert.ok(adopted !== undefined);
  assert.equal(adopted.owner.attachmentId, OWNER_B.attachmentId);
  assert.notEqual(adopted.reattachedAt, undefined);

  // Cookies stayed in the provider: no result, record, or binding
  // carries the jar's contents (SPEC.md section 14.4).
  const everything = JSON.stringify({
    created,
    binding,
    adopted,
    manifest: await (second as BrowserLease).manifest(),
  });
  assert.equal(everything.includes("provider-cookie-secret"), false);
});

test("a release closes its own attachment-scoped sessions and no others", async () => {
  const driver = new ScriptedDriver();
  const adapter = new BrowserAdapter({
    driver,
    sessionPersistence: "attachment",
    reattachment: "none",
  });
  const first = (await adapter.acquire(acquireRequest("acq-1"))) as BrowserLease;
  const second = (await adapter.acquire(acquireRequest("acq-2"))) as BrowserLease;

  const mine = await drive<{ resource: { id: string } }>(first, "create", {}, OWNER_A);
  const theirs = await drive<{ resource: { id: string } }>(second, "create", {}, OWNER_B);

  // Closing compute A closes only A's browser, never B's.
  await first.release();
  assert.equal(await adapter.sessionStateOf(mine.resource.id), "closed");
  assert.equal(await adapter.sessionStateOf(theirs.resource.id), "active");
  const stillDriven = await drive<{ finalUrl: string }>(
    second,
    "navigate",
    { resourceId: theirs.resource.id, url: "https://example.org" },
    OWNER_B,
  );
  assert.equal(stillDriven.finalUrl, "https://example.org");

  // With no reattachment path declared, binding is unsupported.
  const refused = await second.bind(
    {
      id: mine.resource.id,
      sessionId: "sess-1",
      type: BROWSER_RESOURCE_TYPE,
      owner: { sessionId: "sess-1", attachmentId: OWNER_B.attachmentId, generation: 1 },
      lifetime: "attachment",
      recovery: "none",
    },
    { authority: { principal: "tester", policyRef: "policy://test" }, resolveSecret: async () => "" },
  );
  assert.equal(refused.status, "unsupported");
});

test("operation-scoped sessions end with the invocation that created them", async () => {
  const { adapter, lease } = await fixture({ sessionPersistence: "operation" });

  const created = await drive<{ resource: { id: string; lifetime: string } }>(
    lease,
    "create",
    {},
    OWNER_A,
  );
  assert.equal(created.resource.lifetime, "operation");
  // The invocation ended, so the session ended with it.
  assert.equal(await adapter.sessionStateOf(created.resource.id), "closed");
});

test("provider expiration is reported through inspect and never revived", async () => {
  const { adapter, driver, lease } = await fixture();

  const created = await drive<{ resource: { id: string } }>(lease, "create", {}, OWNER_A);
  const providerSession = driver.sessions[0];
  assert.ok(providerSession !== undefined);
  providerSession.expiredReason = "idle-timeout";

  const inspected = await drive<{
    state: BrowserState;
    expirationReason?: string;
    expiresAt?: string;
  }>(lease, "inspect", { resourceId: created.resource.id });
  assert.equal(inspected.state, "expired");
  assert.equal(inspected.expirationReason, "idle-timeout");
  // The provider reported no expiry time, so none appears.
  assert.equal(inspected.expiresAt, undefined);

  // A binding cannot adopt a session the provider calls expired.
  const second = (await adapter.acquire(acquireRequest("acq-2"))) as BrowserLease;
  const binding = await second.bind(
    {
      id: created.resource.id,
      sessionId: "sess-1",
      type: BROWSER_RESOURCE_TYPE,
      owner: { sessionId: "sess-1", attachmentId: OWNER_B.attachmentId, generation: 1 },
      lifetime: "external",
      recovery: "reattach",
    },
    { authority: { principal: "tester", policyRef: "policy://test" }, resolveSecret: async () => "" },
  );
  assert.equal(binding.status, "failed");
  assert.equal(
    (binding.error?.details as { reason?: string }).reason,
    "session-expired",
  );
});

test("declared constraints and adapter discipline hold", async () => {
  const { adapter, lease } = await fixture();

  // The declared offer matches what the attributes say.
  const [offer] = await adapter.describe();
  assert.ok(offer !== undefined);
  assert.equal(offer.providerId, BROWSER_PROVIDER_ID);
  const matched = matchEnvironment(
    {
      name: "browser",
      requires: {
        [BROWSER_CAPABILITY_ID]: {
          sessionPersistence: { equals: "external" },
          reattachment: { equals: "provider-session" },
        },
      },
    },
    [offer],
  );
  assert.equal(matched.providerId, BROWSER_PROVIDER_ID);

  // A repeated acquisition returns the same environment.
  const again = await adapter.acquire(acquireRequest("acq-1"));
  assert.equal(again.environmentId, lease.environmentId);
  assert.equal((await adapter.reconcile("acq-none")).state, "unknown");
  assert.equal((await adapter.reconcile("acq-1")).state, "allocated");

  // Owner identity is required to attribute a session.
  const unowned = await refusal(() => drive(lease, "create", {}));
  assert.equal((unowned?.details as { reason?: string }).reason, "owner-unspecified");
  assert.equal(browserOwnerOf({ [OWNER_ATTACHMENT_EXTENSION]: "att-a" }), null);

  // Network constraints refuse what they do not allow.
  const session = await drive<{ resource: { id: string } }>(lease, "create", {}, OWNER_A);
  const offOrigin = await refusal(() =>
    drive(lease, "navigate", { resourceId: session.resource.id, url: "https://blocked.example/" }),
  );
  assert.equal((offOrigin?.details as { reason?: string }).reason, "network-origin-not-allowed");
  const privateRange = await refusal(() =>
    drive(lease, "navigate", { resourceId: session.resource.id, url: "http://127.0.0.1:8080/" }),
  );
  assert.equal(
    (privateRange?.details as { reason?: string }).reason,
    "network-private-range-blocked",
  );
  const linkLocal = await refusal(() =>
    drive(lease, "navigate", { resourceId: session.resource.id, url: "http://169.254.169.254/" }),
  );
  assert.equal(linkLocal?.code, "InvalidRequest");

  // Foreign capabilities and sessions refuse outright.
  const foreign = await refusal(() =>
    lease.invoke({
      operationId: "op-foreign",
      capability: "exec.process@1",
      operation: "run",
      input: {},
      environmentId: lease.environmentId,
      limits: {},
    }),
  );
  assert.equal(foreign?.code, "UnsupportedOperation");

  const unknown = await refusal(() =>
    drive(lease, "inspect", { resourceId: "res-browser-none" }),
  );
  assert.equal((unknown?.details as { reason?: string }).reason, "session-unknown");

  const unknownOperation = await refusal(() => lease.inspect("op-unknown"));
  assert.equal(unknownOperation?.code, "InvalidRequest");
});
