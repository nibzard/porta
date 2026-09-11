import test from "node:test";
import assert from "node:assert/strict";
import { FakeEnvironmentAdapter } from "../../adapters/test-adapter.js";
import { runConformance } from "../runner.js";
import { replacementResourceCases } from "./replacement-resources.js";

/** The scenarios SPEC.md section 21 requires of this pack. */
const REQUIRED_CASES = [
  "replacement.phase-failures",
  "replacement.unknown-operations",
  "replacement.expired-mutation-lease",
  "replacement.controller-restart",
  "replacement.duplicate-switch",
  "replacement.failed-source-cleanup",
  "resources.stale-generation",
  "resources.browser-survival",
  "resources.expired-browser",
  "resources.invalidated-service-connection",
];

test("the pack covers every required replacement and resource scenario", () => {
  const ids = replacementResourceCases().map((entry) => entry.id);
  for (const id of REQUIRED_CASES) {
    assert.ok(ids.includes(id), `${id} missing from the pack`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("the pack needs no external-effect grant to run in full", async () => {
  const report = await runConformance(
    {
      name: "replacement-resources",
      // The pack scripts its own providers; the loaded adapter is a
      // stand-in the cases never touch.
      adapter: new FakeEnvironmentAdapter(),
      cases: replacementResourceCases(),
    },
    {
      authority: {
        principal: "conformance-test",
        policyRef: "policy://conformance",
      },
      adapterVersion: "1.0.0-test",
    },
  );
  assert.deepEqual(
    report.results
      .filter((entry) => entry.outcome !== "pass")
      .map((entry) => [entry.id, entry.outcome, entry.reason, entry.detail]),
    [],
  );
  assert.equal(report.verdict, "pass");
  assert.equal(report.summary.total, REQUIRED_CASES.length);
  for (const area of report.areas) {
    assert.equal(area.established, true, area.area);
  }
});

test("no case in the pack declares external effects", () => {
  for (const entry of replacementResourceCases()) {
    assert.equal(entry.effects, undefined, entry.id);
  }
});
