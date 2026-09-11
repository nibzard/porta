import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterInvocation } from "../schema/adapter.js";
import type { EnvironmentRequest } from "../schema/capability.js";
import { assertValid } from "../schema/validate.js";
import { environmentManifestSchema } from "../schema/capability.js";
import {
  processRunResultSchema,
  processTerminateResultSchema,
} from "../runtime/process-capability.js";
import {
  LocalProcessAdapter,
  LOCAL_PROCESS_PROVIDER_ID,
  type LocalProcessLease,
} from "./local-process-adapter.js";

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

/** One adapter over a fresh supervisor directory. */
function adapter(overrides: Record<string, unknown> = {}): {
  parts: LocalProcessAdapter;
  dir: string;
  done: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "porta-local-"));
  const parts = new LocalProcessAdapter({ supervisorDir: dir, ...overrides });
  return { parts, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Acquire one lease through the durable protocol. */
async function leaseOf(parts: LocalProcessAdapter): Promise<LocalProcessLease> {
  const acquired = await parts.acquire({
    acquisitionId: `acq-${randomUUID()}`,
    request: {
      name: "worker",
      providerId: LOCAL_PROCESS_PROVIDER_ID,
      requires: {},
    } as EnvironmentRequest,
    authority: { principal: "test", policyRef: "policy://test" },
  });
  return acquired as LocalProcessLease;
}

function invocation(operation: string, input: unknown, overrides: Record<string, unknown> = {}): AdapterInvocation {
  return {
    operationId: `op-${randomUUID()}`,
    capability: "exec.process@1",
    operation,
    input,
    environmentId: "env-irrelevant",
    limits: {},
    ...overrides,
  };
}

test("the manifest declares the actual host access and the process contract", async () => {
  const { parts, done } = adapter();
  try {
    const lease = await leaseOf(parts);
    const manifest = await lease.manifest();
    assertValid(environmentManifestSchema, manifest);
    assert.equal(manifest.providerId, LOCAL_PROCESS_PROVIDER_ID);
    assert.equal(manifest.capabilities.length, 1);
    assert.equal(manifest.capabilities[0]?.id, "exec.process@1");

    // The declaration is the host's truth: no sandbox, full filesystem,
    // inherited networking, and a named supervision mechanism.
    assert.equal(manifest.enforcement.isolation, "none");
    assert.equal(manifest.enforcement.hostFilesystem, "full");
    assert.equal(manifest.enforcement.networkEgress, "unrestricted-inherited");
    assert.equal(manifest.enforcement.supervision, "state-directory");
    assert.ok(typeof manifest.enforcement.supervisorDir === "string");

    // The offer matches the manifest's claims.
    const [offer] = await parts.describe();
    assert.equal(offer?.providerId, LOCAL_PROCESS_PROVIDER_ID);
    assert.equal(offer?.enforcement?.hostFilesystem, "full");
  } finally {
    done();
  }
});

test("isolation requirements the host cannot enforce are rejected", async () => {
  const { parts, done } = adapter();
  try {
    const base = {
      authority: { principal: "test", policyRef: "policy://test" },
    };
    // A sandboxed isolation demand refuses.
    const sandbox = await refuse(() =>
      parts.acquire({
        ...base,
        acquisitionId: `acq-${randomUUID()}`,
        request: {
          name: "worker",
          requires: {},
          constraints: { isolation: { equals: "sandbox" } },
        } as EnvironmentRequest,
      }),
    );
    assert.ok(sandbox !== null && sandbox.code === "RequirementUnsatisfied");

    // A no-egress demand refuses: subprocesses share the host network.
    const egress = await refuse(() =>
      parts.acquire({
        ...base,
        acquisitionId: `acq-${randomUUID()}`,
        request: {
          name: "worker",
          requires: {},
          constraints: { networkEgress: { equals: "none" } },
        } as EnvironmentRequest,
      }),
    );
    assert.ok(egress !== null && egress.code === "RequirementUnsatisfied");

    // A host-filesystem-denied demand refuses: the adapter has full
    // host access and cannot honestly claim otherwise.
    const host = await refuse(() =>
      parts.acquire({
        ...base,
        acquisitionId: `acq-${randomUUID()}`,
        request: {
          name: "worker",
          requires: {},
          constraints: { hostFilesystem: { equals: "none" } },
        } as EnvironmentRequest,
      }),
    );
    assert.ok(host !== null && host.code === "RequirementUnsatisfied");

    // A capability it does not offer refuses too.
    const missing = await refuse(() =>
      parts.acquire({
        ...base,
        acquisitionId: `acq-${randomUUID()}`,
        request: {
          name: "worker",
          requires: { "browser.session@1": {} },
        } as EnvironmentRequest,
      }),
    );
    assert.ok(missing !== null && missing.code === "RequirementUnsatisfied");

    // The declared truth itself passes.
    const lease = await parts.acquire({
      ...base,
      acquisitionId: `acq-${randomUUID()}`,
      request: {
        name: "worker",
        requires: {},
        constraints: { isolation: { equals: "none" } },
      } as EnvironmentRequest,
    });
    assert.ok(lease.environmentId.startsWith("env-local-"));

    // One acquisition identity returns the same environment.
    const acquisitionId = `acq-${randomUUID()}`;
    const first = await parts.acquire({
      ...base,
      acquisitionId,
      request: { name: "worker", requires: {} } as EnvironmentRequest,
    });
    const second = await parts.acquire({
      ...base,
      acquisitionId,
      request: { name: "worker", requires: {} } as EnvironmentRequest,
    });
    assert.equal(second.environmentId, first.environmentId);
  } finally {
    done();
  }
});

test("run executes binary input and keeps the output streams separate", async () => {
  const { parts, done } = adapter();
  try {
    const lease = await leaseOf(parts);
    const payload = Uint8Array.from([0x00, 0x01, 0xff, 0x10, 0x0a, 0x41]);

    // cat copies its binary standard input to standard output; the
    // shell script writes a marker to standard error.
    const run = await lease.invoke(
      invocation("run", {
        command: "/bin/sh",
        args: ["-c", "cat; echo marker >&2"],
        stdin: Buffer.from(payload).toString("base64"),
        stdinEncoding: "base64",
        timeoutMs: 10_000,
      }),
    );
    assert.equal(run.status, "completed");
    const result = run.result as { stdout: { dataBase64?: string }; stderr: { dataBase64?: string } };
    const stdout = Buffer.from(result.stdout.dataBase64 ?? "", "base64");
    assert.deepEqual(new Uint8Array(stdout), payload);
    assert.ok(Buffer.from(result.stderr.dataBase64 ?? "", "base64").toString("utf8").includes("marker"));

    // A nonzero exit is completion with a code, not a failure.
    const failed = await lease.invoke(
      invocation("run", { command: "/bin/sh", args: ["-c", "exit 3"] }),
    );
    assert.equal(failed.status, "completed");
    assert.equal((failed.result as { exitCode?: number }).exitCode, 3);

    // Environment additions reach the process, merged over the base.
    const env = await lease.invoke(
      invocation("run", {
        command: "/bin/sh",
        args: ["-c", "printf %s \"$PORTA_TEST_VALUE\""],
        env: { PORTA_TEST_VALUE: "added" },
      }),
    );
    const echoed = Buffer.from(
      ((env.result as { stdout: { dataBase64?: string } }).stdout.dataBase64 ?? ""),
      "base64",
    ).toString("utf8");
    assert.equal(echoed, "added");

    // The working directory resolves inside the copy root; a run can
    // see files materialized there.
    const listed = await lease.invoke(
      invocation("run", {
        command: "pwd",
        outputLimits: { maxBytesPerStream: 4096 },
      }),
    );
    const cwd = Buffer.from(
      ((listed.result as { stdout: { dataBase64?: string } }).stdout.dataBase64 ?? ""),
      "base64",
    ).toString("utf8").trim();
    assert.equal(cwd, parts.copyRoot);

    // Truncation caps the capture and reports the dropped bytes.
    const cut = await lease.invoke(
      invocation("run", {
        command: "/bin/sh",
        args: ["-c", "printf 'abcdefghij'"],
        outputLimits: { maxBytesPerStream: 4 },
      }),
    );
    const capture = (cut.result as { stdout: { dataBase64?: string; truncated?: boolean; omittedBytes?: number } }).stdout;
    assert.equal(Buffer.from(capture.dataBase64 ?? "", "base64").toString("utf8"), "abcd");
    assert.equal(capture.truncated, true);
    assert.equal(capture.omittedBytes, 6);

    // A missing executable rejects with a provider failure, not a
    // phantom exit code.
    const missing = await refuse(() =>
      lease.invoke(invocation("run", { command: "porta-no-such-binary" })),
    );
    assert.ok(missing !== null && missing.code === "ProviderUnavailable");

    // The result satisfies the capability contract.
    const round = await lease.invoke(invocation("run", { command: "/bin/sh", args: ["-c", "true"] }));
    assertValid(processRunResultSchema, round.result);
  } finally {
    done();
  }
});

test("a run timeout ends the whole group and reports the signal", async () => {
  const { parts, done } = adapter();
  try {
    const lease = await leaseOf(parts);
    const run = await lease.invoke(
      invocation("run", {
        command: "/bin/sh",
        args: ["-c", "sleep 30 & sleep 30; wait"],
        timeoutMs: 150,
      }),
    );
    const result = run.result as { timedOut?: boolean; signal?: string };
    assert.equal(result.timedOut, true);
    assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL");
    assertValid(processRunResultSchema, run.result);
  } finally {
    done();
  }
});

test("started processes stay inspectable across adapter restarts", async () => {
  const first = adapter();
  try {
    const lease = await leaseOf(first.parts);
    const started = await lease.invoke(
      invocation("start", {
        command: "/bin/sh",
        args: ["-c", "sleep 30 & sleep 30; wait"],
      }),
    );
    assert.equal(started.status, "completed");
    const { resourceId, providerProcessId } = started.result as {
      resourceId: string;
      providerProcessId: string;
    };
    const pid = Number(providerProcessId);
    assert.ok(pid > 0);

    // Running right now, through the same adapter.
    const before = await lease.invoke(invocation("inspect", { resourceId }));
    assert.equal((before.result as { state?: string }).state, "running");

    // The "CLI exits": a brand-new adapter process opens the same
    // supervisor directory. Nothing is shared but durable state.
    const reopened = new LocalProcessAdapter({ supervisorDir: first.dir });
    const recovered = await reopened.reconcile(
      acquisitionIdOf(first.parts, lease.environmentId)!,
    );
    assert.equal(recovered.state, "allocated");
    const newLease = reopened.lease(recovered.environmentId!);
    const after = await newLease.invoke(invocation("inspect", { resourceId }));
    assert.equal((after.result as { state?: string }).state, "running");

    // Terminate from the new process claims only what it measured.
    const stopped = await newLease.invoke(
      invocation("terminate", { resourceId, signal: "SIGTERM" }),
    );
    const outcome = stopped.result as {
      confirmed?: boolean;
      descendantsStopped?: boolean;
      state?: string;
    };
    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.descendantsStopped, true);
    assert.equal(outcome.state, "terminated");
    assertValid(processTerminateResultSchema, stopped.result);

    // The claim is independently checked: neither the leader nor any
    // group member survives.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(pid, 0));
    assert.throws(() => process.kill(-pid, 0));

    // The durable record carries the measured outcome.
    const record = reopened.processRecord(resourceId);
    assert.equal(record?.terminate?.confirmed, true);
    assert.equal(record?.terminate?.descendantsStopped, true);

    // Inspection after the stop reports a dead handle, and a second
    // terminate of the dead process confirms what is true: it stopped.
    const dead = await newLease.invoke(invocation("inspect", { resourceId }));
    assert.equal((dead.result as { state?: string }).state, "terminated");
    const again = await newLease.invoke(invocation("terminate", { resourceId }));
    const repeatOutcome = again.result as { confirmed?: boolean };
    assert.equal(repeatOutcome.confirmed, true);
  } finally {
    first.done();
  }
});

