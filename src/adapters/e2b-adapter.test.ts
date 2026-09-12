import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuthorizedAcquireRequest, EnvironmentLease } from "../schema/adapter.js";
import type { AcquisitionLimits } from "../schema/policy.js";
import { environmentManifestSchema } from "../schema/capability.js";
import { assertValid } from "../schema/validate.js";
import { PolicyAuthority } from "../core/policy.js";
import { scanTreeFromDirectory } from "../store/workspace-tree.js";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { SessionEventStream } from "../store/event-stream.js";
import { PortableRuntime } from "../runtime/session.js";
import { checkpointWorkspace } from "../runtime/workspace.js";
import {
  E2B_LINUX_PROVIDER_ID,
  E2BLinuxAdapter,
  SdkE2BClient,
} from "./e2b-adapter.js";
import type {
  E2BClient,
  E2BPushReport,
  E2BSandboxInfo,
  E2BSandboxSession,
  E2BTransferLimits,
} from "./e2b-adapter.js";

/**
 * In-memory provider. The fake models the parts of E2B the adapter
 * relies on: metadata-tagged creation, metadata-filtered listing,
 * identifier-based inspection, timeout, and kill, plus one connected
 * session per sandbox with a file tree and a process table.
 */
class FakeE2BClient implements E2BClient {
  readonly sandboxes = new Map<
    string,
    {
      info: E2BSandboxInfo;
      metadata: Record<string, string>;
      /** That sandbox's file bytes by absolute path. */
      files: Map<string, Uint8Array>;
      /** That sandbox's made directories by absolute path. */
      madeDirs: string[];
      /**
       * That sandbox's permission bits by absolute path. Writes land
       * under `defaultFileMode`, so a test can model a restrictive
       * creation mask.
       */
      modes: Map<string, number>;
      /** Mode a fresh write takes, like a provider creation mask. */
      defaultFileMode: number;
      /**
       * Entries the provider lists but a portable tree cannot
       * represent, by absolute path: links and special files.
       */
      specials: Map<string, "link" | "other">;
      /** That sandbox's processes by pid. */
      processes: Map<
        number,
        { pid: number; command: string; cwd: string; envs: Record<string, string>; running: boolean }
      >;
    }
  >();
  /** Every foreground command a session ran, newest last. */
  readonly commandsRun: Array<{
    command: string;
    cwd: string;
    envs: Record<string, string>;
    timeoutMs: number;
    stdin?: string;
  }> = [];
  /** Every file write a session made, newest last. */
  readonly fileWrites: Array<{ path: string; bytes: number }> = [];
  /** Every permission change a session made, newest last. */
  readonly permissionCalls: Array<{ path: string; mode: number }> = [];
  /** Every rename a session made, newest last. */
  readonly renameCalls: Array<{ from: string; to: string }> = [];
  /** Every removal a session made, newest last. */
  readonly removeCalls: Array<{ path: string }> = [];
  /**
   * Scripted provider faults by call position: the Nth rename or
   * remove attempt throws, after the attempt is recorded. Undefined
   * never fires.
   */
  failOn: { renameAt?: number; removeAt?: number } = {};
  /**
   * Deterministic concurrency barrier: hold every file write whose
   * path contains this fragment until `releaseHeld()` runs. The
   * promise under `holdArrived` resolves when the first held write
   * arrives.
   */
  holdWritesMatching: string | null = null;
  private heldArrivedResolve: (() => void) | null = null;
  private held: Array<() => void> = [];
  /** Arm the write barrier and return the promise of its first hit. */
  holdWritesContaining(fragment: string): Promise<void> {
    this.holdWritesMatching = fragment;
    return new Promise<void>((resolve) => {
      this.heldArrivedResolve = resolve;
    });
  }
  /** Release every held write barrier. */
  releaseHeld(): void {
    for (const resolve of this.held) {
      resolve();
    }
    this.held = [];
  }
  /** Scripted outcome of the next foreground command. */
  nextRun: {
    exitCode: number | null;
    timedOut?: boolean;
    stdout?: string[];
    stderr?: string[];
  } | null = null;
  connectCalls = 0;
  createCalls = 0;
  /** The internet flag every create call received, newest last. */
  readonly internetFlags: boolean[] = [];
  killCalls = 0;
  readonly timeoutCalls: Array<{ sandboxId: string; timeoutMs: number }> = [];
  /** Throw after registering: the sandbox exists but the reply is lost. */
  loseCreateResponse = false;
  /** Throw before registering: the create never landed. */
  dropCreateRequest = false;
  failGetInfo = false;
  failKill = false;

  /** The mutable remote state of one sandbox, for test staging. */
  sandbox(sandboxId: string) {
    const entry = this.sandboxes.get(sandboxId);
    if (entry === undefined) {
      throw new Error(`no such sandbox: ${sandboxId}`);
    }
    return entry;
  }

  async connect(sandboxId: string, apiKey: string): Promise<E2BSandboxSession> {
    void apiKey;
    if (!this.sandboxes.has(sandboxId)) {
      throw new Error("sandbox not found");
    }
    this.connectCalls += 1;
    return this.session(this.sandbox(sandboxId));
  }

