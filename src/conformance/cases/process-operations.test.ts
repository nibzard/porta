import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProcessAdapter } from "../../adapters/local-process-adapter.js";
import { MontyPythonAdapter } from "../../adapters/monty-python-adapter.js";
import { runConformance } from "../runner.js";
import { processOperationCases } from "./process-operations.js";

/** The scenarios SPEC.md section 21 requires of this pack. */
const REQUIRED_CASES = [
  "process.argument-preservation",
  "process.working-directory",
  "process.environment-merge",
  "process.binary-output",
  "process.exit-codes",
  "process.output-limits",
  "process.timeout",
  "process.descendant-termination",
  "process.release-orphaned-group",
  "operations.duplicate-request",
  "operations.mismatched-input",
  "operations.lost-response-after-effects",
  "operations.unconfirmed-cancellation",
  "operations.reconciliation-history",
];

test("the pack covers every required process and operation scenario", () => {
  const ids = processOperationCases().map((entry) => entry.id);
  for (const id of REQUIRED_CASES) {
    assert.ok(ids.includes(id), `${id} missing from the pack`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("the pack passes against the local process adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-proc-local-"));
  try {
    const adapter = new LocalProcessAdapter({ supervisorDir: dir });
    const report = await runConformance(
      {
        name: "process-operations",
        adapter,
        cases: processOperationCases(),
      },
      {
        authority: {
          principal: "conformance-test",
          policyRef: "policy://conformance",
          externalEffects: true,
        },
        adapterVersion: "1.0.0-test",
        providerConfiguration: { supervisor: dir, provider: "local-process" },
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

test("the process cases wait for their test authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-proc-gated-"));
  try {
    const report = await runConformance(
      {
        name: "process-operations",
        adapter: new LocalProcessAdapter({ supervisorDir: dir }),
        cases: processOperationCases(),
      },
      {
        authority: {
          principal: "conformance-test",
          policyRef: "policy://conformance",
        },
        adapterVersion: "1.0.0-test",
      },
    );
    // The pure operation cases pass; every case that drives the
    // adapter skips, and the run cannot call itself conformant.
    const gated = report.results.filter((entry) => entry.outcome === "skip");
    assert.equal(gated.length, 9);
    assert.ok(gated.every((entry) => entry.reason === "external-effects-not-authorized"));
    assert.equal(report.summary.failed, 0);
    assert.equal(report.verdict, "incomplete");
    const operations = report.areas.find((entry) => entry.area === "operations")!;
    assert.equal(operations.established, true);
    const process_ = report.areas.find((entry) => entry.area === "process")!;
    assert.equal(process_.established, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the process cases skip, not fails, against an adapter without processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-proc-absent-"));
  try {
    const adapter = new MontyPythonAdapter({ workspaceRoot: dir });
    const report = await runConformance(
      {
        name: "process-operations",
        adapter,
        cases: processOperationCases(),
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
    // The capability cases skip — the adapter never claimed
    // exec.process@1 — while the store-level operation cases still run.
    const processArea = report.results.filter((entry) => entry.area === "process");
    const operationsArea = report.results.filter((entry) => entry.area === "operations");
    assert.equal(processArea.length, 9);
    assert.ok(
      processArea.every(
        (entry) => entry.outcome === "skip" && entry.reason === "capability-not-offered",
      ),
    );
    assert.equal(operationsArea.length, 5);
    assert.ok(operationsArea.every((entry) => entry.outcome === "pass"));
    assert.equal(report.summary.failed, 0);
    assert.equal(report.verdict, "incomplete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
