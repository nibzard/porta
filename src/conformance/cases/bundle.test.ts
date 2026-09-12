import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProcessAdapter } from "../../adapters/local-process-adapter.js";
import { runConformance } from "../runner.js";
import { bundleCases } from "./bundle.js";

/** The scenarios SPEC.md section 21 requires of this pack. */
const REQUIRED_CASES = [
  "bundle.missing-blobs",
  "bundle.tampered-content",
  "bundle.unknown-required-extension",
  "bundle.credential-references",
  "bundle.import-without-execution",
  "bundle.no-competing-controller",
];

test("the pack covers every required bundle scenario", () => {
  const ids = bundleCases().map((entry) => entry.id);
  for (const id of REQUIRED_CASES) {
    assert.ok(ids.includes(id), `${id} missing from the pack`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("the pack passes against the local process adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-bundle-local-"));
  try {
    const adapter = new LocalProcessAdapter({ supervisorDir: dir });
    const report = await runConformance(
      {
        name: "bundle",
        adapter,
        cases: bundleCases(),
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
    assert.equal(report.areas[0]?.area, "bundle");
    assert.equal(report.areas[0]?.established, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
