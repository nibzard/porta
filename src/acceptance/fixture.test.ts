import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalProcessAdapter } from "../adapters/local-process-adapter.js";
import { MontyPythonAdapter } from "../adapters/monty-python-adapter.js";
import type { AcquisitionLimits } from "../schema/policy.js";

/** Limits the acceptance authority grants: local execution, one day. */
const LIMITS: AcquisitionLimits = {
  executionLocations: ["local"],
  networkEgress: "unrestricted",
  egressAllowlist: [],
  hostFilesystemAccess: true,
  maxEnvironmentLifetimeMs: 86_400_000,
  maxResources: {},
};

/**
 * The executable acceptance fixture (SPEC.md sections 22 and 22.1).
 *
 * The fixture gives the acceptance demonstration one small
 * repository: a dataset, an inspection program, declared recipes, a
 * native test, and a browser-visible application. These tests prove
 * each piece works on the environment it declares a need for:
 *
 * - The data inspection runs on the lightweight Python engine with
 *   the dataset bound read-only. No machine is allocated for it.
 * - The declared recipes reconstruct the dependency and start the
 *   application; the native test needs the real node binary.
 * - The dashboard fills only through script execution, so inspecting
 *   it needs a browser rather than a plain fetch.
 * - Verification artifacts name their workspace revision, and the
 *   checker refuses anything that does not.
 */

/** The fixture root, resolved from the compiled test's location. */
const FIXTURE = fileURLToPath(new URL("../../fixtures/acceptance", import.meta.url));

/** One recipe document as the fixture declares it. */
interface Recipe {
  schemaVersion: number;
  recipe: string;
  purpose: string;
  requires?: string[];
  steps: Array<{
    id: string;
    run: string[];
    produces?: string;
    idempotent?: boolean;
    readySignal?: string;
  }>;
}

/** Read and parse one JSON file. */
async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/** One fresh copy of the fixture the test may mutate. */
function copyOfFixture(): string {
  const target = mkdtempSync(join(tmpdir(), "porta-fixture-"));
  cpSync(FIXTURE, target, { recursive: true });
  return target;
}

/** Run one process to completion and return its exit status. */
function runToCompletion(command: string, args: string[], cwd: string) {
  const done = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    code: done.status ?? -1,
    out: `${done.stdout ?? ""}${done.stderr ?? ""}`,
  };
}

/** Read one declared recipe and check its shape. */
async function recipeOf(name: string): Promise<Recipe> {
  const recipe = (await readJson(join(FIXTURE, "recipes", `${name}.json`))) as Recipe;
  assert.equal(recipe.schemaVersion, 1);
  assert.ok(Array.isArray(recipe.steps) && recipe.steps.length > 0);
  for (const step of recipe.steps) {
    assert.ok(Array.isArray(step.run) && step.run.length > 0, `${name}: step ${step.id} runs nothing`);
    assert.ok(step.run.every((part) => typeof part === "string"));
  }
  return recipe;
}

test("the data inspection runs on the lightweight engine", async () => {
  const adapter = new MontyPythonAdapter({ workspaceRoot: FIXTURE });
  const lease = await adapter.acquire({
    acquisitionId: `acq-${randomUUID()}`,
    request: { name: "inspection", providerId: adapter.id, requires: {} },
    authority: { principal: "user://acceptance", policyRef: "policy://acceptance" },
    limits: LIMITS,
  });
  try {
    const source = await readFile(join(FIXTURE, "inspection", "summarize.py"), "utf8");
    const answered = await lease.invoke({
      operationId: `op-${randomUUID()}`,
      capability: "exec.python@1",
      operation: "evaluate",
      input: {
        source,
        bindings: [{ name: "data", kind: "workspace", path: "data" }],
      },
      environmentId: lease.environmentId,
      limits: {},
    });
    assert.equal(answered.status, "completed");
    const result = answered.result as { value: unknown[] };
    // Ten readings, bounds 0.4 to 47.5, and the single anomaly.
    assert.deepEqual(result.value, [10, 0.4, 47.5, 1]);
    assert.equal(result.value.length, 4);
  } finally {
    await lease.release();
    await adapter.close();
  }
});

