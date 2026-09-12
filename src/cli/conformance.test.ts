import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The conformance command, run as a child process (SPEC.md sections 16
 * and 21).
 *
 * Three guarantees: the documented command runs a selected profile
 * against a configured adapter; failures and skips stay distinct in
 * the machine record and the exit status; and cases that need effect
 * or payment authority do not run without the configured grant.
 */

/** The executable entry point of the CLI. */
const MAIN = fileURLToPath(new URL("./main.js", import.meta.url));

/** Run one CLI child process and capture code, stdout, and stderr. */
function run(args: string[]): { code: number; out: string[]; err: string } {
  const child = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8" });
  assert.ok(child.error === undefined, child.error?.message);
  const out = (child.stdout ?? "").split("\n").filter((line) => line.length > 0);
  return { code: child.status ?? -1, out, err: child.stderr ?? "" };
}

/** One parsed JSON record from one output line. */
function recordOf(result: { out: string[] }): Record<string, unknown> {
  assert.equal(result.out.length, 1, `expected one record, got ${result.out.length}`);
  return JSON.parse(result.out[0]!) as Record<string, unknown>;
}

/** One temporary directory with one local process adapter module. */
function fixture(): { root: string; adapter: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "porta-conformance-cli-"));
  const indexUrl = new URL("../index.js", import.meta.url).href;
  const adapter = join(root, "worker-adapter.mjs");
  writeFileSync(
    adapter,
    `import { LocalProcessAdapter } from ${JSON.stringify(indexUrl)};\n` +
      `export const adapter = new LocalProcessAdapter({ supervisorDir: ${JSON.stringify(join(root, "supervisor"))} });\n`,
  );
  return { root, adapter, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the documented command runs a selected profile against a configured adapter", () => {
  const fx = fixture();
  try {
    const result = run([
      "conformance",
      "--adapter",
      fx.adapter,
      "--adapter-version",
      "1.0.0-test",
      "--profile",
      "events,bundle",
      "--principal",
      "user://conformance",
      "--case-timeout-ms",
      "30000",
    ]);
    assert.equal(result.code, 0, result.err);
    const report = recordOf(result) as {
      suite: string;
      specVersion: string;
      adapterId: string;
      adapterVersion: string;
      providerConfiguration: { offers: { providerId: string }[] };
      capabilityProfiles: string[];
      authority: { principal: string };
      areas: { area: string; established: boolean }[];
      summary: { total: number; passed: number; failed: number; skipped: number };
      verdict: string;
    };

    // The report identifies what ran, per SPEC.md section 21.
    assert.equal(report.suite, "events+bundle");
    assert.ok(report.specVersion.length > 0);
    assert.equal(report.adapterId, "local-process");
    assert.equal(report.adapterVersion, "1.0.0-test");
    assert.equal(report.providerConfiguration.offers[0]?.providerId, "local-process");
    assert.equal(report.authority.principal, "user://conformance");
    assert.equal(report.verdict, "pass");
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.skipped, 0);
    assert.deepEqual(
      report.areas.map((entry) => entry.area),
      ["events", "bundle"],
    );
    assert.ok(report.areas.every((entry) => entry.established));
  } finally {
    fx.cleanup();
  }
});

test("a failing case exits 1 and a skipped case exits 3, both distinct in the record", () => {
  const fx = fixture();
  try {
    // Acquisition cases need external-effect authority; without the
    // grant they skip, and skipped support is not established support.
    const skipped = run([
      "conformance",
      "--adapter",
      fx.adapter,
      "--adapter-version",
      "1.0.0-test",
      "--profile",
      "acquisition-policy",
    ]);
    assert.equal(skipped.code, 3, skipped.err);
    const incomplete = recordOf(skipped) as {
      verdict: string;
      summary: { total: number; failed: number; skipped: number };
      results: { outcome: string; reason: string }[];
    };
    assert.equal(incomplete.verdict, "incomplete");
    assert.equal(incomplete.summary.failed, 0);
    const skippedCases = incomplete.results.filter((entry) => entry.outcome === "skip");
    assert.ok(skippedCases.length >= 1, "the ungated cases skipped");
    assert.ok(
      skippedCases.every((entry) => entry.reason === "external-effects-not-authorized"),
      "every skip names the missing grant",
    );

    // The same profile under the granted authority runs its cases.
    const granted = run([
      "conformance",
      "--adapter",
      fx.adapter,
      "--adapter-version",
      "1.0.0-test",
      "--profile",
      "acquisition-policy",
      "--external-effects",
    ]);
    assert.notEqual(granted.code, 3);
    const complete = recordOf(granted) as {
      verdict: string;
      summary: { skipped: number };
      authority: { externalEffects: boolean; paidAllocation: boolean };
    };
    assert.equal(complete.summary.skipped, 0);
    assert.equal(complete.authority.externalEffects, true);
    // The payment grant stayed refused: paid cases never run on an
    // unconfigured authority.
    assert.equal(complete.authority.paidAllocation, false);

    // A failing case is a known failure: exit 1 with its own outcome.
    const failing = join(fx.root, "failing-adapter.mjs");
    writeFileSync(
      failing,
      `import { LocalProcessAdapter } from ${JSON.stringify(new URL("../index.js", import.meta.url).href)};\n` +
        `const inner = new LocalProcessAdapter({ supervisorDir: ${JSON.stringify(join(fx.root, "failing-supervisor"))} });\n` +
        `export const adapter = {\n` +
        `  id: inner.id,\n` +
        `  describe: () => inner.describe(),\n` +
        `  acquire: async () => { throw Object.assign(new Error("injected provider outage"), { code: "ProviderUnavailable" }); },\n` +
        `};\n`,
    );
    const failed = run([
      "conformance",
      "--adapter",
      failing,
      "--adapter-version",
      "1.0.0-test",
      "--profile",
      "acquisition-policy",
      "--external-effects",
    ]);
    assert.equal(failed.code, 1, failed.err);
    const failure = recordOf(failed) as {
      verdict: string;
      summary: { failed: number; skipped: number };
    };
    assert.equal(failure.verdict, "fail");
    assert.ok(failure.summary.failed >= 1);
    assert.equal(failure.summary.skipped, 0);
  } finally {
    fx.cleanup();
  }
});

test("an unknown profile and a missing adapter version refuse as invalid input", () => {
  const fx = fixture();
  try {
    const unknown = run([
      "conformance",
      "--adapter",
      fx.adapter,
      "--adapter-version",
      "1.0.0-test",
      "--profile",
      "no-such-pack",
    ]);
    assert.equal(unknown.code, 2, unknown.err);
    assert.ok(unknown.err.includes("Unknown conformance profile"), unknown.err);

    const versionless = run(["conformance", "--adapter", fx.adapter]);
    assert.equal(versionless.code, 2, versionless.err);
    assert.ok(versionless.err.includes("--adapter-version"), versionless.err);
  } finally {
    fx.cleanup();
  }
});
