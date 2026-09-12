import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProcessAdapter } from "../../adapters/local-process-adapter.js";
import { runConformance } from "../runner.js";
import { workspaceCases } from "./workspace.js";

/** The scenarios SPEC.md section 21 requires of this pack. */
const REQUIRED_CASES = [
  "workspace.binary-roundtrip",
  "workspace.unicode-paths",
  "workspace.executable-bits",
  "workspace.invalid-paths",
  "workspace.unsupported-links",
  "workspace.size-limits",
  "workspace.hash-mismatch",
  "workspace-authority.concurrent-proposals",
  "workspace-authority.stale-base",
  "workspace-authority.stale-generation",
  "workspace-authority.local-edits-during-export",
  "workspace-authority.stability-declaration",
  "workspace-authority.checkpoint-lock",
  "workspace-authority.interrupted-export",
  "workspace-authority.export-type-change",
];

test("the pack covers every required workspace scenario", () => {
  const ids = workspaceCases().map((entry) => entry.id);
  for (const id of REQUIRED_CASES) {
    assert.ok(ids.includes(id), `${id} missing from the pack`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("the pack passes against the local process adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-ws-local-"));
  try {
    const adapter = new LocalProcessAdapter({ supervisorDir: dir });
    const report = await runConformance(
      {
        name: "workspace",
        adapter,
        cases: workspaceCases(),
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
    // Both areas the pack covers count as established.
    for (const area of report.areas) {
      assert.equal(area.established, true, area.area);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the attachment cases wait for their test authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-conf-ws-gated-"));
  try {
    const report = await runConformance(
      {
        name: "workspace",
        adapter: new LocalProcessAdapter({ supervisorDir: dir }),
        cases: workspaceCases(),
      },
      {
        authority: {
          principal: "conformance-test",
          policyRef: "policy://conformance",
        },
        adapterVersion: "1.0.0-test",
      },
    );
    // The pure cases pass; the cases that attach one environment
    // through the loaded adapter skip, and the run stays incomplete.
    const gated = report.results.filter((entry) => entry.outcome === "skip");
    assert.equal(gated.length, 3);
    assert.ok(gated.every((entry) => entry.reason === "external-effects-not-authorized"));
    assert.equal(report.summary.failed, 0);
    assert.equal(report.verdict, "incomplete");
    const authority = report.areas.find((entry) => entry.area === "workspace-authority")!;
    assert.equal(authority.established, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
