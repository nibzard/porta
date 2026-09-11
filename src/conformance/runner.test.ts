import test from "node:test";
import assert from "node:assert/strict";
import { FakeEnvironmentAdapter } from "../adapters/test-adapter.js";
import { policyDeniedError } from "../core/errors.js";
import { SPEC_VERSION } from "../version.js";
import { assertValid, jsonRoundTrip } from "../schema/validate.js";
import { conformanceReportSchema } from "../schema/conformance.js";
import { runConformance } from "./runner.js";
import type {
  ConformanceCase,
  ConformanceCaseAnswer,
  ConformanceOptions,
} from "./runner.js";

function isPortableCode(
  value: unknown,
): value is { code: string; message?: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
async function refuse(
  run: () => unknown | Promise<unknown>,
): Promise<{ code: string; message?: string; details?: unknown } | null> {
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

/** The options every run in this file shares. */
function optionsOf(patch: Partial<ConformanceOptions> = {}): ConformanceOptions {
  return {
    authority: { principal: "conformance-test", policyRef: "policy://conformance" },
    adapterVersion: "1.0.0-test",
    providerConfiguration: { template: "small", region: "test-1" },
    ...patch,
  };
}

/** One case built inline. */
function caseOf(
  id: string,
  run: ConformanceCase["run"],
  extra: Partial<ConformanceCase> = {},
): ConformanceCase {
  return {
    id,
    area: "acquisition",
    summary: `The ${id} case.`,
    run,
    ...extra,
  };
}

test("reports identify the run and count every case honestly", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const report = await runConformance(
    {
      name: "suite-report",
      adapter,
      cases: [
        caseOf("acquisition.pass", async () => undefined, {
          capability: "exec.process@1",
        }),
        caseOf("acquisition.fail", async () => ({
          outcome: "fail",
          reason: "adapter answered wrong",
          detail: "expected one offer",
        })),
        caseOf("matching.skip", async () => ({ outcome: "skip", reason: "case pack not built" }), {
          area: "matching",
          capability: "exec.process@1",
        }),
      ],
    },
    optionsOf(),
  );

  // The report names what ran, against what, and under which rules.
  assert.equal(report.kind, "portable.conformance");
  assert.equal(report.suite, "suite-report");
  assert.equal(report.specVersion, SPEC_VERSION);
  assert.equal(report.adapterId, "adapter.fake");
  assert.equal(report.adapterVersion, "1.0.0-test");
  assert.deepEqual(report.providerConfiguration, { template: "small", region: "test-1" });
  assert.deepEqual(report.capabilityProfiles, ["exec.process@1"]);
  assert.deepEqual(report.authority, {
    principal: "conformance-test",
    policyRef: "policy://conformance",
    externalEffects: false,
    paidAllocation: false,
  });

  // Every case appears once, with its own outcome and its reason.
  assert.deepEqual(
    report.results.map((entry) => [entry.id, entry.outcome]),
    [
      ["acquisition.pass", "pass"],
      ["acquisition.fail", "fail"],
      ["matching.skip", "skip"],
    ],
  );
  assert.equal(report.results[1]!.reason, "adapter answered wrong");
  assert.equal(report.results[1]!.detail, "expected one offer");
  assert.ok(report.results.every((entry) => entry.durationMs >= 0));

  assert.deepEqual(report.summary, { total: 3, passed: 1, failed: 1, skipped: 1 });
  assert.equal(report.verdict, "fail");
  // A skip keeps its area from counting as established, even beside
  // passes.
  const matching = report.areas.find((entry) => entry.area === "matching")!;
  assert.deepEqual(
    { ...matching },
    { area: "matching", passed: 0, failed: 0, skipped: 1, established: false },
  );
  const acquisition = report.areas.find((entry) => entry.area === "acquisition")!;
  assert.equal(acquisition.established, false);

  // The report is a public record: schema-valid and JSON-stable.
  assertValid(conformanceReportSchema, report);
  assert.deepEqual(jsonRoundTrip(conformanceReportSchema, report), report);
});

test("a run with skips reports incomplete, never pass", async () => {
  const report = await runConformance(
    {
      name: "suite-skip-only",
      adapter: new FakeEnvironmentAdapter(),
      cases: [
        caseOf("acquisition.pass", async () => undefined),
        caseOf("matching.skip", async () => ({ outcome: "skip", reason: "not built" }), {
          area: "matching",
        }),
      ],
    },
    optionsOf(),
  );
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.verdict, "incomplete");
  // Skipped cases never count as passing support.
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.total, 2);
});

