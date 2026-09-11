import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuthorizedAcquireRequest, EnvironmentLease } from "../schema/adapter.js";
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
  /** Scripted outcome of the next foreground command. */
  nextRun: {
    exitCode: number | null;
    timedOut?: boolean;
    stdout?: string[];
    stderr?: string[];
  } | null = null;
  connectCalls = 0;
  createCalls = 0;
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
        client.fileWrites.push({ path, bytes: bytes.byteLength });
        state.files.set(path, bytes);
      },
      async listDir(path) {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const exists =
          path === "/" ||
          state.files.has(path) ||
          [...state.files.keys()].some((key) => key.startsWith(prefix)) ||
          state.madeDirs.some((dir) => dir === path || dir.startsWith(prefix));
        if (!exists) {
          return null;
        }
        const names = new Map<string, "file" | "directory">();
        const fold = (key: string, kind: "file" | "directory") => {
          if (key === path || !key.startsWith(prefix)) {
            return;
          }
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf("/");
          names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? kind : "directory");
        };
        for (const key of state.files.keys()) {
          fold(key, "file");
        }
        for (const dir of state.madeDirs) {
          fold(dir, "directory");
        }
        return [...names.entries()].map(([name, type]) => ({ name, type }));
      },
      async makeDir(path) {
        state.madeDirs.push(path);
      },
    };
  }

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
      files: new Map(),
      madeDirs: [],
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

      const released = await lease.release();
      assert.equal(released.status, "released");
      assert.equal((await adapter.reconcile(acquire.acquisitionId)).state, "released");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
