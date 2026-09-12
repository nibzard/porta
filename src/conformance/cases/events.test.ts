import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProcessAdapter } from "../../adapters/local-process-adapter.js";
import { runConformance } from "../runner.js";
import { eventsCases } from "./events.js";

/** The scenarios SPEC.md section 21 requires of this pack. */
const REQUIRED_CASES = [
  "events.resume-by-sequence",
  "events.restart-replay",
  "events.duplicate-delivery",
  "events.state-transaction-consistency",
];

test("the pack covers every required event scenario", () => {
  const ids = eventsCases().map((entry) => entry.id);
  for (const id of REQUIRED_CASES) {
    assert.ok(ids.includes(id), `${id} missing from the pack`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("the pack passes against the local process adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-events-local-"));
  try {
    const adapter = new LocalProcessAdapter({ supervisorDir: dir });
    const report = await runConformance(
      {
        name: "events",
        adapter,
        cases: eventsCases(),
      },
      {
        authority: {
          principal: "conformance-test",
          policyRef: "policy://conformance",
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
    assert.equal(report.areas.length, 1);
    assert.equal(report.areas[0]?.area, "events");
    assert.equal(report.areas[0]?.established, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing event case fails its area instead of hiding", async () => {
  const cases = eventsCases();
  const breaking = cases[0]!;
  const original = breaking.run.bind(breaking);
  breaking.run = async () => ({ outcome: "fail", reason: "injected" });
  try {
    const adapter = new LocalProcessAdapter({ supervisorDir: mkdtempSync(join(tmpdir(), "porta-conf-events-fail-")) });
    const report = await runConformance(
      { name: "events-broken", adapter, cases },
      {
        authority: { principal: "conformance-test", policyRef: "policy://conformance" },
        adapterVersion: "1.0.0-test",
      },
    );
    assert.equal(report.verdict, "fail");
    assert.equal(report.summary.failed, 1);
    assert.equal(report.areas[0]?.established, false);
  } finally {
    breaking.run = original;
  }
});