test("cases needing effects or payment run only under their grants", async () => {
  let externalRuns = 0;
  let paidRuns = 0;
  const cases: ConformanceCase[] = [
    caseOf(
      "process.external",
      async () => {
        externalRuns += 1;
        return undefined;
      },
      { effects: { external: true } },
    ),
    caseOf(
      "acquisition.paid",
      async () => {
        paidRuns += 1;
        return undefined;
      },
      { effects: { paid: true } },
    ),
    caseOf("acquisition.free", async () => undefined),
  ];

  const refused = await runConformance(
    { name: "suite-gated", adapter: new FakeEnvironmentAdapter(), cases },
    optionsOf(),
  );
  // Without the grants nothing ran, and the skips say which grant was
  // missing — they never count as support.
  assert.equal(externalRuns, 0);
  assert.equal(paidRuns, 0);
  assert.deepEqual(
    refused.results.map((entry) => [entry.id, entry.outcome, entry.reason]),
    [
      ["process.external", "skip", "external-effects-not-authorized"],
      ["acquisition.paid", "skip", "paid-allocation-not-authorized"],
      ["acquisition.free", "pass", undefined],
    ],
  );
  assert.equal(refused.verdict, "incomplete");

  const granted = await runConformance(
    { name: "suite-granted", adapter: new FakeEnvironmentAdapter(), cases },
    optionsOf({
      authority: {
        principal: "conformance-test",
        policyRef: "policy://conformance",
        externalEffects: true,
        paidAllocation: true,
      },
    }),
  );
  assert.equal(externalRuns, 1);
  assert.equal(paidRuns, 1);
  assert.deepEqual(
    granted.authority,
    {
      principal: "conformance-test",
      policyRef: "policy://conformance",
      externalEffects: true,
      paidAllocation: true,
    },
  );
  assert.equal(granted.verdict, "pass");
  assert.equal(granted.summary.skipped, 0);
});

test("throwing cases fail with their own code and budgets stop hangers", async () => {
  const report = await runConformance(
    {
      name: "suite-throwing",
      adapter: new FakeEnvironmentAdapter(),
      cases: [
        caseOf("matching.denied", async () => {
          throw policyDeniedError("The adapter must refuse.", { dimension: "operations" });
        }),
        caseOf("matching.crash", async () => {
          throw new Error("the adapter disconnected");
        }),
        caseOf("matching.hangs", () => new Promise<ConformanceCaseAnswer>(() => undefined)),
      ],
    },
    optionsOf({ caseTimeoutMs: 20 }),
  );
  const denied = report.results.find((entry) => entry.id === "matching.denied")!;
  assert.equal(denied.outcome, "fail");
  assert.equal(denied.reason, "PolicyDenied");
  const crash = report.results.find((entry) => entry.id === "matching.crash")!;
  assert.equal(crash.outcome, "fail");
  assert.equal(crash.reason, "case-error");
  assert.equal(crash.detail, "the adapter disconnected");
  const hung = report.results.find((entry) => entry.id === "matching.hangs")!;
  assert.equal(hung.outcome, "fail");
  assert.match(hung.detail ?? "", /exceeded its 20 ms budget/);
  assert.equal(report.verdict, "fail");
});

test("a case can drive the adapter it was loaded with", async () => {
  const offers = [
    {
      providerId: "adapter.fake",
      platform: { os: "linux", arch: "x64" },
      capabilities: [{ id: "exec.process@1", attributes: processAttributes() }],
    },
  ];
  const adapter = new FakeEnvironmentAdapter({ offers });
  const report = await runConformance(
    {
      name: "suite-live",
      adapter,
      cases: [
        caseOf(
          "matching.describe",
          async (context) => {
            const described = await context.adapter.describe();
            if (described.length !== 1) {
              return { outcome: "fail", reason: `expected one offer, saw ${described.length}` };
            }
            return undefined;
          },
          { area: "matching", capability: "exec.process@1" },
        ),
      ],
    },
    optionsOf(),
  );
  assert.equal(report.verdict, "pass");
  assert.deepEqual(report.capabilityProfiles, ["exec.process@1"]);
});

test("suites with duplicate ids or no cases refuse", async () => {
  const adapter = new FakeEnvironmentAdapter();
  const duplicate = await refuse(() =>
    runConformance(
      {
        name: "suite-duplicate",
        adapter,
        cases: [
          caseOf("acquisition.same", async () => undefined),
          caseOf("acquisition.same", async () => undefined),
        ],
      },
      optionsOf(),
    ),
  );
  assert.equal(duplicate?.code, "InvalidRequest");

  const empty = await refuse(() =>
    runConformance({ name: "suite-empty", adapter, cases: [] }, optionsOf()),
  );
  assert.equal(empty?.code, "InvalidRequest");
});

/** Minimal process attributes for an inline offer. */
function processAttributes(): Record<string, unknown> {
  return {
    isolation: "process",
    filesystem: "workspace-copy",
    network: "loopback-only",
    capabilities: ["spawn"],
  };
}
