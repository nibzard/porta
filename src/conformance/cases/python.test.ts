import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MontyPythonAdapter } from "../../adapters/monty-python-adapter.js";
import { runConformance } from "../runner.js";
import { pythonCases } from "./python.js";

/** The scenarios SPEC.md section 21 requires of this pack. */
const REQUIRED_CASES = [
  "python.declared-subset",
  "python.unsupported-imports",
  "python.host-function-limits",
  "python.serialization",
  "python.structured-exceptions",
  "python.state-isolation",
  "python.full-python-requirement",
];

test("the pack covers every required python scenario", () => {
  const ids = pythonCases().map((entry) => entry.id);
  for (const id of REQUIRED_CASES) {
    assert.ok(ids.includes(id), `${id} missing from the pack`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("the pack passes against the monty python adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-py-local-"));
  try {
    const adapter = new MontyPythonAdapter({
      workspaceRoot: dir,
      hostFunctions: { double: (n) => (n as number) * 2 },
    });
    const report = await runConformance(
      {
        name: "python",
        adapter,
        cases: pythonCases(),
      },
      {
        authority: {
          principal: "conformance-test",
          policyRef: "policy://conformance",
          externalEffects: true,
        },
        adapterVersion: "1.0.0-test",
        providerConfiguration: { provider: "monty-python", workspaceRoot: dir },
      },
    );
    assert.deepEqual(
      report.results
        .filter((entry) => entry.outcome !== "pass")
        .map((entry) => [entry.id, entry.outcome, entry.reason]),
      [],
    );
    assert.equal(report.verdict, "pass");
    assert.equal(report.summary.total, REQUIRED_CASES.length);
    for (const area of report.areas) {
      assert.equal(area.established, true, area.area);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the evaluating cases wait for their test authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-py-gated-"));
  try {
    const report = await runConformance(
      {
        name: "python",
        adapter: new MontyPythonAdapter({ workspaceRoot: dir }),
        cases: pythonCases(),
      },
      {
        authority: {
          principal: "conformance-test",
          policyRef: "policy://conformance",
        },
        adapterVersion: "1.0.0-test",
      },
    );
    // The pure matching case passes; every case that runs source on
    // the engine skips, and the run cannot call itself conformant.
    const gated = report.results.filter((entry) => entry.outcome === "skip");
    assert.equal(gated.length, 6);
    assert.ok(gated.every((entry) => entry.reason === "external-effects-not-authorized"));
    assert.equal(report.summary.failed, 0);
    assert.equal(report.verdict, "incomplete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
