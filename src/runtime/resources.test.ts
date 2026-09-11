import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PolicyAuthority } from "../core/policy.js";
import { providerUnavailableError } from "../core/errors.js";
import type { BindingResult } from "../schema/adapter.js";
import type { AttachmentSummary } from "../schema/session.js";
import { ControlStore } from "../store/control-store.js";
import {
  bindResource,
  invalidateOwnedResources,
  reattachResource,
  resolveResource,
} from "./resources.js";
import type {
  BindResourceInput,
  BindTransport,
  ResolveResourceOptions,
  ResourceFlowOptions,
} from "./resources.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
async function refuse(run: () => unknown): Promise<{ code: string; details?: unknown } | null> {
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

const FULL_AUTHORITY: ResourceFlowOptions = {
  authority: PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    operations: ["exec.process@1", "browser.session@1"],
  }),
};

const RESOLVE: ResolveResourceOptions = {
  authority: FULL_AUTHORITY.authority,
  capability: "exec.process@1",
  operation: "run",
};

/** A transport that always reports the reference bound unchanged. */
const okTransport: BindTransport = {
  async bind(resource) {
    return { status: "bound", binding: resource } satisfies BindingResult;
  },
};

/** One session with one active worker attachment at generation 1. */
function setup(): {
  store: ControlStore;
  sessionId: string;
  worker: AttachmentSummary;
  workerInput: BindResourceInput;
} {
  const store = ControlStore.inMemory();
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
  const worker: AttachmentSummary = {
    sessionId,
    attachmentId: `att-${randomUUID()}`,
    name: "worker",
    generation: 1,
    status: "active",
    capabilityIds: ["exec.process@1"],
  };
  store.insertAttachment(worker);
  const workerInput: BindResourceInput = {
    type: "process.group",
    owner: { sessionId, attachmentId: worker.attachmentId, generation: 1 },
    capability: "exec.process@1",
    lifetime: "attachment",
    recovery: "reconstruct",
    providerResourceId: "cluster://proc/42",
  };
  return { store, sessionId, worker, workerInput };
}

test("binding records a credential-free reference that resolves valid", async () => {
  const parts = setup();
  const bound = await bindResource(
    parts.store,
    parts.sessionId,
    parts.workerInput,
    okTransport,
    FULL_AUTHORITY,
  );

  // The reference is portable: identity and owner only.
  assert.equal(bound.validity, "valid");
  assert.equal(bound.ref.type, "process.group");
  assert.equal(bound.ref.owner.attachmentId, parts.worker.attachmentId);
  assert.equal(bound.ref.owner.generation, 1);
  assert.equal(bound.ref.lifetime, "attachment");
  assert.equal(bound.ref.recovery, "reconstruct");
  assert.match(bound.ref.id, /^res-/);

  // The provider identity rides the description, never the reference.
  assert.equal(bound.providerResourceId, "cluster://proc/42");
  const serialized = JSON.stringify(bound.ref);
  assert.ok(!serialized.includes("providerResourceId"));
  assert.ok(!serialized.match(/token|password|secret|cookie/i));

  // Resolution answers valid while the owner stands.
  const resolved = resolveResource(parts.store, parts.sessionId, bound.ref.id, RESOLVE);
  assert.equal(resolved.validity, "valid");
  assert.equal(resolved.ref.id, bound.ref.id);
  assert.equal(resolved.providerResourceId, "cluster://proc/42");

  // The journal carries the binding event.
  const events = parts.store.listEvents(parts.sessionId, 0);
  assert.deepEqual(
    events.filter((event) => event.type === "resource.bound").map((event) => event.subjectId),
    [bound.ref.id],
  );
});