test("the declared recipes reconstruct the dependency and the native test passes", async () => {
  const copy = copyOfFixture();
  const scratch = mkdtempSync(join(tmpdir(), "porta-fixture-sup-"));
  try {
    const dependencies = await recipeOf("dependencies");
    const server = await recipeOf("server");
    // Startup names its dependency on reconstruction, not a fresh
    // install: the recipes compose.
    assert.deepEqual(server.requires, ["dependencies"]);

    const adapter = new LocalProcessAdapter({
      supervisorDir: scratch,
      workingCopyRoot: copy,
    });
    const lease = await adapter.acquire({
      acquisitionId: `acq-${randomUUID()}`,
      request: { name: "worker", providerId: adapter.id, requires: {} },
      authority: { principal: "user://acceptance", policyRef: "policy://acceptance" },
      limits: LIMITS,
    });
    try {
      for (const step of dependencies.steps) {
        const installed = await lease.invoke({
          operationId: `op-${randomUUID()}`,
          capability: "exec.process@1",
          operation: "run",
          input: { command: step.run[0]!, args: step.run.slice(1) },
          environmentId: lease.environmentId,
          limits: {},
        });
        assert.equal(installed.status, "completed");
        const result = installed.result as { exitCode?: number };
        assert.equal(result.exitCode, 0);
        assert.ok(
          step.produces === undefined || existsSync(join(copy, step.produces)),
          `${step.id} produced ${step.produces ?? "nothing"}`,
        );
      }

      // The native test needs the real node binary: it hashes the
      // dataset and renders through the reconstructed dependency.
      const checked = await lease.invoke({
        operationId: `op-${randomUUID()}`,
        capability: "exec.process@1",
        operation: "run",
        input: { command: "node", args: ["tests/check-data.mjs"] },
        environmentId: lease.environmentId,
        limits: {},
      });
      assert.equal(checked.status, "completed");
      const outcome = checked.result as {
        exitCode?: number;
        stdout?: { dataBase64?: string };
      };
      assert.equal(outcome.exitCode, 0);
      const text = Buffer.from(outcome.stdout?.dataBase64 ?? "", "base64").toString("utf8");
      assert.match(text, /data ok/);
    } finally {
      await lease.release();
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the application serves a browser-visible dashboard through its startup recipe", async () => {
  const copy = copyOfFixture();
  try {
    const dependencies = await recipeOf("dependencies");
    for (const step of dependencies.steps) {
      const done = runToCompletion(step.run[0]!, step.run.slice(1), copy);
      assert.equal(done.code, 0, done.out);
    }
    const server = await recipeOf("server");
    const step = server.steps[0]!;

    const child = spawn(step.run[0]!, step.run.slice(1), { cwd: copy });
    try {
      // The recipe's ready signal is the line the server prints once
      // its port is bound.
      let buffer = "";
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no ${step.readySignal} line: ${buffer}`)),
          15_000,
        );
        child.stdout!.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const line = buffer
            .split("\n")
            .find((entry) => entry.startsWith(`${step.readySignal} `));
          if (line !== undefined) {
            clearTimeout(timer);
            resolve((JSON.parse(line.slice(step.readySignal!.length + 1)) as { port: number }).port);
          }
        });
        child.on("error", (error) => reject(error));
      });

      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(health.status, 200);
      assert.equal(await health.text(), "ok");

      // The served summary matches the lightweight inspection's
      // answer: every environment reads the same dataset.
      const summary = (await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json()) as {
        count: number;
        lowest: number;
        highest: number;
        anomalies: number;
      };
      assert.deepEqual(summary, { count: 10, lowest: 0.4, highest: 47.5, anomalies: 1 });

      // The page fills through script execution: the concrete reason
      // inspection needs a browser, not a plain fetch.
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      assert.match(page, /Reading summary/);
      assert.match(page, /fetch\("\/api\/summary"\)/);
      assert.match(page, /loading/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("verification artifacts identify their revision and the checker enforces it", () => {
  const good = join(FIXTURE, "verification", "sample-report.json");
  const passed = runToCompletion(process.execPath, ["scripts/check-artifact.mjs", good], FIXTURE);
  assert.equal(passed.code, 0, passed.out);
  assert.match(passed.out, /verified rev-sample-00000000/);

  const scratch = mkdtempSync(join(tmpdir(), "porta-artifact-"));
  try {
    // One report with no revision identity and one failed check: the
    // checker refuses both halves.
    const bad = join(scratch, "bad-report.json");
    writeFileSync(
      bad,
      JSON.stringify({
        schemaVersion: 1,
        kind: "verification",
        workspaceRevisionId: "oops",
        checks: [{ name: "dashboard-visible", passed: false }],
      }),
    );
    const failed = runToCompletion(process.execPath, ["scripts/check-artifact.mjs", bad], FIXTURE);
    assert.equal(failed.code, 1);
    assert.match(failed.out, /workspaceRevisionId must match/);
    assert.match(failed.out, /did not pass/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