test("cancel confirms the stop and reports descendants honestly", async () => {
  const { parts, done } = adapter();
  try {
    const lease = await leaseOf(parts);
    const request = invocation("start", {
      command: "/bin/sh",
      args: ["-c", "sleep 30 & sleep 30; wait"],
    });
    const started = await lease.invoke(request);
    const { resourceId } = started.result as { resourceId: string };

    const cancel = await lease.cancel(request.operationId);
    assert.equal(cancel.outcome, "confirmed");
    assert.equal(cancel.stopped, true);
    assert.equal(cancel.descendantsStopped, true);

    // An unknown operation reports a best-effort no, never a fake stop.
    const unknown = await lease.cancel("op-never-existed");
    assert.equal(unknown.outcome, "best-effort");
    assert.equal(unknown.stopped, false);

    // A completed run holds nothing to stop; its cancel says so too.
    const runRequest = invocation("run", { command: "true" });
    await lease.invoke(runRequest);
    const settled = await lease.cancel(runRequest.operationId);
    assert.equal(settled.outcome, "best-effort");
    assert.equal(settled.stopped, false);
  } finally {
    done();
  }
});

test("lease expiry, release, and unsupported channels behave as declared", async () => {
  const { parts, done } = adapter();
  try {
    // Binding is explicitly unsupported, not a failure.
    const lease = await leaseOf(parts);
    const bound = await lease.bind(
      {
        id: "res-1",
        sessionId: "sess-1",
        type: "process",
        owner: { sessionId: "sess-1", attachmentId: "att-1", generation: 1 },
        lifetime: "attachment",
        recovery: "none",
      },
      { authority: { principal: "test", policyRef: "policy://test" }, resolveSecret: async () => "" },
    );
    assert.equal(bound.status, "unsupported");

    // Renewal extends and reports support.
    const extended = await lease.renew(new Date(Date.now() + 60_000).toISOString());
    assert.equal(extended.status, "active");
    assert.equal(extended.renewalSupported, true);

    // Release stops started processes and is idempotent.
    const started = await lease.invoke(
      invocation("start", { command: "/bin/sh", args: ["-c", "sleep 30"] }),
    );
    const { resourceId, providerProcessId } = started.result as {
      resourceId: string;
      providerProcessId: string;
    };
    const first = await lease.release();
    assert.equal(first.status, "released");
    const second = await lease.release();
    assert.equal(second.status, "released");
    void resourceId;

    // The claim is measured: the started process is gone.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(Number(providerProcessId), 0));

    // Work after release refuses.
    const refused = await refuse(() =>
      lease.invoke(invocation("run", { command: "true" })),
    );
    assert.ok(refused !== null && refused.code === "LeaseExpired");

    // An expired lease refuses new invocations (SPEC.md section 8).
    const short = adapter({ leaseTtlMs: 40 });
    try {
      const shortLease = await leaseOf(short.parts);
      const early = await shortLease.invoke(invocation("run", { command: "true" }));
      assert.equal(early.status, "completed");
      await new Promise((resolve) => setTimeout(resolve, 80));
      const late = await refuse(() => shortLease.invoke(invocation("run", { command: "true" })));
      assert.ok(late !== null && late.code === "LeaseExpired");
    } finally {
      short.done();
    }

    // Unknown operations on the lease channel refuse as requests. The
    // lease above is released, so a fresh one answers.
    const fresh = await leaseOf(parts);
    const weird = await refuse(() =>
      fresh.invoke(invocation("dance", {})),
    );
    assert.ok(weird !== null && weird.code === "UnsupportedOperation");
  } finally {
    done();
  }
});

/** The acquisition identity that owns one environment. */
function acquisitionIdOf(
  parts: LocalProcessAdapter,
  environmentId: string,
): string | null {
  return parts.acquisitionOfEnvironment(environmentId)?.acquisitionId ?? null;
}
