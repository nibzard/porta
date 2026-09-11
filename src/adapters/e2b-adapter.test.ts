import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuthorizedAcquireRequest } from "../schema/adapter.js";
import { environmentManifestSchema } from "../schema/capability.js";
import { assertValid } from "../schema/validate.js";
import {
  E2B_LINUX_PROVIDER_ID,
  E2BLinuxAdapter,
  SdkE2BClient,
} from "./e2b-adapter.js";
import type { E2BClient, E2BSandboxInfo } from "./e2b-adapter.js";

/**
 * In-memory provider. The fake models the parts of E2B the adapter
 * relies on: metadata-tagged creation, metadata-filtered listing, and
 * identifier-based inspection, timeout, and kill.
 */
class FakeE2BClient implements E2BClient {
  readonly sandboxes = new Map<
    string,
    { info: E2BSandboxInfo; metadata: Record<string, string> }
  >();
  createCalls = 0;
  killCalls = 0;
  readonly timeoutCalls: Array<{ sandboxId: string; timeoutMs: number }> = [];
  /** Throw after registering: the sandbox exists but the reply is lost. */
  loseCreateResponse = false;
  /** Throw before registering: the create never landed. */
  dropCreateRequest = false;
  failGetInfo = false;
  failKill = false;

  async create(input: {
    template: string;
    timeoutMs: number;
    metadata: Record<string, string>;
    apiKey: string;
  }): Promise<{ sandboxId: string }> {
    void input.apiKey;
    if (this.dropCreateRequest) {
      throw new Error("network unreachable");
    }
    this.createCalls += 1;
    const sandboxId = `sbx-${this.createCalls}`;
    this.sandboxes.set(sandboxId, {
      info: {
        sandboxId,
        templateId: input.template,
        state: "running",
        cpuCount: 2,
        memoryMB: 2048,
        envdVersion: "0.2.1",
        startedAt: new Date().toISOString(),
        endAt: new Date(Date.now() + input.timeoutMs).toISOString(),
      },
      metadata: { ...input.metadata },
    });
    if (this.loseCreateResponse) {
      throw new Error("connection lost before the response arrived");
    }
    return { sandboxId };
  }

  async getInfo(sandboxId: string, apiKey: string): Promise<E2BSandboxInfo | null> {
    void apiKey;
    if (this.failGetInfo) {
      throw new Error("getInfo unreachable");
    }
    return this.sandboxes.get(sandboxId)?.info ?? null;
  }

  async listByMetadata(
    metadata: Record<string, string>,
    apiKey: string,
  ): Promise<E2BSandboxInfo[]> {
    void apiKey;
    return [...this.sandboxes.values()]
      .filter((entry) =>
        Object.entries(metadata).every(
          ([key, value]) => entry.metadata[key] === value,
        ),
      )
      .map((entry) => entry.info);
  }

  async setTimeout(
    sandboxId: string,
    timeoutMs: number,
    apiKey: string,
  ): Promise<void> {
    void apiKey;
    this.timeoutCalls.push({ sandboxId, timeoutMs });
  }

  async kill(sandboxId: string, apiKey: string): Promise<boolean> {
    void apiKey;
    this.killCalls += 1;
    if (this.failKill) {
      throw new Error("kill unreachable");
    }
    return this.sandboxes.delete(sandboxId);
  }

  /** The provider paused one sandbox (it still holds resources). */
  pause(sandboxId: string): void {
    const entry = this.sandboxes.get(sandboxId);
    if (entry !== undefined) {
      entry.info = { ...entry.info, state: "paused" };
    }
  }
}

/** One adapter over one scratch state directory, plus its fake client. */
interface Fixture {
  adapter: E2BLinuxAdapter;
  client: FakeE2BClient;
  stateDir: string;
  /** A fresh adapter over the same durable records and provider. */
  reopen(): E2BLinuxAdapter;
  close(): void;
}

