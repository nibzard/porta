import { invalidRequestError, isPortableError } from "../core/errors.js";
import { SPEC_VERSION } from "../version.js";
import { assertValid } from "../schema/validate.js";
import { conformanceReportSchema } from "../schema/conformance.js";
import type {
  ConformanceAreaRecord,
  ConformanceAuthorityRecord,
  ConformanceCaseRecord,
  ConformanceReport,
  ConformanceVerdict,
} from "../schema/conformance.js";
import type { EnvironmentAdapter } from "../schema/adapter.js";

/**
 * The reusable conformance runner (SPEC.md section 21).
 *
 * The runner loads one adapter, executes the capability cases of one
 * suite under a configured test authority, and returns a
 * machine-readable report. The report states what the tested
 * configuration demonstrated — nothing more: it never claims universal
 * compatibility or provider security certification.
 *
 * Three rules hold everywhere in this module:
 *
 * - A skipped case never counts as support. A run whose only blemish
 *   is a skip reports `incomplete`, not `pass`, and the area it
 *   belonged to reports `established: false`.
 * - Cases that cause external effects or allocate paid resources run
 *   only under an authority that explicitly grants them. Without the
 *   grant the runner skips the case and says why.
 * - The report is a public record: it validates against its own JSON
 *   Schema before the caller ever sees it.
 */

/** What one case needs beyond pure reads of the adapter. */
export interface ConformanceEffects {
  /** The case causes effects outside the test process. */
  external?: boolean;
  /** The case allocates resources a provider charges for. */
  paid?: boolean;
}

/** The answer one case gives the runner. */
export type ConformanceCaseAnswer =
  | { outcome: "pass"; detail?: string }
  | { outcome: "fail"; reason: string; detail?: string }
  | { outcome: "skip"; reason: string; detail?: string };

/** What one case can use: the adapter under test and the run's facts. */
export interface ConformanceContext {
  /** The adapter the suite loaded. */
  adapter: EnvironmentAdapter;
  /** The resolved test authority the run executes under. */
  authority: ConformanceAuthorityRecord;
  /** The provider configuration the report will name. */
  providerConfiguration: Record<string, unknown>;
}

/**
 * One conformance case (SPEC.md section 21).
 *
 * A case reports a skip by returning it. Throwing is always a
 * failure: an unexpected error is a finding about the adapter or the
 * case, never a reason to quietly drop coverage.
 */
export interface ConformanceCase {
  /** Stable identity, unique inside its suite. */
  id: string;
  /** The SPEC.md section 21 area the case belongs to. */
  area: string;
  /** The capability profile the case exercises, when it names one. */
  capability?: string;
  /** One line stating what the case checks. */
  summary: string;
  /** What the case needs beyond pure reads. */
  effects?: ConformanceEffects;
  run(context: ConformanceContext): Promise<ConformanceCaseAnswer | void>;
}

/** One suite: an adapter plus the cases that exercise it. */
export interface ConformanceSuite {
  name: string;
  adapter: EnvironmentAdapter;
  cases: ConformanceCase[];
}

/**
 * The authority a run executes under.
 *
 * Both grants default to refused: a caller enables external effects
 * or paid allocation by saying so, never by omitting a denial.
 */
export interface ConformanceTestAuthority {
  principal: string;
  policyRef: string;
  /** Whether external effects are authorized. Default false. */
  externalEffects?: boolean;
  /** Whether paid allocation is authorized. Default false. */
  paidAllocation?: boolean;
}

/** Options of one conformance run. */
export interface ConformanceOptions {
  /** The authority the run executes cases under. */
  authority: ConformanceTestAuthority;
  /**
   * The adapter build the embedding loaded. The adapter interface
   * carries no version, so the caller states what it loaded.
   */
  adapterVersion: string;
  /** The provider configuration the adapter runs against. */
  providerConfiguration?: Record<string, unknown>;
  /** Per-case wall-clock budget. A case that exceeds it fails. */
  caseTimeoutMs?: number;
}

/** The default per-case budget: one minute. */
const DEFAULT_CASE_TIMEOUT_MS = 60_000;

/**
 * Run one suite against its adapter and return the report
 * (SPEC.md section 21).
 *
 * Cases run in suite order, one at a time, so a failing case cannot
 * mask the ones after it. The report is complete even when cases
 * fail: every case appears with its own outcome.
 */
export async function runConformance(
  suite: ConformanceSuite,
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  requireUniqueIds(suite);
  const authority: ConformanceAuthorityRecord = {
    principal: options.authority.principal,
    policyRef: options.authority.policyRef,
    externalEffects: options.authority.externalEffects ?? false,
    paidAllocation: options.authority.paidAllocation ?? false,
  };
  const providerConfiguration = options.providerConfiguration ?? {};
  const timeoutMs = options.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;

  const results: ConformanceCaseRecord[] = [];
  for (const entry of suite.cases) {
    results.push(
      await execute(
        entry,
        {
          adapter: suite.adapter,
          authority,
          providerConfiguration,
        },
        timeoutMs,
      ),
    );
  }

  const report = assemble({
    suite: suite.name,
    adapterId: suite.adapter.id,
    adapterVersion: options.adapterVersion,
    providerConfiguration,
    authority,
    results,
  });
  assertValid(conformanceReportSchema, report);
  return report;
}

/** Refuse a suite whose case ids collide: reports stay unambiguous. */
function requireUniqueIds(suite: ConformanceSuite): void {
  if (suite.cases.length === 0) {
    throw invalidRequestError("A conformance suite needs at least one case.", {
      suite: suite.name,
    });
  }
  const seen = new Set<string>();
  for (const entry of suite.cases) {
    if (seen.has(entry.id)) {
      throw invalidRequestError(
        `Case ${entry.id} appears twice; case ids must be unique inside a suite.`,
        { suite: suite.name, caseId: entry.id },
      );
    }
    seen.add(entry.id);
  }
}