  /** One session over that sandbox's file tree and process table. */
  private session(state: {
    files: Map<string, Uint8Array>;
    madeDirs: string[];
    modes: Map<string, number>;
    defaultFileMode: number;
    specials: Map<string, "link" | "other">;
    processes: Map<
      number,
      { pid: number; command: string; cwd: string; envs: Record<string, string>; running: boolean }
    >;
  }): E2BSandboxSession {
    const client = this;
    return {
      async runCommand(input) {
        client.commandsRun.push({
          command: input.command,
          cwd: input.cwd,
          envs: input.envs,
          timeoutMs: input.timeoutMs,
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        });
        const scripted = client.nextRun;
        for (const chunk of scripted?.stdout ?? []) {
          await input.onStdout?.(chunk);
        }
        for (const chunk of scripted?.stderr ?? []) {
          await input.onStderr?.(chunk);
        }
        if (scripted?.timedOut === true) {
          return { exitCode: null, timedOut: true };
        }
        return { exitCode: scripted?.exitCode ?? 0, timedOut: false };
      },
      async startCommand(input) {
        const pid = 9000 + state.processes.size + 1;
        state.processes.set(pid, {
          pid,
          command: input.command,
          cwd: input.cwd,
          envs: input.envs,
          running: true,
        });
        return { pid };
      },
      async killCommand(pid) {
        const command = state.processes.get(pid);
        if (command === undefined) {
          return false;
        }
        command.running = false;
        return true;
      },
      async runningCommandPids() {
        return [...state.processes.values()]
          .filter((command) => command.running)
          .map((command) => command.pid);
      },
      async readFile(path) {
        const bytes = state.files.get(path);
        if (bytes === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return bytes;
      },
      async writeFile(path, bytes) {
        const hold = client.holdWritesMatching;
        if (hold !== null && path.includes(hold)) {
          if (client.heldArrivedResolve !== null) {
            const resolve = client.heldArrivedResolve;
            client.heldArrivedResolve = null;
            resolve();
          }
          await new Promise<void>((resolve) => client.held.push(resolve));
        }
        client.fileWrites.push({ path, bytes: bytes.byteLength });
        state.files.set(path, bytes);
        state.modes.set(path, state.defaultFileMode);
      },
      async setPermissions(path, mode) {
        client.permissionCalls.push({ path, mode });
        state.modes.set(path, mode);
      },
      async listDir(path) {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const exists =
          path === "/" ||
          state.files.has(path) ||
          state.specials.has(path) ||
          [...state.files.keys()].some((key) => key.startsWith(prefix)) ||
          [...state.specials.keys()].some((key) => key.startsWith(prefix)) ||
          state.madeDirs.some((dir) => dir === path || dir.startsWith(prefix));
        if (!exists) {
          return null;
        }
        const names = new Map<string, { type: "file" | "directory" | "link" | "other"; mode?: number }>();
        const fold = (key: string, kind: "file" | "directory" | "link" | "other") => {
          if (key === path || !key.startsWith(prefix)) {
            return;
          }
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf("/");
          names.set(slash === -1 ? rest : rest.slice(0, slash), {
            type: slash === -1 ? kind : "directory",
            ...(slash === -1 && kind === "file" && state.modes.has(key)
              ? { mode: state.modes.get(key) as number }
              : {}),
          });
        };
        for (const key of state.files.keys()) {
          fold(key, "file");
        }
        for (const dir of state.madeDirs) {
          fold(dir, "directory");
        }
        for (const [key, kind] of state.specials) {
          fold(key, kind);
        }
        return [...names.entries()].map(([name, described]) => ({ name, ...described }));
      },
      async makeDir(path) {
        state.madeDirs.push(path);
      },
      async exists(path) {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        return (
          state.files.has(path) ||
          state.specials.has(path) ||
          state.madeDirs.includes(path) ||
          [...state.files.keys()].some((key) => key.startsWith(prefix)) ||
          [...state.specials.keys()].some((key) => key.startsWith(prefix)) ||
          state.madeDirs.some((dir) => dir === path || dir.startsWith(prefix))
        );
      },
      async rename(fromPath, toPath) {
        client.renameCalls.push({ from: fromPath, to: toPath });
        if (client.failOn.renameAt === client.renameCalls.length) {
          throw new Error("rename failed (scripted)");
        }
        const prefix = `${fromPath}/`;
        // Bytes, modes, and specials move with their names; so do made
        // directories at and under the source.
        for (const key of [...state.files.keys()]) {
          if (key === fromPath || key.startsWith(prefix)) {
            const next =
              key === fromPath ? toPath : `${toPath}/${key.slice(prefix.length)}`;
            state.files.set(next, state.files.get(key)!);
            state.files.delete(key);
            const mode = state.modes.get(key);
            if (mode !== undefined) {
              state.modes.set(next, mode);
              state.modes.delete(key);
            }
          }
        }
        for (const key of [...state.specials.keys()]) {
          if (key === fromPath || key.startsWith(prefix)) {
            const next =
              key === fromPath ? toPath : `${toPath}/${key.slice(prefix.length)}`;
            state.specials.set(next, state.specials.get(key)!);
            state.specials.delete(key);
          }
        }
        state.madeDirs = state.madeDirs.flatMap((dir) => {
          if (dir === fromPath) {
            return [toPath];
          }
          if (dir.startsWith(prefix)) {
            return [`${toPath}/${dir.slice(prefix.length)}`];
          }
          return [dir];
        });
      },
      async remove(path) {
        client.removeCalls.push({ path });
        if (client.failOn.removeAt === client.removeCalls.length) {
          throw new Error("remove failed (scripted)");
        }
        const prefix = `${path}/`;
        for (const key of [...state.files.keys()]) {
          if (key === path || key.startsWith(prefix)) {
            state.files.delete(key);
            state.modes.delete(key);
          }
        }
        for (const key of [...state.specials.keys()]) {
          if (key === path || key.startsWith(prefix)) {
            state.specials.delete(key);
          }
        }
        state.madeDirs = state.madeDirs.filter(
          (dir) => dir !== path && !dir.startsWith(prefix),
        );
      },
    };
  }

  async create(input: {
    template: string;
    timeoutMs: number;
    metadata: Record<string, string>;
    apiKey: string;
    allowInternetAccess: boolean;
  }): Promise<{ sandboxId: string }> {
    void input.apiKey;
    if (this.dropCreateRequest) {
      throw new Error("network unreachable");
    }
    this.createCalls += 1;
    this.internetFlags.push(input.allowInternetAccess);
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
      files: new Map(),
      madeDirs: [],
      modes: new Map(),
      defaultFileMode: 0o644,
      specials: new Map(),
      processes: new Map(),
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
  reopen(options?: { allowInternetAccess?: boolean }): E2BLinuxAdapter;
  close(): void;
}

function make(
  options: { client?: FakeE2BClient; allowInternetAccess?: boolean } = {},
): Fixture {
  const stateDir = mkdtempSync(join(tmpdir(), "porta-e2b-"));
  const client = options.client ?? new FakeE2BClient();
  const build = (reopenOptions: { allowInternetAccess?: boolean } = {}) =>
    new E2BLinuxAdapter({
      stateDir,
      client,
      apiKey: "e2b_test_key",
      allowInternetAccess:
        reopenOptions.allowInternetAccess ?? options.allowInternetAccess ?? true,
    });
  return {
    adapter: build(),
    client,
    stateDir,
    reopen: (reopenOptions) => build(reopenOptions),
    close: () => rmSync(stateDir, { recursive: true, force: true }),
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

function request(
  acquisitionId = `acq-${randomUUID()}`,
  overrides: Partial<AuthorizedAcquireRequest["request"]> = {},
  limits: AcquisitionLimits = LIMITS,
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
    limits,
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
    // The process contract is offered with the attributes the transport
    // honestly provides — SIGKILL only, no descendant reach, text output.
    assert.equal(manifest.capabilities.length, 1);
    assert.equal(manifest.capabilities[0]!.id, "exec.process@1");
    assert.deepEqual(manifest.capabilities[0]!.attributes, DECLARED_ATTRIBUTES);
    assert.deepEqual(manifest.resources, { cpuCount: 2, memoryBytes: 2048 * 1024 * 1024 });
    assert.equal(manifest.providerRuntimeVersion, "0.2.1");
    const enforcement = manifest.enforcement as Record<string, unknown>;
    assert.equal(enforcement.sandboxId, "sbx-1");
    assert.equal(enforcement.sandboxTemplate, "base");
    assert.equal(enforcement.isolation, "firecracker-microvm");
    assert.equal(enforcement.releaseSemantics, "kill-discards-state");

    // Discovery offers the same contract, with the same honesty.
    const offers = await fixture.adapter.describe();
    assert.equal(offers.length, 1);
    assert.equal(offers[0]!.providerId, E2B_LINUX_PROVIDER_ID);
    assert.equal(offers[0]!.capabilities[0]!.id, "exec.process@1");
    assert.deepEqual(offers[0]!.capabilities[0]!.attributes, DECLARED_ATTRIBUTES);
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

    const unsatisfiedProfile = await refuse(() =>
      fixture.adapter.acquire(
        request("acq-capability", {
          requires: {
            "exec.process@1": { signals: { equals: ["SIGTERM", "SIGKILL"] } },
          },
        }),
      ),
    );
    assert.equal(unsatisfiedProfile?.code, "RequirementUnsatisfied");

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

test("the network setting reaches creation and policy narrows it", async () => {
  const blocked = { ...LIMITS, networkEgress: "none" as const };
  const allowlist = { ...LIMITS, networkEgress: "allowlist" as const };
  const open = make();
  const blockedAdapter = make({ allowInternetAccess: false });
  const narrowed = make();
  const listed = make();
  try {
    // Operator default, unrestricted policy: the flag crosses as true.
    await open.adapter.acquire(request("acq-open"));
    await blockedAdapter.adapter.acquire(request("acq-operator-blocked"));
    // A restrictive policy forces a blocked sandbox even when the
    // operator default allows internet.
    await narrowed.adapter.acquire(request("acq-narrowed", {}, blocked));

    assert.deepEqual(open.client.internetFlags, [true]);
    assert.deepEqual(blockedAdapter.client.internetFlags, [false]);
    assert.deepEqual(narrowed.client.internetFlags, [false]);

    // E2B exposes no origin allowlist; approximating one with either
    // boolean would lie, so the acquisition refuses before any spend.
    const refused = await refuse(() =>
      listed.adapter.acquire(request("acq-allowlist", {}, allowlist)),
    );
    assert.equal(refused?.code, "PolicyDenied");
    assert.match(String(refused?.message), /allowlist/i);
    assert.equal(listed.client.createCalls, 0);
  } finally {
    open.close();
    blockedAdapter.close();
    narrowed.close();
    listed.close();
  }
});

test("the manifest reports the recorded network setting, not later defaults", async () => {
  const blocked = { ...LIMITS, networkEgress: "none" as const };
  const fixture = make();
  try {
    const lease = await fixture.adapter.acquire(request("acq-recorded", {}, blocked));
    const recorded = fixture.adapter.manifestOf(lease.environmentId);
    assert.equal(recorded.enforcement.networkEgress, "blocked");
    assert.equal(recorded.enforcementFacts?.networkEgress, "none");

    // A fresh adapter instance with a permissive default cannot relabel
    // an allocation the record says is blocked.
    const reopened = fixture.reopen({ allowInternetAccess: true });
    const reread = reopened.manifestOf(lease.environmentId);
    assert.equal(reread.enforcement.networkEgress, "blocked");
    assert.equal(reread.enforcementFacts?.networkEgress, "none");

    // A record from before the setting existed was created with the
    // provider default: it has internet, and no later default may
    // claim otherwise. Provider inspection cannot prove the setting,
    // so the record is the only evidence.
    const statePath = join(
      fixture.stateDir,
      "acquisitions",
      "acq-legacy.json",
    );
    const legacy = {
      acquisitionId: "acq-legacy",
      environmentId: "env-e2b-legacy",
      sandboxId: null,
      template: "base",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    writeFileSync(statePath, JSON.stringify(legacy));
    const blockedReopen = fixture.reopen({ allowInternetAccess: false });
    const legacyManifest = blockedReopen.manifestOf("env-e2b-legacy");
    assert.equal(legacyManifest.enforcement.networkEgress, "internet-allowed");
    assert.equal(legacyManifest.enforcementFacts?.networkEgress, "unrestricted");
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

/** One process invocation through a lease, for brevity in tests. */
async function invoke(
  lease: Pick<EnvironmentLease, "invoke" | "environmentId">,
  operationId: string,
  operation: string,
  input: unknown,
): Promise<{ status: string; result?: unknown }> {
  return lease.invoke({
    operationId,
    capability: "exec.process@1",
    operation,
    input,
    environmentId: lease.environmentId,
    limits: {},
  });
}

/** A policy that allows both transfer destinations. */
const REMOTE_AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["local", "remote"],
});

/** A policy that allows local transfers only. */
const LOCAL_AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["local"],
});

/** A policy that allows remote transfers only. */
const REMOTE_ONLY_AUTHORITY = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["remote"],
});

/** The attributes every process declaration of this adapter carries. */
const DECLARED_ATTRIBUTES = {
  argumentForm: "array",
  shellInterpretation: "explicit-executable-only",
  signals: ["SIGKILL"],
  descendantTermination: "none",
  binaryOutput: false,
  processLifetime: "attachment",
};

test("run sends an exact argument array and reports streams and outcomes", async () => {
  const fixture = make();
  try {
    const lease = await fixture.adapter.acquire(request("acq-run"));
    fixture.client.nextRun = { exitCode: 0, stdout: ["hello ", "remote"], stderr: ["warn"] };
    const run = await invoke(lease, "op-run-1", "run", {
      command: "echo",
      args: ["a b", "$HOME", "it's"],
      env: { PORTABLE_TEST: "1" },
      stdin: "hello",
    });
    assert.equal(run.status, "completed");
    // The transport takes one shell-parsed string, so the adapter quotes
    // every argument itself: no splitting, no interpolation, no glob.
    const seen = fixture.client.commandsRun[0]!;
    assert.equal(seen.command, `'echo' 'a b' '$HOME' 'it'\\''s'`);
    assert.equal(seen.cwd, "/home/user/portable");
    assert.equal(seen.envs.PORTABLE_TEST, "1");
    assert.equal(seen.stdin, "hello");
    // The adapter states one hour; the provider default is sixty seconds.
    assert.equal(seen.timeoutMs, 3_600_000);
    const result = run.result as {
      exitCode?: number;
      timedOut: boolean;
      stdout: { dataBase64?: string; byteLength: number; truncated: boolean };
      stderr: { dataBase64?: string; byteLength: number; truncated: boolean };
      startedAt: string;
      endedAt: string;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(Buffer.from(result.stdout.dataBase64 ?? "", "base64").toString("utf8"), "hello remote");
    assert.equal(Buffer.from(result.stderr.dataBase64 ?? "", "base64").toString("utf8"), "warn");
    assert.ok(Date.parse(result.startedAt) <= Date.parse(result.endedAt));

    // A non-zero exit is an outcome, not a fault.
    fixture.client.nextRun = { exitCode: 3 };
    const failed = await invoke(lease, "op-run-2", "run", { command: "false" });
    assert.equal((failed.result as { exitCode?: number }).exitCode, 3);

    // A timeout ends as SIGKILL, with no invented exit code.
    fixture.client.nextRun = { exitCode: null, timedOut: true };
    const timed = await invoke(lease, "op-run-3", "run", { command: "sleep", args: ["10"] });
    const timedResult = timed.result as { exitCode?: number; signal?: string; timedOut: boolean };
    assert.equal(timedResult.exitCode, undefined);
    assert.equal(timedResult.signal, "SIGKILL");
    assert.equal(timedResult.timedOut, true);

    // Bytes past the capture cap drop with a flag and a count.
    fixture.client.nextRun = { exitCode: 0, stdout: ["abcdefghij"] };
    const truncated = await invoke(lease, "op-run-4", "run", {
      command: "yes",
      outputLimits: { maxBytesPerStream: 4 },
    });
    const cut = (truncated.result as { stdout: { dataBase64?: string; byteLength: number; truncated: boolean; omittedBytes?: number } }).stdout;
    assert.equal(Buffer.from(cut.dataBase64 ?? "", "base64").toString("utf8"), "abcd");
    assert.equal(cut.byteLength, 4);
    assert.equal(cut.truncated, true);
    assert.equal(cut.omittedBytes, 6);

    // A shared total budget spans both streams.
    fixture.client.nextRun = { exitCode: 0, stdout: ["abc"], stderr: ["xyz"] };
    const shared = await invoke(lease, "op-run-5", "run", {
      command: "both",
      outputLimits: { maxTotalBytes: 5 },
    });
    const sharedResult = shared.result as {
      stdout: { byteLength: number };
      stderr: { byteLength: number; truncated: boolean; omittedBytes?: number };
    };
    assert.equal(sharedResult.stdout.byteLength, 3);
    assert.equal(sharedResult.stderr.byteLength, 2);
    assert.equal(sharedResult.stderr.truncated, true);
    assert.equal(sharedResult.stderr.omittedBytes, 1);
  } finally {
    fixture.close();
  }
});

test("run refuses what the declared profile does not offer", async () => {
  const fixture = make();
  try {
    const lease = await fixture.adapter.acquire(request("acq-refuse"));
    // A working directory outside the copy refuses without hostAccess.
    const escape = await refuse(() =>
      invoke(lease, "op-escape", "run", { command: "ls", cwd: "/etc" }),
    );
    assert.equal(escape?.code, "InvalidRequest");
    assert.equal((escape?.details as { reason?: string } | undefined)?.reason, "working-directory-escape");
    // The same path with hostAccess reaches the provider.
    fixture.client.nextRun = { exitCode: 0 };
    const allowed = await invoke(lease, "op-allowed", "run", {
      command: "ls",
      cwd: "/etc",
      hostAccess: true,
    });
    assert.equal(allowed.status, "completed");
    // Binary standard input refuses: the transport carries UTF-8 text.
    const binary = await refuse(() =>
      invoke(lease, "op-binary", "run", { command: "cat", stdin: "//4", stdinEncoding: "base64" }),
    );
    assert.equal(binary?.code, "InvalidRequest");
    // A NUL byte cannot cross an argument.
    const nul = await refuse(() =>
      invoke(lease, "op-nul", "run", { command: "echo", args: ["a\0b"] }),
    );
    assert.equal(nul?.code, "InvalidRequest");
    // Another capability is not this adapter's contract.
    const wrong = await refuse(() =>
      lease.invoke({
        operationId: "op-wrong",
        capability: "fs.workspace@1",
        operation: "read",
        input: {},
        environmentId: lease.environmentId,
        limits: {},
      }),
    );
    assert.equal(wrong?.code, "UnsupportedOperation");
    const unknownOperation = await refuse(() => invoke(lease, "op-dance", "dance", {}));
    assert.equal(unknownOperation?.code, "UnsupportedOperation");
    // Only the allowed run reached the provider.
    assert.equal(fixture.client.commandsRun.length, 1);
  } finally {
    fixture.close();
  }
});

test("background processes live in durable records and stop on declared signals", async () => {
  const fixture = make();
  try {
    const lease = await fixture.adapter.acquire(request("acq-start"));
    const started = await invoke(lease, "op-start-1", "start", {
      command: "sleep",
      args: ["600"],
    });
    assert.equal(started.status, "completed");
    const start = started.result as {
      resourceId: string;
      providerProcessId: string;
      startedAt: string;
    };
    assert.ok(start.resourceId.startsWith("proc-"));
    assert.equal(start.providerProcessId, "9001");
    assert.ok(Date.parse(start.startedAt) > 0);

    // Liveness reads the provider process table.
    const running = await invoke(lease, "op-ins-1", "inspect", { resourceId: start.resourceId });
    assert.equal((running.result as { state: string }).state, "running");

    // SIGTERM is not declared here; the refusal names what is.
    const refused = await refuse(() =>
      invoke(lease, "op-term-1", "terminate", { resourceId: start.resourceId, signal: "SIGTERM" }),
    );
    assert.equal(refused?.code, "InvalidRequest");
    assert.deepEqual(
      (refused?.details as { declared?: string[] } | undefined)?.declared,
      ["SIGKILL"],
    );

    // SIGKILL is declared, and confirmation comes from the table.
    const stopped = await invoke(lease, "op-term-2", "terminate", { resourceId: start.resourceId });
    assert.deepEqual(stopped.result, {
      resourceId: start.resourceId,
      confirmed: true,
      descendantsStopped: false,
      signal: "SIGKILL",
      state: "terminated",
    });
    const after = await invoke(lease, "op-ins-2", "inspect", { resourceId: start.resourceId });
    assert.equal((after.result as { state: string }).state, "terminated");

    // A restarted adapter answers from the durable record.
    const reopened = fixture.reopen();
    const across = await invoke(reopened.lease(lease.environmentId), "op-ins-3", "inspect", {
      resourceId: start.resourceId,
    });
    assert.equal((across.result as { state: string }).state, "terminated");
    const remembered = await reopened.lease(lease.environmentId).inspect("op-start-1");
    assert.equal(remembered.status, "completed");
    assert.equal(
      (remembered.result as { resourceId: string }).resourceId,
      start.resourceId,
    );

    // Cancellation reaches the process and states its limits.
    const second = await invoke(lease, "op-start-2", "start", { command: "sleep", args: ["600"] });
    const cancel = await lease.cancel("op-start-2");
    assert.equal(cancel.outcome, "confirmed");
    assert.equal(cancel.stopped, true);
    assert.equal(cancel.descendantsStopped, false);
    assert.equal((await lease.cancel("op-start-2")).outcome, "confirmed");
    assert.equal((await lease.cancel("op-nothing")).outcome, "unsupported");
    assert.equal(second.status, "completed");

    // A process the provider already reaped terminated as exited.
    const third = await invoke(lease, "op-start-3", "start", { command: "true", args: [] });
    const thirdResource = (third.result as { resourceId: string }).resourceId;
    fixture.client.sandbox("sbx-1").processes.delete(9003);
    const reaped = await invoke(lease, "op-term-3", "terminate", { resourceId: thirdResource });
    assert.deepEqual(reaped.result, {
      resourceId: thirdResource,
      confirmed: true,
      descendantsStopped: false,
      signal: "SIGKILL",
      state: "exited",
    });
    const unknown = await refuse(() =>
      invoke(lease, "op-ins-x", "inspect", { resourceId: "proc-none" }),
    );
    assert.equal(unknown?.code, "InvalidRequest");
  } finally {
    fixture.close();
  }
});

test("push validates policy, hashes, and limits before any byte crosses", async () => {
  const fixture = make();
  const staging = mkdtempSync(join(tmpdir(), "porta-push-"));
  try {
    mkdirSync(join(staging, "sub"));
    writeFileSync(join(staging, "app.txt"), "alpha");
    writeFileSync(join(staging, "sub", "lib.txt"), "beta");
    const lease = await fixture.adapter.acquire(request("acq-push"));
    const tree = scanTreeFromDirectory(staging);
    const push = (authority = REMOTE_AUTHORITY, limits?: E2BTransferLimits) =>
      fixture.adapter.pushCopy({
        environmentId: lease.environmentId,
        copyRoot: staging,
        entries: tree.entries,
        authority,
        ...(limits !== undefined ? { limits } : {}),
      });

    // Destination policy is denied before anything is spent.
    const denied = await refuse(() => push(LOCAL_AUTHORITY));
    assert.equal(denied?.code, "PolicyDenied");
    assert.equal(fixture.client.connectCalls, 0);

    // A copy that changed after authorization never crosses as trusted.
    writeFileSync(join(staging, "app.txt"), "tampered");
    const integrity = await refuse(() => push());
    assert.equal(integrity?.code, "IntegrityFailure");
    assert.equal(fixture.client.connectCalls, 0);
    writeFileSync(join(staging, "app.txt"), "alpha");

    // Authorized ceilings refuse before the connection.
    const limited = await refuse(() => push(REMOTE_AUTHORITY, { maxTotalBytes: 3 }));
    assert.equal(limited?.code, "InvalidRequest");
    assert.equal(fixture.client.connectCalls, 0);

    // The push lands under the portable root.
    const report: E2BPushReport = await push();
    assert.equal(report.filesSent, 2);
    assert.equal(report.bytesSent, 9);
    assert.equal(report.remoteRoot, "/home/user/portable");
    assert.equal(report.rootHash, tree.rootHash);
    const decoder = new TextDecoder();
    assert.equal(decoder.decode(fixture.client.sandbox("sbx-1").files.get("/home/user/portable/app.txt")!), "alpha");
    assert.equal(decoder.decode(fixture.client.sandbox("sbx-1").files.get("/home/user/portable/sub/lib.txt")!), "beta");
    assert.ok(fixture.client.sandbox("sbx-1").madeDirs.includes("/home/user/portable/sub"));
    // Provenance persists in the acquisition record.
    assert.equal(
      fixture.adapter.allocations().find((record) => record.acquisitionId === "acq-push")
        ?.lastPush?.rootHash,
      tree.rootHash,
    );
  } finally {
    fixture.close();
    rmSync(staging, { recursive: true, force: true });
  }
});

test("pull rebuilds the remote tree through the content-addressed store", async () => {
  const fixture = make();
  const staging = mkdtempSync(join(tmpdir(), "porta-pull-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-blobs-"));
  const harvest = mkdtempSync(join(tmpdir(), "porta-harvest-"));
  const encoder = new TextEncoder();
  try {
    mkdirSync(join(staging, "sub"));
    writeFileSync(join(staging, "app.txt"), "alpha");
    writeFileSync(join(staging, "sub", "lib.txt"), "beta");
    const lease = await fixture.adapter.acquire(request("acq-pull"));
    const tree = scanTreeFromDirectory(staging);
    const report = await fixture.adapter.pushCopy({
      environmentId: lease.environmentId,
      copyRoot: staging,
      entries: tree.entries,
      authority: REMOTE_AUTHORITY,
    });
    const store = ControlStore.inMemory();
    const blobs = new BlobStore(blobRoot, store);

    // A round trip with no mutation hashes back to the same root.
    const round = await fixture.adapter.pullCopy({
      environmentId: lease.environmentId,
      destRoot: harvest,
      blobs,
      authority: REMOTE_AUTHORITY,
      expectedRootHash: report.rootHash,
    });
    assert.equal(round.rootHash, report.rootHash);
    assert.equal(readFileSync(join(harvest, "app.txt"), "utf8"), "alpha");
    assert.equal(readFileSync(join(harvest, "sub", "lib.txt"), "utf8"), "beta");
    for (const ref of round.blobRefs) {
      assert.ok(
        existsSync(join(blobRoot, "objects", ref.digest.slice(0, 2), ref.digest)),
        `blob ${ref.digest} stored`,
      );
    }

    // A remote mutation changes the tree; an expected hash refuses it.
    fixture.client.sandbox("sbx-1").files.set("/home/user/portable/app.txt", encoder.encode("changed"));
    const mismatch = await refuse(() =>
      fixture.adapter.pullCopy({
        environmentId: lease.environmentId,
        destRoot: harvest,
        blobs,
        authority: REMOTE_AUTHORITY,
        expectedRootHash: report.rootHash,
      }),
    );
    assert.equal(mismatch?.code, "IntegrityFailure");
    const fresh = await fixture.adapter.pullCopy({
      environmentId: lease.environmentId,
      destRoot: harvest,
      blobs,
      authority: REMOTE_AUTHORITY,
    });
    assert.notEqual(fresh.rootHash, report.rootHash);
    assert.equal(readFileSync(join(harvest, "app.txt"), "utf8"), "changed");

    // A remote-only policy denies the harvest: the destination is the
    // local store.
    const denied = await refuse(() =>
      fixture.adapter.pullCopy({
        environmentId: lease.environmentId,
        destRoot: harvest,
        blobs,
        authority: REMOTE_ONLY_AUTHORITY,
      }),
    );
    assert.equal(denied?.code, "PolicyDenied");

    // Limits refuse before the staging root is touched.
    const before = readFileSync(join(harvest, "app.txt"), "utf8");
    const limited = await refuse(() =>
      fixture.adapter.pullCopy({
        environmentId: lease.environmentId,
        destRoot: harvest,
        blobs,
        authority: REMOTE_AUTHORITY,
        limits: { maxTotalBytes: 1 },
      }),
    );
    assert.equal(limited?.code, "InvalidRequest");
    assert.equal(readFileSync(join(harvest, "app.txt"), "utf8"), before);

    // An environment with nothing pushed refuses with guidance.
    const empty = await fixture.adapter.acquire(request("acq-empty-copy"));
    const none = await refuse(() =>
      fixture.adapter.pullCopy({
        environmentId: empty.environmentId,
        destRoot: harvest,
        blobs,
        authority: REMOTE_AUTHORITY,
      }),
    );
    assert.equal(none?.code, "InvalidRequest");
  } finally {
    fixture.close();
    rmSync(staging, { recursive: true, force: true });
    rmSync(blobRoot, { recursive: true, force: true });
    rmSync(harvest, { recursive: true, force: true });
  }
});

test("a round trip preserves executable bits and entry kinds exactly", async () => {
  const fixture = make();
  const staging = mkdtempSync(join(tmpdir(), "porta-bits-src-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-bits-blobs-"));
  const harvest = mkdtempSync(join(tmpdir(), "porta-bits-out-"));
  try {
    mkdirSync(join(staging, "nested"));
    mkdirSync(join(staging, "empty-dir"));
    writeFileSync(join(staging, "plain.txt"), "plain");
    writeFileSync(join(staging, "run.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(staging, "nested", "tool"), Buffer.from([0x00, 0xff, 0x7f, 0x01]));
    writeFileSync(join(staging, "nested", "ünïcode.txt"), "grüß dich");
    chmodSync(join(staging, "run.sh"), 0o755);
    chmodSync(join(staging, "nested", "tool"), 0o700);

    const lease = await fixture.adapter.acquire(request("acq-bits"));
    // A restrictive provider creation mask must not leak into the tree:
    // every fresh write lands as 0o600 until the transfer sets the
    // canonical modes itself.
    fixture.client.sandbox("sbx-1").defaultFileMode = 0o600;
    const report = await fixture.adapter.pushCopy({
      environmentId: lease.environmentId,
      copyRoot: staging,
      entries: scanTreeFromDirectory(staging).entries,
      authority: REMOTE_AUTHORITY,
    });

    // The remote side holds the canonical portable modes, whatever the
    // provider mask did to the fresh writes.
    const remote = fixture.client.sandbox("sbx-1");
    assert.equal(remote.modes.get("/home/user/portable/run.sh"), 0o755);
    assert.equal(remote.modes.get("/home/user/portable/plain.txt"), 0o644);
    assert.equal(remote.modes.get("/home/user/portable/nested/tool"), 0o755);
    assert.ok(
      fixture.client.permissionCalls.some(
        (call) => call.path.endsWith("/run.sh") && call.mode === 0o755,
      ),
      "the executable file received an explicit permission call",
    );

    const store = ControlStore.inMemory();
    const blobs = new BlobStore(blobRoot, store);
    const round = await fixture.adapter.pullCopy({
      environmentId: lease.environmentId,
      destRoot: harvest,
      blobs,
      authority: REMOTE_AUTHORITY,
      expectedRootHash: report.rootHash,
    });
    // The imported tree is the pushed tree: the same root hash and the
    // same bits, without the local umask deciding anything.
    assert.equal(round.rootHash, report.rootHash);
    assert.equal(statSync(join(harvest, "run.sh")).mode & 0o777, 0o755);
    assert.equal(statSync(join(harvest, "plain.txt")).mode & 0o777, 0o644);
    assert.equal(statSync(join(harvest, "nested", "tool")).mode & 0o777, 0o755);
    assert.equal(
      readFileSync(join(harvest, "nested", "tool")).toString("hex"),
      "00ff7f01",
    );
    assert.equal(readFileSync(join(harvest, "nested", "ünïcode.txt"), "utf8"), "grüß dich");
    assert.equal(statSync(join(harvest, "empty-dir")).isDirectory(), true);
  } finally {
    fixture.close();
    rmSync(staging, { recursive: true, force: true });
    rmSync(blobRoot, { recursive: true, force: true });
    rmSync(harvest, { recursive: true, force: true });
  }
});

test("remote links and special entries refuse before they are followed", async () => {
  const fixture = make();
  const staging = mkdtempSync(join(tmpdir(), "porta-refuse-src-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-refuse-blobs-"));
  const harvest = mkdtempSync(join(tmpdir(), "porta-refuse-out-"));
  let lease: EnvironmentLease | undefined;
  let blobs: BlobStore | undefined;
  const pull = () =>
    fixture.adapter.pullCopy({
      environmentId: lease!.environmentId,
      destRoot: harvest,
      blobs: blobs!,
      authority: REMOTE_AUTHORITY,
    });
  try {
    writeFileSync(join(staging, "keep.txt"), "kept");
    lease = await fixture.adapter.acquire(request("acq-specials"));
    await fixture.adapter.pushCopy({
      environmentId: lease.environmentId,
      copyRoot: staging,
      entries: scanTreeFromDirectory(staging).entries,
      authority: REMOTE_AUTHORITY,
    });
    blobs = new BlobStore(blobRoot, ControlStore.inMemory());
    const remote = fixture.client.sandbox("sbx-1");

    // A link the provider lists refuses with its kind named; the
    // transfer never reads through it.
    remote.specials.set("/home/user/portable/secret-link", "link");
    const link = await refuse(pull);
    assert.equal(link?.code, "UnsupportedOperation");
    const linkDetails = link?.details as Record<string, unknown> | undefined;
    assert.equal(linkDetails?.operation, "remote-link");
    assert.equal(linkDetails?.path, "secret-link");

    // A device or socket refuses the same way.
    remote.specials.delete("/home/user/portable/secret-link");
    remote.specials.set("/home/user/portable/device", "other");
    const device = await refuse(pull);
    assert.equal(device?.code, "UnsupportedOperation");
    const deviceDetails = device?.details as Record<string, unknown> | undefined;
    assert.equal(deviceDetails?.operation, "remote-special-file");
    assert.equal(deviceDetails?.path, "device");

    // Without the unsupported entries the same pull completes.
    remote.specials.delete("/home/user/portable/device");
    const clean = await pull();
    assert.equal(clean.rootHash.length > 0, true);
    assert.equal(readFileSync(join(harvest, "keep.txt"), "utf8"), "kept");
  } finally {
    fixture.close();
    rmSync(staging, { recursive: true, force: true });
    rmSync(blobRoot, { recursive: true, force: true });
    rmSync(harvest, { recursive: true, force: true });
  }
});

test("a second push replaces the remote tree instead of merging it", async () => {
  const fixture = make();
  const first = mkdtempSync(join(tmpdir(), "porta-swap-one-"));
  const second = mkdtempSync(join(tmpdir(), "porta-swap-two-"));
  const empty = mkdtempSync(join(tmpdir(), "porta-swap-empty-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-swap-blobs-"));
  const harvest = mkdtempSync(join(tmpdir(), "porta-swap-out-"));
  const encoder = new TextEncoder();
  const push = (adapter: E2BLinuxAdapter, environmentId: string, copyRoot: string) =>
    adapter.pushCopy({
      environmentId,
      copyRoot,
      entries: scanTreeFromDirectory(copyRoot).entries,
      authority: REMOTE_AUTHORITY,
    });
  const pull = (expectedRootHash?: string) => {
    const blobs = new BlobStore(blobRoot, ControlStore.inMemory());
    return fixture.adapter.pullCopy({
      environmentId: lease.environmentId,
      destRoot: harvest,
      blobs,
      authority: REMOTE_AUTHORITY,
      ...(expectedRootHash === undefined ? {} : { expectedRootHash }),
    });
  };
  let lease: EnvironmentLease;
  try {
    // Tree one: a plain file, a nested file, and `swap` as a directory.
    mkdirSync(join(first, "old"));
    mkdirSync(join(first, "swap"));
    writeFileSync(join(first, "keep.txt"), "kept in both");
    writeFileSync(join(first, "old", "deep.txt"), "deleted later");
    writeFileSync(join(first, "swap", "nested.txt"), "a directory later");
    lease = await fixture.adapter.acquire(request("acq-swap"));
    const base = await push(fixture.adapter, lease.environmentId, first);

    // Tree two: `old/` is gone, `swap` became a file, one file stayed,
    // and one executable crossed with it.
    writeFileSync(join(second, "keep.txt"), "kept in both");
    writeFileSync(join(second, "swap"), "now a plain file");
    writeFileSync(join(second, "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(second, "run.sh"), 0o755);
    const replaced = await push(fixture.adapter, lease.environmentId, second);

    // The remote tree is exactly tree two: deletions landed, the type
    // change landed, and the hash answers for it.
    const round = await pull(replaced.rootHash);
    assert.equal(round.rootHash, replaced.rootHash);
    assert.notEqual(round.rootHash, base.rootHash);
    assert.equal(readFileSync(join(harvest, "swap"), "utf8"), "now a plain file");
    assert.equal(readFileSync(join(harvest, "keep.txt"), "utf8"), "kept in both");
    assert.equal(statSync(join(harvest, "run.sh")).mode & 0o777, 0o755);
    assert.equal(existsSync(join(harvest, "old")), false);
    assert.equal(existsSync(join(harvest, "swap", "nested.txt")), false);

    // An empty revision publishes an empty managed tree, not the
    // previous contents.
    const cleared = await push(fixture.adapter, lease.environmentId, empty);
    const emptyRound = await pull(cleared.rootHash);
    assert.equal(emptyRound.entries.length, 0);

    // A path outside the managed family never moves, and no removal
    // ever touched anything outside it.
    const remote = fixture.client.sandbox("sbx-1");
    remote.files.set(
      "/home/user/unrelated/keep.txt",
      encoder.encode("not ours to manage"),
    );
    await push(fixture.adapter, lease.environmentId, first);
    assert.equal(
      new TextDecoder().decode(remote.files.get("/home/user/unrelated/keep.txt")),
      "not ours to manage",
    );
    assert.ok(fixture.client.removeCalls.length > 0, "the swap removed superseded content");
    for (const call of fixture.client.removeCalls) {
      assert.match(call.path, /^\/home\/user\/portable/, `removal touched ${call.path}`);
    }
  } finally {
    fixture.close();
    for (const dir of [first, second, empty, blobRoot, harvest]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("an interrupted publication leaves the previous copy or a recoverable state", async () => {
  const fixture = make();
  const first = mkdtempSync(join(tmpdir(), "porta-recover-one-"));
  const second = mkdtempSync(join(tmpdir(), "porta-recover-two-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-recover-blobs-"));
  const harvest = mkdtempSync(join(tmpdir(), "porta-recover-out-"));
  const blobs = new BlobStore(blobRoot, ControlStore.inMemory());
  const push = (copyRoot: string) =>
    fixture.adapter.pushCopy({
      environmentId: lease.environmentId,
      copyRoot,
      entries: scanTreeFromDirectory(copyRoot).entries,
      authority: REMOTE_AUTHORITY,
    });
  const pull = (expectedRootHash?: string) =>
    fixture.adapter.pullCopy({
      environmentId: lease.environmentId,
      destRoot: harvest,
      blobs,
      authority: REMOTE_AUTHORITY,
      ...(expectedRootHash === undefined ? {} : { expectedRootHash }),
    });
  let lease: EnvironmentLease;
  try {
    writeFileSync(join(first, "base.txt"), "the previous copy");
    writeFileSync(join(second, "next.txt"), "the next copy");
    lease = await fixture.adapter.acquire(request("acq-recover"));
    const base = await push(first);

    // The swap fails before the published tree moves: the next
    // transfer rolls the attempt back and the previous copy answers.
    fixture.client.failOn = { renameAt: fixture.client.renameCalls.length + 1 };
    const refused = await refuse(() => push(second));
    assert.equal(refused?.code, "ProviderUnavailable");
    fixture.client.failOn = {};
    await pull(base.rootHash);
    assert.equal(readFileSync(join(harvest, "base.txt"), "utf8"), "the previous copy");

    // The swap fails between the two renames, after the published tree
    // moved aside: the next transfer finishes the committed
    // publication instead of serving a half-swapped state. The fault
    // lands one rename after the attempt that moves the tree aside.
    fixture.client.failOn = { renameAt: fixture.client.renameCalls.length + 2 };
    const midSwap = await refuse(() => push(second));
    assert.equal(midSwap?.code, "ProviderUnavailable");
    fixture.client.failOn = {};
    const completed = await pull();
    assert.equal(completed.entries.length, 1);
    assert.equal(readFileSync(join(harvest, "next.txt"), "utf8"), "the next copy");
    assert.equal(existsSync(join(harvest, "base.txt")), false);

    // The recovered state accepts the next publication unchanged.
    const again = await push(first);
    const settled = await pull(again.rootHash);
    assert.equal(settled.rootHash, again.rootHash);
  } finally {
    fixture.close();
    for (const dir of [first, second, blobRoot, harvest]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("concurrent pushes cannot publish a mixed tree", async () => {
  const fixture = make();
  const one = mkdtempSync(join(tmpdir(), "porta-race-one-"));
  const two = mkdtempSync(join(tmpdir(), "porta-race-two-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-race-blobs-"));
  const harvest = mkdtempSync(join(tmpdir(), "porta-race-out-"));
  const pushFrom = (adapter: E2BLinuxAdapter, copyRoot: string) =>
    adapter.pushCopy({
      environmentId: lease.environmentId,
      copyRoot,
      entries: scanTreeFromDirectory(copyRoot).entries,
      authority: REMOTE_AUTHORITY,
    });
  let lease: EnvironmentLease;
  try {
    writeFileSync(join(one, "a-only.txt"), "only tree one");
    writeFileSync(join(one, "shared.txt"), "from one");
    writeFileSync(join(two, "b-only.txt"), "only tree two");
    writeFileSync(join(two, "shared.txt"), "from two");
    lease = await fixture.adapter.acquire(request("acq-race"));
    // A second adapter instance shares the environment, as two
    // processes over one state directory would.
    const other = fixture.reopen();

    // Park the first publication part-way through its upload with an
    // explicit barrier; no timing assumption is involved.
    const firstWriteHeld = fixture.client.holdWritesContaining("a-only.txt");
    const first = pushFrom(fixture.adapter, one);
    await firstWriteHeld;
    const second = await pushFrom(other, two);
    fixture.client.releaseHeld();
    const interrupted = await refuse(() => first);

    // The interrupted publisher cannot claim success, and the served
    // tree is exactly the one whole publication, never a mix.
    assert.ok(interrupted !== null, "the interrupted publication succeeded anyway");
    const round = await fixture.adapter.pullCopy({
      environmentId: lease.environmentId,
      destRoot: harvest,
      blobs: new BlobStore(blobRoot, ControlStore.inMemory()),
      authority: REMOTE_AUTHORITY,
      expectedRootHash: second.rootHash,
    });
    assert.equal(round.rootHash, second.rootHash);
    assert.equal(readFileSync(join(harvest, "shared.txt"), "utf8"), "from two");
    assert.equal(readFileSync(join(harvest, "b-only.txt"), "utf8"), "only tree two");
    assert.equal(existsSync(join(harvest, "a-only.txt")), false);
  } finally {
    fixture.client.releaseHeld();
    fixture.close();
    for (const dir of [one, two, blobRoot, harvest]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("remote changes return as proposals and never overwrite the source", async () => {
  const fixture = make();
  const src = mkdtempSync(join(tmpdir(), "porta-e2e-src-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "porta-e2e-blobs-"));
  const work = mkdtempSync(join(tmpdir(), "porta-e2e-work-"));
  const store = ControlStore.inMemory();
  const blobs = new BlobStore(blobRoot, store);
  const runtime = new PortableRuntime(store);
  try {
    // One session imports a base revision and materializes one private
    // copy in proposal mode, exactly as a real consumer would.
    writeFileSync(join(src, "app.txt"), "base");
    const session = await runtime.createSession({ policyRef: "policy://test" });
    const imported = checkpointWorkspace(
      runtime.controlStore,
      session.id,
      blobs,
      { requestKey: "import-1", source: { kind: "bridge", rootPath: src } },
      { stability: { kind: "locked" } },
    );
    const managed = await runtime.openSession(session.id);
    const copyRoot = join(work, "copy");
    const copy = await managed.materialize(blobs, imported.revision.id, copyRoot, {
      authority: LOCAL_AUTHORITY,
      mode: "proposal",
    });
    store.insertAttachment({
      sessionId: session.id,
      attachmentId: "att-1",
      name: "worker-1",
      generation: 1,
      status: "active",
      capabilityIds: ["exec.process@1"],
    });

    // The copy crosses to the sandbox under the transfer policy.
    const lease = await fixture.adapter.acquire(request("acq-e2e"));
    const pushed = scanTreeFromDirectory(copyRoot);
    await fixture.adapter.pushCopy({
      environmentId: lease.environmentId,
      copyRoot,
      entries: pushed.entries,
      authority: REMOTE_AUTHORITY,
    });

    // Work happens remotely: a run edits one file and adds another.
    await invoke(lease, "op-run-1", "run", { command: "edit-worker" });
    const encoder = new TextEncoder();
    fixture.client.sandbox("sbx-1").files.set("/home/user/portable/app.txt", encoder.encode("changed by remote"));
    fixture.client.sandbox("sbx-1").files.set("/home/user/portable/new.txt", encoder.encode("added"));

    // The harvest replaces the staging copy, not the source.
    const harvested = await fixture.adapter.pullCopy({
      environmentId: lease.environmentId,
      destRoot: copyRoot,
      blobs,
      authority: REMOTE_AUTHORITY,
    });
    assert.equal(readFileSync(join(copyRoot, "app.txt"), "utf8"), "changed by remote");
    assert.equal(readFileSync(join(copyRoot, "new.txt"), "utf8"), "added");
    assert.equal(readFileSync(join(src, "app.txt"), "utf8"), "base");
    assert.notEqual(harvested.rootHash, pushed.rootHash);

    // The change returns as a candidate with provenance; the head stays.
    const outcome = await managed.propose(
      blobs,
      {
        requestKey: "propose-1",
        copyId: copy.record.id,
        attachment: { sessionId: session.id, attachmentId: "att-1", generation: 1 },
        operationIds: ["op-run-1"],
      },
      { stability: { kind: "locked" } },
    );
    assert.equal(outcome.created, true);
    assert.equal(outcome.fileCount, 2);
    assert.equal(outcome.candidate.parentId, imported.revision.id);
    assert.notEqual(outcome.candidate.id, imported.revision.id);
    const workspaceId = (await managed.describe()).workspace.workspaceId;
    assert.equal(store.getWorkspaceHead(workspaceId), imported.revision.id);
    assert.ok(
      new SessionEventStream(store, session.id).read(0).events.some(
        (event) => event.type === "workspace.proposed",
      ),
      "the proposal is recorded as an event",
    );
    assert.ok(
      store.getRevisionTree(outcome.candidate.id),
      "the candidate carries a manifest",
    );

    // The accepted base never changed on disk: a proposal is the only
    // path remote work takes back into the workspace.
    assert.equal(readFileSync(join(src, "app.txt"), "utf8"), "base");
  } finally {
    fixture.close();
    rmSync(src, { recursive: true, force: true });
    rmSync(blobRoot, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

// Paid smoke test: runs only when a real key is configured. Covers the
// full lifecycle against the live provider (SPEC.md section 22).
test(
  "live lifecycle against E2B (requires E2B_API_KEY)",
  { skip: process.env.E2B_API_KEY === undefined },
  async (t) => {
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

      // One real run crosses the live transport: exact argv, text
      // output, and an exit code.
      const run = await lease.invoke({
        operationId: "op-live-run",
        capability: "exec.process@1",
        operation: "run",
        input: { command: "echo", args: ["porta-live"] },
        environmentId: lease.environmentId,
        limits: {},
      });
      const liveRun = run.result as {
        exitCode?: number;
        timedOut: boolean;
        stdout: { dataBase64?: string };
      };
      assert.equal(liveRun.exitCode, 0);
      assert.equal(liveRun.timedOut, false);
      assert.ok(
        Buffer.from(liveRun.stdout.dataBase64 ?? "", "base64").toString("utf8").includes("porta-live"),
      );

      // An uploaded executable script runs directly. The bits crossed
      // with the bytes; the provider filesystem did not strip them.
      const liveSrc = mkdtempSync(join(tmpdir(), "porta-e2b-live-src-"));
      try {
        writeFileSync(join(liveSrc, "probe.sh"), "#!/bin/sh\necho porta-executable\n");
        chmodSync(join(liveSrc, "probe.sh"), 0o755);
        await adapter.pushCopy({
          environmentId: lease.environmentId,
          copyRoot: liveSrc,
          entries: scanTreeFromDirectory(liveSrc).entries,
          authority: REMOTE_AUTHORITY,
        });
        const executed = await lease.invoke({
          operationId: "op-live-exec-bit",
          capability: "exec.process@1",
          operation: "run",
          input: { command: "/home/user/portable/probe.sh" },
          environmentId: lease.environmentId,
          limits: {},
        });
        const script = executed.result as {
          exitCode?: number;
          stdout: { dataBase64?: string };
        };
        assert.equal(script.exitCode, 0);
        assert.ok(
          Buffer.from(script.stdout.dataBase64 ?? "", "base64")
            .toString("utf8")
            .includes("porta-executable"),
          "the uploaded script ran as an executable",
        );
      } finally {
        rmSync(liveSrc, { recursive: true, force: true });
      }

      // Outbound access from a subprocess, in both configurations
      // (SPEC.md section 7). The probe opens one TCP connection with
      // bash's /dev/tcp under `timeout`, so it depends on no installed
      // tool and a silent drop cannot hang the run.
      const probeOutbound = async (target: EnvironmentLease, operationId: string): Promise<boolean> => {
        const outcome = await target.invoke({
          operationId,
          capability: "exec.process@1",
          operation: "run",
          input: {
            command: "bash",
            args: ["-c", 'timeout 15 bash -c "exec 3<>/dev/tcp/example.com/443"'],
          },
          environmentId: target.environmentId,
          limits: {},
        });
        const probe = outcome.result as { exitCode?: number; timedOut: boolean };
        return !probe.timedOut && probe.exitCode === 0;
      };
      assert.equal(
        await probeOutbound(lease, "op-live-net-open"),
        true,
        "the internet-allowed sandbox reaches the internet from a subprocess",
      );

      // A policy that allows no egress must produce a sandbox whose
      // subprocesses cannot reach out. An account without the authority
      // to allocate that sandbox records the check as unverified
      // instead of passed.
      const blockedRequest = request(`acq-live-blocked-${randomUUID()}`, {}, {
        ...LIMITS,
        networkEgress: "none" as const,
      });
      let blocked: EnvironmentLease | null = null;
      try {
        blocked = await adapter.acquire(blockedRequest);
      } catch {
        t.skip("The account refused the blocked-sandbox allocation; the blocked-network check is unverified.");
      }
      if (blocked !== null) {
        try {
          const blockedManifest = await blocked.manifest();
          assert.equal(blockedManifest.enforcementFacts?.networkEgress, "none");
          assert.equal(
            await probeOutbound(blocked, "op-live-net-blocked"),
            false,
            "the blocked sandbox cannot reach the internet from a subprocess",
          );
        } finally {
          const blockedRelease = await blocked.release();
          assert.equal(blockedRelease.status, "released");
        }
      }

      const released = await lease.release();
      assert.equal(released.status, "released");
      assert.equal((await adapter.reconcile(acquire.acquisitionId)).state, "released");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