function make(options: { client?: FakeE2BClient } = {}): Fixture {
  const stateDir = mkdtempSync(join(tmpdir(), "porta-e2b-"));
  const client = options.client ?? new FakeE2BClient();
  const build = () =>
    new E2BLinuxAdapter({ stateDir, client, apiKey: "e2b_test_key" });
  return {
    adapter: build(),
    client,
    stateDir,
    reopen: () => build(),
    close: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

function request(
  acquisitionId = `acq-${randomUUID()}`,
  overrides: Partial<AuthorizedAcquireRequest["request"]> = {},
): AuthorizedAcquireRequest {
  return {
    acquisitionId,
    request: {
      name: "remote-linux",
      providerId: E2B_LINUX_PROVIDER_ID,
      requires: {},
      ...overrides,
    },
    authority: { principal: "user://test", policyRef: "policy://test" },
  };
}

function isPortableCode(
  value: unknown,
): value is { code: string; message: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
async function refuse(
  run: () => unknown,
): Promise<{ code: string; message: string; details?: unknown } | null> {
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

test("acquisition is idempotent and the manifest carries actual resources", async () => {
  const fixture = make();
  try {
    const acquire = request("acq-stable");
    const first = await fixture.adapter.acquire(acquire);
    const again = await fixture.adapter.acquire(acquire);
    assert.equal(again.environmentId, first.environmentId);
    assert.equal(fixture.client.createCalls, 1);

    // The manifest describes what the provider reported, not a guess.
    const manifest = await first.manifest();
    assertValid(environmentManifestSchema, manifest);
    assert.equal(manifest.providerId, E2B_LINUX_PROVIDER_ID);
    assert.deepEqual(manifest.platform, { os: "linux", arch: "x86_64" });
    assert.deepEqual(manifest.capabilities, []);
    assert.deepEqual(manifest.resources, { cpuCount: 2, memoryBytes: 2048 * 1024 * 1024 });
    assert.equal(manifest.providerRuntimeVersion, "0.2.1");
    const enforcement = manifest.enforcement as Record<string, unknown>;
    assert.equal(enforcement.sandboxId, "sbx-1");
    assert.equal(enforcement.sandboxTemplate, "base");
    assert.equal(enforcement.isolation, "firecracker-microvm");
    assert.equal(enforcement.releaseSemantics, "kill-discards-state");

    // Discovery offers nothing this adapter cannot do yet.
    assert.deepEqual(await fixture.adapter.describe(), []);
  } finally {
    fixture.close();
  }
});

test("a lost create response recovers by durable identity", async () => {
  const fixture = make();
  try {
    fixture.client.loseCreateResponse = true;
    const acquire = request("acq-lost");
    const lost = await refuse(() => fixture.adapter.acquire(acquire));
    assert.equal(lost?.code, "ProviderUnavailable");

    // The sandbox exists on the provider; the reply never landed. A
    // fresh adapter over the same records and provider recovers it.
    fixture.client.loseCreateResponse = false;
    const reopened = fixture.reopen();
    const lease = await reopened.acquire(acquire);
    const manifest = await lease.manifest();
    assert.equal(
      (manifest.enforcement as Record<string, unknown>).sandboxId,
      "sbx-1",
    );
    // Recovery adopted the tagged sandbox; nothing was created twice.
    assert.equal(fixture.client.createCalls, 1);

    const status = await reopened.reconcile("acq-lost");
    assert.equal(status.state, "allocated");
    assert.equal(status.environmentId, lease.environmentId);
  } finally {
    fixture.close();
  }
});

test("a create that never landed starts fresh under the same identity", async () => {
  const fixture = make();
  try {
    fixture.client.dropCreateRequest = true;
    const acquire = request("acq-never");
    assert.equal((await refuse(() => fixture.adapter.acquire(acquire)))?.code, "ProviderUnavailable");

    // Reconciliation cannot invent an answer: the intent exists, no
    // sandbox answers for it.
    assert.equal((await fixture.adapter.reconcile("acq-never")).state, "unknown");

    fixture.client.dropCreateRequest = false;
    const lease = await fixture.reopen().acquire(acquire);
    assert.equal(fixture.client.createCalls, 1);
    assert.equal(
      ((await lease.manifest()).enforcement as Record<string, unknown>).sandboxId,
      "sbx-1",
    );
  } finally {
    fixture.close();
  }
});

test("reconciliation reads provider truth: paused holds, gone means released", async () => {
  const fixture = make();
  try {
    const lease = await fixture.adapter.acquire(request("acq-truth"));
    fixture.client.pause("sbx-1");
    // A paused sandbox still holds the allocation.
    assert.equal((await fixture.adapter.reconcile("acq-truth")).state, "allocated");

    // The provider ends the sandbox (timeout kill). The allocation is
    // over, whichever side ended it.
    fixture.client.sandboxes.delete("sbx-1");
    const ended = await fixture.adapter.reconcile("acq-truth");
    assert.equal(ended.state, "released");
    assert.equal(ended.environmentId, lease.environmentId);

    // A repeated acquire over a dead sandbox refuses to fake one.
    const dead = await refuse(() => fixture.adapter.acquire(request("acq-truth")));
    assert.equal(dead?.code, "StaleHandle");

    // An identity this adapter never saw is unknown, never guessed.
    assert.equal((await fixture.adapter.reconcile("acq-never-seen")).state, "unknown");
  } finally {
    fixture.close();
  }
});

test("uncertain allocations stay visible until the provider answers", async () => {
  const fixture = make();
  try {
    const lease = await fixture.adapter.acquire(request("acq-uncertain"));
    const environmentId = lease.environmentId;

    // A release the provider does not confirm stays an obligation.
    fixture.client.failKill = true;
    const failed = await lease.release();
    assert.equal(failed.status, "failed");
    assert.equal(failed.retryable, true);
    const held = await fixture.adapter.reconcile("acq-uncertain");
    assert.equal(held.state, "allocated");
    assert.equal(held.error?.code, "CleanupPending");
    assert.equal(held.environmentId, environmentId);
    const unconfirmed = fixture.adapter
      .allocations()
      .find((record) => record.acquisitionId === "acq-uncertain");
    assert.equal(unconfirmed?.releaseConfirmed, false);
    assert.ok(unconfirmed?.releaseDetail?.includes("kill unreachable"));

    // Work refuses while the lease is over, even unconfirmed.
    const refused = await refuse(() =>
      lease.invoke({
        operationId: "op-1",
        capability: "exec.process@1",
        operation: "run",
        input: {},
        environmentId,
        limits: {},
      }),
    );
    assert.equal(refused?.code, "LeaseExpired");

    // The provider answers, and the release completes.
    fixture.client.failKill = false;
    const released = await lease.release();
    assert.deepEqual(released, { status: "released", retryable: false });
    assert.equal((await fixture.adapter.reconcile("acq-uncertain")).state, "released");
    assert.equal(fixture.client.killCalls, 2);
    // Release stays idempotent.
    assert.equal((await lease.release()).status, "released");

    // An inspection that cannot reach the provider is unknown, never
    // a silent release.
    const other = await fixture.adapter.acquire(request("acq-opaque"));
    fixture.client.failGetInfo = true;
    const opaque = await fixture.adapter.reconcile("acq-opaque");
    assert.equal(opaque.state, "unknown");
    assert.equal(opaque.error?.code, "ProviderUnavailable");
    fixture.client.failGetInfo = false;
    assert.equal((await fixture.adapter.reconcile("acq-opaque")).state, "allocated");
    await other.release();
  } finally {
    fixture.close();
  }
});

test("renewal extends through the provider and reports the cap it got", async () => {
  const fixture = make();
  try {
    const lease = await fixture.adapter.acquire(request("acq-renew"));
    const target = new Date(Date.now() + 30 * 60_000).toISOString();
    const status = await lease.renew(target);
    assert.equal(status.status, "active");
    assert.equal(status.renewalSupported, true);
    const call = fixture.client.timeoutCalls[0]!;
    assert.ok(call.timeoutMs > 29 * 60_000 && call.timeoutMs <= 30 * 60_000, String(call.timeoutMs));
    assert.ok(Date.parse(status.expiresAt!) > Date.now() + 29 * 60_000);

    // A renewal past the account cap gets the capped answer, never a
    // pretend extension.
    const beyond = await lease.renew(new Date(Date.now() + 6 * 3_600_000).toISOString());
    const capped = fixture.client.timeoutCalls.at(-1)!.timeoutMs;
    assert.ok(capped <= 3_600_000, String(capped));
    assert.ok(Date.parse(beyond.expiresAt!) <= Date.now() + 3_600_000 + 5_000);

    // A time in the past refuses; a released lease refuses.
    const past = await refuse(() =>
      lease.renew(new Date(Date.now() - 60_000).toISOString()),
    );
    assert.equal(past?.code, "InvalidRequest");
    await lease.release();
    const afterRelease = await refuse(() =>
      lease.renew(new Date(Date.now() + 60_000).toISOString()),
    );
    assert.equal(afterRelease?.code, "LeaseExpired");
  } finally {
    fixture.close();
  }
});

test("requirements this provider cannot satisfy reject before any spend", async () => {
  const fixture = make();
  try {
    const otherProvider = await refuse(() =>
      fixture.adapter.acquire(
        request("acq-wrong-provider", { providerId: "someone-else" }),
      ),
    );
    assert.equal(otherProvider?.code, "RequirementUnsatisfied");

    const wrongPlatform = await refuse(() =>
      fixture.adapter.acquire(request("acq-darwin", { platform: { os: "darwin" } })),
    );
    assert.equal(wrongPlatform?.code, "RequirementUnsatisfied");

    const missingCapability = await refuse(() =>
      fixture.adapter.acquire(
        request("acq-capability", { requires: { "exec.process@1": {} } }),
      ),
    );
    assert.equal(missingCapability?.code, "RequirementUnsatisfied");

    const unprovableMemory = await refuse(() =>
      fixture.adapter.acquire(
        request("acq-memory", {
          resources: { memoryBytes: { min: 64 * 1024 ** 3 } },
        }),
      ),
    );
    assert.equal(unprovableMemory?.code, "RequirementUnsatisfied");

    // Nothing was created and nothing was recorded.
    assert.equal(fixture.client.createCalls, 0);
    assert.deepEqual(fixture.adapter.allocations(), []);
  } finally {
    fixture.close();
  }
});

test("credentials resolve at use time and never persist", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "porta-e2b-"));
  const hadKey = process.env.E2B_API_KEY;
  delete process.env.E2B_API_KEY;
  try {
    const adapter = new E2BLinuxAdapter({ stateDir, client: new FakeE2BClient() });
    const refused = await refuse(() => adapter.acquire(request("acq-no-key")));
    assert.equal(refused?.code, "ProviderUnavailable");
    assert.ok(refused?.message.includes("E2B_API_KEY"));
    // Nothing was spent and nothing was recorded.
    assert.deepEqual(adapter.allocations(), []);
  } finally {
    if (hadKey !== undefined) {
      process.env.E2B_API_KEY = hadKey;
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Paid smoke test: runs only when a real key is configured. Covers the
// full lifecycle against the live provider (SPEC.md section 22).
test(
  "live lifecycle against E2B (requires E2B_API_KEY)",
  { skip: process.env.E2B_API_KEY === undefined },
  async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "porta-e2b-live-"));
    const adapter = new E2BLinuxAdapter({
      stateDir,
      client: new SdkE2BClient(),
      leaseTtlMs: 5 * 60_000,
    });
    try {
      const acquire = request(`acq-live-${randomUUID()}`);
      const lease = await adapter.acquire(acquire);
      const manifest = await lease.manifest();
      assertValid(environmentManifestSchema, manifest);
      assert.ok((manifest.resources?.cpuCount ?? 0) >= 1, "the provider reports cpus");
      assert.ok(
        (manifest.resources?.memoryBytes ?? 0) >= 256 * 1024 * 1024,
        "the provider reports memory",
      );
      assert.equal((await adapter.reconcile(acquire.acquisitionId)).state, "allocated");

      const renewed = await lease.renew(new Date(Date.now() + 10 * 60_000).toISOString());
      assert.equal(renewed.status, "active");

      const released = await lease.release();
      assert.equal(released.status, "released");
      assert.equal((await adapter.reconcile(acquire.acquisitionId)).state, "released");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