test("stale, expired, unauthorized, and released resources fail resolution", async () => {
  const parts = setup();

  // An expired lease: the binding's own deadline passed.
  const expired = await bindResource(
    parts.store,
    parts.sessionId,
    { ...parts.workerInput, expiresAt: "2026-01-01T00:00:00.000Z" },
    okTransport,
    FULL_AUTHORITY,
  );
  assert.equal(
    resolveResource(parts.store, parts.sessionId, expired.ref.id, RESOLVE).validity,
    "expired",
  );

  // An unauthorized caller: the policy grants only one operation.
  const narrow: ResolveResourceOptions = {
    authority: PolicyAuthority.fromPolicy({
      schemaVersion: 1,
      operations: ["exec.process@1/run"],
    }),
    capability: "exec.process@1",
    operation: "resolve",
  };
  const unauthorized = await bindResource(
    parts.store,
    parts.sessionId,
    parts.workerInput,
    okTransport,
    FULL_AUTHORITY,
  );
  assert.equal(
    resolveResource(parts.store, parts.sessionId, unauthorized.ref.id, narrow).validity,
    "unauthorized",
  );
  // A capability the binding was not created for is unauthorized too.
  const crossed: ResolveResourceOptions = {
    authority: RESOLVE.authority,
    capability: "browser.session@1",
    operation: "run",
  };
  assert.equal(
    resolveResource(parts.store, parts.sessionId, unauthorized.ref.id, crossed).validity,
    "unauthorized",
  );

  // A released resource: the sweep invalidated its binding.
  const released = await bindResource(
    parts.store,
    parts.sessionId,
    parts.workerInput,
    okTransport,
    FULL_AUTHORITY,
  );
  const swept = invalidateOwnedResources(
    parts.store,
    parts.sessionId,
    parts.worker.attachmentId,
    1,
    "replacement",
  );
  // Every binding the old generation owns dies together, whatever its
  // own validity class was.
  const sweptIds = new Set(swept.map((entry) => entry.ref.id));
  assert.equal(swept.length, 3);
  for (const id of [expired.ref.id, unauthorized.ref.id, released.ref.id]) {
    assert.ok(sweptIds.has(id), `the sweep missed ${id}`);
  }
  const answer = resolveResource(parts.store, parts.sessionId, released.ref.id, RESOLVE);
  assert.equal(answer.validity, "released");
  assert.equal(answer.detail, "replacement");

  // A stale generation: replacement moved the attachment forward. The
  // check outranks the binding status above, so a handle from an old
  // generation reports the generation first.
  const stale = await bindResource(
    parts.store,
    parts.sessionId,
    parts.workerInput,
    okTransport,
    FULL_AUTHORITY,
  );
  parts.store.casAttachment(parts.worker.attachmentId, { generation: 1 }, {
    ...parts.worker,
    generation: 2,
  });
  assert.equal(
    resolveResource(parts.store, parts.sessionId, stale.ref.id, RESOLVE).validity,
    "stale-generation",
  );

  // An unknown identifier reports not-found, not an error.
  assert.equal(
    resolveResource(parts.store, parts.sessionId, "res-missing", RESOLVE).validity,
    "not-found",
  );
  const malformed = await refuse(() =>
    Promise.resolve(resolveResource(parts.store, parts.sessionId, "not an id", RESOLVE)),
  );
  assert.ok(malformed !== null && malformed.code === "InvalidRequest");
});

test("replacement sweeps only the replaced attachment's generation", async () => {
  const parts = setup();
  // An independently attached browser keeps its own generation.
  const browser: AttachmentSummary = {
    sessionId: parts.sessionId,
    attachmentId: `att-${randomUUID()}`,
    name: "browser",
    generation: 1,
    status: "active",
    capabilityIds: ["browser.session@1"],
  };
  parts.store.insertAttachment(browser);

  const workerResource = await bindResource(
    parts.store,
    parts.sessionId,
    parts.workerInput,
    okTransport,
    FULL_AUTHORITY,
  );
  const browserResource = await bindResource(
    parts.store,
    parts.sessionId,
    {
      type: "browser.instance",
      owner: { sessionId: parts.sessionId, attachmentId: browser.attachmentId, generation: 1 },
      capability: "browser.session@1",
      lifetime: "attachment",
      recovery: "native",
      providerResourceId: "grid://browser/9",
    },
    okTransport,
    FULL_AUTHORITY,
  );

  // Compute replacement ends the worker generation only.
  parts.store.casAttachment(parts.worker.attachmentId, { generation: 1 }, {
    ...parts.worker,
    generation: 2,
  });
  const swept = invalidateOwnedResources(
    parts.store,
    parts.sessionId,
    parts.worker.attachmentId,
    1,
    "replacement",
  );
  assert.deepEqual(swept.map((entry) => entry.ref.id), [workerResource.ref.id]);
  assert.equal(
    resolveResource(parts.store, parts.sessionId, workerResource.ref.id, RESOLVE).validity,
    "stale-generation",
  );
  // The browser handle survives with its owner generation intact.
  const browserAnswer = resolveResource(parts.store, parts.sessionId, browserResource.ref.id, {
    authority: FULL_AUTHORITY.authority,
    capability: "browser.session@1",
    operation: "run",
  });
  assert.equal(browserAnswer.validity, "valid");

  // Only the worker resource journaled an invalidation.
  const invalidated = parts.store
    .listEvents(parts.sessionId, 0)
    .filter((event) => event.type === "resource.invalidated");
  assert.deepEqual(invalidated.map((event) => event.subjectId), [workerResource.ref.id]);
  assert.equal((invalidated[0]?.data as { reason?: string }).reason, "replacement");
});