/** Run one case under the authority and budget it declares. */
async function execute(
  entry: ConformanceCase,
  context: ConformanceContext,
  timeoutMs: number,
): Promise<ConformanceCaseRecord> {
  const started = Date.now();

  // Authority gates come first: a case the authority does not cover
  // never runs, and the skip says exactly which grant was missing.
  if (entry.effects?.external === true && !context.authority.externalEffects) {
    return skipped(entry, started, "external-effects-not-authorized");
  }
  if (entry.effects?.paid === true && !context.authority.paidAllocation) {
    return skipped(entry, started, "paid-allocation-not-authorized");
  }

  let answer: ConformanceCaseAnswer | void;
  try {
    answer = await withDeadline(entry.run(context), timeoutMs);
  } catch (error) {
    return failed(entry, started, error);
  }
  if (answer === undefined || answer === null) {
    return passed(entry, started);
  }
  const record: ConformanceCaseRecord = {
    id: entry.id,
    area: entry.area,
    ...(entry.capability !== undefined ? { capability: entry.capability } : {}),
    summary: entry.summary,
    outcome: answer.outcome,
    ...(answer.outcome === "fail" || answer.outcome === "skip"
      ? { reason: answer.reason }
      : {}),
    ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
    durationMs: Date.now() - started,
  };
  return record;
}

/** Race one case against its deadline; a timeout is a failure. */
async function withDeadline<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The case exceeded its ${timeoutMs} ms budget.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([pending.finally(() => clearTimeout(timer)), guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** The record of one case the authority refused to run. */
function skipped(
  entry: ConformanceCase,
  started: number,
  reason: string,
): ConformanceCaseRecord {
  return {
    id: entry.id,
    area: entry.area,
    ...(entry.capability !== undefined ? { capability: entry.capability } : {}),
    summary: entry.summary,
    outcome: "skip",
    reason,
    durationMs: Date.now() - started,
  };
}

/** The record of one case that passed. */
function passed(entry: ConformanceCase, started: number): ConformanceCaseRecord {
  return {
    id: entry.id,
    area: entry.area,
    ...(entry.capability !== undefined ? { capability: entry.capability } : {}),
    summary: entry.summary,
    outcome: "pass",
    durationMs: Date.now() - started,
  };
}

/** The record of one case that threw: what threw is the finding. */
function failed(
  entry: ConformanceCase,
  started: number,
  error: unknown,
): ConformanceCaseRecord {
  // Portable errors are plain records, not Error instances; both carry
  // a message worth reporting.
  const detail =
    error !== null && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return {
    id: entry.id,
    area: entry.area,
    ...(entry.capability !== undefined ? { capability: entry.capability } : {}),
    summary: entry.summary,
    outcome: "fail",
    reason: isPortableError(error) ? error.code : "case-error",
    detail: detail.length > 2048 ? detail.slice(0, 2045) + "..." : detail,
    durationMs: Date.now() - started,
  };
}

/** Fold the case records into the report. */
function assemble(facts: {
  suite: string;
  adapterId: string;
  adapterVersion: string;
  providerConfiguration: Record<string, unknown>;
  authority: ConformanceAuthorityRecord;
  results: ConformanceCaseRecord[];
}): ConformanceReport {
  const passed = facts.results.filter((entry) => entry.outcome === "pass").length;
  const failed = facts.results.filter((entry) => entry.outcome === "fail").length;
  const skipped = facts.results.filter((entry) => entry.outcome === "skip").length;

  const areas: ConformanceAreaRecord[] = [];
  for (const area of orderedAreas(facts.results)) {
    const own = facts.results.filter((entry) => entry.area === area);
    const areaFailed = own.filter((entry) => entry.outcome === "fail").length;
    const areaSkipped = own.filter((entry) => entry.outcome === "skip").length;
    areas.push({
      area,
      passed: own.filter((entry) => entry.outcome === "pass").length,
      failed: areaFailed,
      skipped: areaSkipped,
      established: areaFailed === 0 && areaSkipped === 0,
    });
  }

  const verdict: ConformanceVerdict =
    failed > 0 ? "fail" : skipped > 0 ? "incomplete" : "pass";
  return {
    schemaVersion: 1,
    kind: "portable.conformance",
    suite: facts.suite,
    specVersion: SPEC_VERSION,
    adapterId: facts.adapterId,
    adapterVersion: facts.adapterVersion,
    providerConfiguration: facts.providerConfiguration,
    capabilityProfiles: capabilityProfilesOf(facts.results),
    authority: facts.authority,
    results: facts.results,
    areas,
    summary: { total: facts.results.length, passed, failed, skipped },
    verdict,
    completedAt: new Date().toISOString(),
  };
}

/** The areas in first-seen order. */
function orderedAreas(results: ConformanceCaseRecord[]): string[] {
  const areas: string[] = [];
  for (const entry of results) {
    if (!areas.includes(entry.area)) {
      areas.push(entry.area);
    }
  }
  return areas;
}

/** Every capability profile the results exercised, in first-seen order. */
function capabilityProfilesOf(results: ConformanceCaseRecord[]): string[] {
  const profiles: string[] = [];
  for (const entry of results) {
    if (entry.capability !== undefined && !profiles.includes(entry.capability)) {
      profiles.push(entry.capability);
    }
  }
  return profiles;
}
