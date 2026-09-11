import { DEFS, type Extensions, type UtcTimestamp } from "./defs.js";

/**
 * Conformance records (SPEC.md section 21).
 *
 * A conformance report states what one adapter configuration actually
 * demonstrated. It never claims universal compatibility or provider
 * security certification; it records the cases that ran, the cases
 * that failed, and — separately and never as support — the cases that
 * were skipped.
 */

/** The outcome of one conformance case. */
export type ConformanceOutcome = "pass" | "fail" | "skip";

/**
 * The verdict of one run.
 *
 * `incomplete` means no case failed but at least one skipped: a
 * skipped case never counts as supported behavior, so the run cannot
 * report conformance for it.
 */
export type ConformanceVerdict = "pass" | "fail" | "incomplete";

/** The configured authority under which the run executed cases. */
export interface ConformanceAuthorityRecord {
  /** Authenticated principal supplied by the embedding application. */
  principal: string;
  /** The policy the run executed under. */
  policyRef: string;
  /** Whether external effects were authorized. */
  externalEffects: boolean;
  /** Whether paid allocation was authorized. */
  paidAllocation: boolean;
}

/** The record of one executed (or skipped) case. */
export interface ConformanceCaseRecord {
  /** Stable case identity, unique inside its suite. */
  id: string;
  /** The SPEC.md section 21 area the case belongs to. */
  area: string;
  /** The capability profile the case exercises, when it names one. */
  capability?: string;
  /** One line stating what the case checks. */
  summary: string;
  outcome: ConformanceOutcome;
  /** Why the case failed or skipped, in the runner's own terms. */
  reason?: string;
  /** Extra context: a provider answer, an error message. */
  detail?: string;
  /** How long the case ran, or how long it took to skip. */
  durationMs: number;
}

/** The per-area tally of one run. */
export interface ConformanceAreaRecord {
  area: string;
  passed: number;
  failed: number;
  skipped: number;
  /**
   * False when any case in the area failed or skipped. Only a clean
   * area counts as established behavior.
   */
  established: boolean;
}

/** The machine-readable report of one conformance run. */
export interface ConformanceReport {
  schemaVersion: 1;
  kind: "portable.conformance";
  /** The suite that ran, by name. */
  suite: string;
  /** The specification version the cases were written against. */
  specVersion: string;
  /** The adapter under test, by its own identity. */
  adapterId: string;
  /** The adapter build the embedding loaded. */
  adapterVersion: string;
  /** The provider configuration the adapter ran against. */
  providerConfiguration: Record<string, unknown>;
  /** Every capability profile the executed cases exercised. */
  capabilityProfiles: string[];
  authority: ConformanceAuthorityRecord;
  results: ConformanceCaseRecord[];
  areas: ConformanceAreaRecord[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  verdict: ConformanceVerdict;
  completedAt: UtcTimestamp;
  extensions?: Extensions;
}

export const conformanceReportSchema = {
  $id: "https://portable.dev/schema/conformance-report.json",
  $defs: DEFS,
  type: "object",
  required: [
    "schemaVersion",
    "kind",
    "suite",
    "specVersion",
    "adapterId",
    "adapterVersion",
    "providerConfiguration",
    "capabilityProfiles",
    "authority",
    "results",
    "areas",
    "summary",
    "verdict",
    "completedAt",
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { $ref: "#/$defs/schemaVersion" },
    kind: { const: "portable.conformance" },
    suite: { $ref: "#/$defs/identifier" },
    specVersion: { type: "string", minLength: 1, maxLength: 64 },
    adapterId: { $ref: "#/$defs/identifier" },
    adapterVersion: { type: "string", minLength: 1, maxLength: 64 },
    providerConfiguration: { type: "object" },
    capabilityProfiles: {
      type: "array",
      items: { $ref: "#/$defs/capabilityId" },
      uniqueItems: true,
    },
    authority: {
      type: "object",
      required: ["principal", "policyRef", "externalEffects", "paidAllocation"],
      additionalProperties: false,
      properties: {
        principal: { $ref: "#/$defs/identifier" },
        policyRef: { type: "string", minLength: 1, maxLength: 512 },
        externalEffects: { type: "boolean" },
        paidAllocation: { type: "boolean" },
      },
    },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "area", "summary", "outcome", "durationMs"],
        additionalProperties: false,
        properties: {
          id: { $ref: "#/$defs/identifier" },
          area: { type: "string", minLength: 1, maxLength: 64 },
          capability: { $ref: "#/$defs/capabilityId" },
          summary: { type: "string", minLength: 1, maxLength: 512 },
          outcome: { enum: ["pass", "fail", "skip"] },
          reason: { type: "string", minLength: 1, maxLength: 512 },
          detail: { type: "string", maxLength: 2048 },
          durationMs: { type: "number", minimum: 0 },
        },
      },
    },
    areas: {
      type: "array",
      items: {
        type: "object",
        required: ["area", "passed", "failed", "skipped", "established"],
        additionalProperties: false,
        properties: {
          area: { type: "string", minLength: 1, maxLength: 64 },
          passed: { type: "integer", minimum: 0 },
          failed: { type: "integer", minimum: 0 },
          skipped: { type: "integer", minimum: 0 },
          established: { type: "boolean" },
        },
      },
    },
    summary: {
      type: "object",
      required: ["total", "passed", "failed", "skipped"],
      additionalProperties: false,
      properties: {
        total: { type: "integer", minimum: 0 },
        passed: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        skipped: { type: "integer", minimum: 0 },
      },
    },
    verdict: { enum: ["pass", "fail", "incomplete"] },
    completedAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