test("reattachment creates a new binding without reviving old handles", async () => {
  const parts = setup();
  const old = await bindResource(
    parts.store,
    parts.sessionId,
    { ...parts.workerInput, type: "db.connection", lifetime: "external", recovery: "reattach" },
    okTransport,
    FULL_AUTHORITY,
  );

  // Replacement ends the old generation, then recovery reattaches.
  parts.store.casAttachment(parts.worker.attachmentId, { generation: 1 }, {
    ...parts.worker,
    generation: 2,
  });
  const reattached = reattachResource(
    parts.store,
    parts.sessionId,
    old.ref.id,
    { sessionId: parts.sessionId, attachmentId: parts.worker.attachmentId, generation: 2 },
    FULL_AUTHORITY,
  );

  // A new identifier under the new generation; the provider identity
  // stays stable and carries over.
  assert.notEqual(reattached.ref.id, old.ref.id);
  assert.equal(reattached.ref.owner.generation, 2);
  assert.equal(reattached.ref.type, "db.connection");
  assert.equal(reattached.ref.recovery, "reattach");
  assert.equal(reattached.providerResourceId, "cluster://proc/42");
  assert.equal(
    resolveResource(parts.store, parts.sessionId, reattached.ref.id, RESOLVE).validity,
    "valid",
  );

  // The old handle stays dead: its generation is stale and its binding
  // is invalidated, and neither a live sibling nor a stable provider
  // identity revives it.
  const oldAnswer = resolveResource(parts.store, parts.sessionId, old.ref.id, RESOLVE);
  assert.equal(oldAnswer.validity, "stale-generation");
  assert.notEqual(oldAnswer.detail, undefined);

  // The journal shows the death and the rebind in order.
  const events = parts.store
    .listEvents(parts.sessionId, 0)
    .filter((event) => event.type === "resource.invalidated" || event.type === "resource.rebound");
  assert.deepEqual(events.map((event) => event.type), ["resource.invalidated", "resource.rebound"]);
  assert.equal((events[0]?.data as { reason?: string }).reason, "reattached");
  const rebound = events[1]?.data as {
    resourceId?: string;
    previousOwnerGeneration?: number;
    ownerGeneration?: number;
  };
  assert.equal(rebound.resourceId, reattached.ref.id);
  assert.equal(rebound.previousOwnerGeneration, 1);
  assert.equal(rebound.ownerGeneration, 2);

  // A resource that does not recover by reattachment refuses. The bind
  // runs at the generation that is current now.
  const plain = await bindResource(
    parts.store,
    parts.sessionId,
    {
      ...parts.workerInput,
      owner: { sessionId: parts.sessionId, attachmentId: parts.worker.attachmentId, generation: 2 },
    },
    okTransport,
    FULL_AUTHORITY,
  );
  const refused = await refuse(() =>
    Promise.resolve(
      reattachResource(
        parts.store,
        parts.sessionId,
        plain.ref.id,
        { sessionId: parts.sessionId, attachmentId: parts.worker.attachmentId, generation: 2 },
        FULL_AUTHORITY,
      ),
    ),
  );
  assert.ok(refused !== null && refused.code === "UnsupportedOperation");
});

test("bind refusals mirror the admission guards", async () => {
  const parts = setup();

  // A stale owner generation refuses before the provider is called.
  const stale = await refuse(() =>
    bindResource(
      parts.store,
      parts.sessionId,
      { ...parts.workerInput, owner: { ...parts.workerInput.owner, generation: 0 } },
      okTransport,
      FULL_AUTHORITY,
    ),
  );
  assert.ok(stale !== null && stale.code === "StaleHandle");

  // A capability the attachment does not offer refuses.
  const offered = await refuse(() =>
    bindResource(
      parts.store,
      parts.sessionId,
      { ...parts.workerInput, capability: "browser.session@1" },
      okTransport,
      FULL_AUTHORITY,
    ),
  );
  assert.ok(offered !== null && offered.code === "InvalidRequest");
  assert.equal(
    (offered.details as { reason?: string }).reason,
    "capability-not-offered",
  );

  // A policy that grants nothing denies the bind.
  const denied = await refuse(() =>
    bindResource(parts.store, parts.sessionId, parts.workerInput, okTransport, {
      authority: PolicyAuthority.fromPolicy({ schemaVersion: 1, operations: [] }),
    }),
  );
  assert.ok(denied !== null && denied.code === "PolicyDenied");

  // An unsupported provider answer refuses without recording a binding.
  const unsupported = await refuse(() =>
    bindResource(parts.store, parts.sessionId, parts.workerInput, {
      async bind() {
        return { status: "unsupported" } satisfies BindingResult;
      },
    }, FULL_AUTHORITY),
  );
  assert.ok(unsupported !== null && unsupported.code === "UnsupportedOperation");
  assert.equal(parts.store.listEvents(parts.sessionId, 0).length, 0);

  // A failed provider answer surfaces its error.
  const failure = providerUnavailableError("The fake binding failed.");
  const failed = await refuse(() =>
    bindResource(parts.store, parts.sessionId, parts.workerInput, {
      async bind() {
        return { status: "failed", error: failure } satisfies BindingResult;
      },
    }, FULL_AUTHORITY),
  );
  assert.ok(failed !== null && failed.code === "ProviderUnavailable");

  // A released owner refuses new bindings.
  parts.store.casAttachment(parts.worker.attachmentId, { status: "active" }, {
    ...parts.worker,
    status: "released",
  });
  const releasedOwner = await refuse(() =>
    bindResource(parts.store, parts.sessionId, parts.workerInput, okTransport, FULL_AUTHORITY),
  );
  assert.ok(releasedOwner !== null && releasedOwner.code === "InvalidRequest");
});
