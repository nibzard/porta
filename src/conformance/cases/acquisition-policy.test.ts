import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProcessAdapter } from "../../adapters/local-process-adapter.js";
import { runConformance } from "../runner.js";
import { acquisitionPolicyCases } from "./acquisition-policy.js";

/** The scenarios SPEC.md section 21 requires of this pack. */
const REQUIRED_CASES = [
  "acquisition.duplicate-request",
  "acquisition.lost-response",
  "acquisition.reconciliation",
  "acquisition.release-retry",
  "acquisition.lease-expiration",
  "acquisition.stale-controller",
  "matching.missing-capability",
  "matching.insufficient-resources",
  "matching.unknown-constraint",
  "matching.ambiguous-provider",
  "matching.policy-denial",
  "matching.declared-restrictions",
  "matching.unenforceable-limits",
];

test("the pack covers every required acquisition and matching scenario", () => {
  const ids = acquisitionPolicyCases().map((entry) => entry.id);
  for (const id of REQUIRED_CASES) {
    assert.ok(ids.includes(id), `${id} missing from the pack`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("the pack passes against the local process adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-local-"));
  try {
    const adapter = new LocalProcessAdapter({ supervisorDir: dir });
    const report = await runConformance(
      {
        name: "acquisition-policy",
        adapter,
        cases: acquisitionPolicyCases(),
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

    // The declared-restrictions case reports the enforcement limits it
    // found, so the report says what was actually verified.
    const declared = report.results.find(
      (entry) => entry.id === "matching.declared-restrictions",
    )!;
    assert.ok(declared.detail !== undefined && declared.detail.length > 0);
    assert.match(declared.detail, /Enforcement limits declared:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the allocation cases wait for their test authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-gated-"));
  try {
    const report = await runConformance(
      {
        name: "acquisition-policy",
        adapter: new LocalProcessAdapter({ supervisorDir: dir }),
        cases: acquisitionPolicyCases(),
      },
      {
        authority: {
          principal: "conformance-test",
          policyRef: "policy://conformance",
        },
        adapterVersion: "1.0.0-test",
      },
    );
    // The pure matching cases pass; every case that would allocate or
    // execute skips with the grant it lacks, and the run cannot call
    // itself conformant.
    const gated = report.results.filter((entry) => entry.outcome === "skip");
    assert.equal(gated.length, 8);
    assert.ok(gated.every((entry) => entry.reason === "external-effects-not-authorized"));
    assert.equal(report.summary.failed, 0);
    assert.equal(report.verdict, "incomplete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
