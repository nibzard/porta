import { createRequire } from "node:module";
import { isUtcTimestamp } from "../core/time.js";
import { portableErrorSchema } from "./error.js";
import { portableEventSchema } from "./event.js";
import { sessionRecordSchema } from "./session.js";
import {
  attachmentRefSchema,
  attachmentSummarySchema,
  sessionDescriptionSchema,
  sessionOptionsSchema,
} from "./session.js";
import {
  adapterInvocationSchema,
  acquisitionStatusSchema,
  authorizedAcquireRequestSchema,
  bindingResultSchema,
  cancellationResultSchema,
  leaseStatusSchema,
  releaseResultSchema,
  adapterOperationSchema,
} from "./adapter.js";
import {
  artifactRecordSchema,
  invocationRequestSchema,
  operationRecordSchema,
  outputChunkSchema,
} from "./operation.js";
import { acquisitionLimitsSchema, policySchema } from "./policy.js";
import {
  capabilityDescriptorSchema,
  enforcementFactsSchema,
  environmentManifestSchema,
  environmentOfferSchema,
  environmentRequestSchema,
  operationDescriptorSchema,
  resourceRequirementsSchema,
  resourceSummarySchema,
} from "./capability.js";
import {
  resourceDescriptionSchema,
  resourceRefSchema,
} from "./resource.js";
import {
  checkpointRequestSchema,
  workspaceProposalSchema,
  workspaceRevisionSchema,
} from "./workspace.js";
import {
  cleanupObligationSchema,
  destinationRequestSchema,
  handoffPlanSchema,
  handoffResultSchema,
  reconstructionRecipeSchema,
  replaceRequestSchema,
  stateDispositionSchema,
} from "./handoff.js";
import { bundleManifestSchema } from "./bundle.js";

/** One field-specific validation failure. */
export interface ValidationIssue {
  /** Path to the failing field inside the validated value. */
  instancePath: string;
  /** Path inside the schema that produced the failure. */
  schemaPath: string;
  /** Failing keyword, such as `pattern`, `required`, or `format`. */
  keyword: string;
  /** Human-readable explanation. */
  message?: string | undefined;
  /** Keyword parameters, such as the missing property name. */
  params: Record<string, unknown>;
}

/**
 * Construct the draft 2020-12 validator.
 *
 * ajv compiles to CommonJS. A default import under Node ESM yields the
 * module namespace, not the class, so the constructor comes from
 * `createRequire`. The type comes from a type-only import.
 */
function loadAjv2020(): typeof import("ajv/dist/2020.js")["default"] {
  const require = createRequire(import.meta.url);
  const module = require("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js");
  return module.default;
}

const ajv = new (loadAjv2020())({ allErrors: true });
ajv.addFormat("utc-timestamp", {
  type: "string",
  validate: isUtcTimestamp,
});

/**
 * All public schemas, registered by `$id` so cross-schema references
 * resolve regardless of validation order.
 */
const ALL_SCHEMAS = [
  portableErrorSchema,
  portableEventSchema,
  sessionRecordSchema,
  attachmentRefSchema,
  attachmentSummarySchema,
  sessionDescriptionSchema,
  sessionOptionsSchema,
  operationDescriptorSchema,
  capabilityDescriptorSchema,
  resourceSummarySchema,
  resourceRequirementsSchema,
  enforcementFactsSchema,
  environmentManifestSchema,
  environmentRequestSchema,
  environmentOfferSchema,
  authorizedAcquireRequestSchema,
  acquisitionStatusSchema,
  adapterInvocationSchema,
  adapterOperationSchema,
  cancellationResultSchema,
  leaseStatusSchema,
  releaseResultSchema,
  bindingResultSchema,
  invocationRequestSchema,
  operationRecordSchema,
  outputChunkSchema,
  artifactRecordSchema,
  resourceRefSchema,
  resourceDescriptionSchema,
  workspaceRevisionSchema,
  workspaceProposalSchema,
  checkpointRequestSchema,
  stateDispositionSchema,
  reconstructionRecipeSchema,
  destinationRequestSchema,
  replaceRequestSchema,
  handoffPlanSchema,
  handoffResultSchema,
  cleanupObligationSchema,
  bundleManifestSchema,
  policySchema,
  acquisitionLimitsSchema,
] as const;

for (const schema of ALL_SCHEMAS) {
  ajv.addSchema(schema);
}

const adHocCompiled = new WeakMap<object, (data: unknown) => boolean>();

type ValidateFn = (data: unknown) => boolean;

function resolveValidator(schema: object): ValidateFn {
  const id = (schema as { $id?: string }).$id;
  if (typeof id === "string") {
    const registered = ajv.getSchema(id);
    if (registered !== undefined) {
      return registered as ValidateFn;
    }
  }
  let validate = adHocCompiled.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema) as ValidateFn;
    adHocCompiled.set(schema, validate);
  }
  return validate;
}

/**
 * Validate a value against a draft 2020-12 schema.
 *
 * Returns one issue per failing field. An empty array means the value is
 * valid. Runtime code validates every external input before any side effect.
 */
export function validateAgainstSchema(
  schema: object,
  value: unknown,
): ValidationIssue[] {
  const validate = resolveValidator(schema);
  if (validate(value)) {
    return [];
  }
  const errors = (validate as unknown as { errors: unknown[] | null }).errors ?? [];
  return errors.map((raw) => {
    const failure = raw as {
      instancePath: string;
      schemaPath: string;
      keyword: string;
      message?: string;
      params?: Record<string, unknown>;
    };
    return {
      instancePath: failure.instancePath,
      schemaPath: failure.schemaPath,
      keyword: failure.keyword,
      message: failure.message,
      params: failure.params ?? {},
    };
  });
}

/** Thrown when a value fails schema validation. */
export class ValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const fields = issues
      .map((issue) => `${issue.instancePath || "/"} ${issue.message ?? issue.keyword}`)
      .join("; ");
    super(`Validation failed: ${fields}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/**
 * Validate a value and throw a `ValidationError` on failure.
 *
 * Use this at trust boundaries where invalid input must stop the call before
 * any side effect occurs.
 */
export function assertValid(schema: object, value: unknown): void {
  const issues = validateAgainstSchema(schema, value);
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
}

/**
 * Round-trip a record through JSON and validate the parsed value.
 *
 * Public records stay JSON-serializable (SPEC.md section 15). This helper
 * proves the property for a sample and returns the parsed copy.
 */
export function jsonRoundTrip(schema: object, value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  assertValid(schema, parsed);
  return parsed;
}

/**
 * Check that a value is a compilable JSON Schema draft 2020-12 schema.
 *
 * Returns an empty list when the schema compiles. Capability descriptors
 * use this to prove their operation input and output schemas are real
 * schemas, not arbitrary objects (SPEC.md section 6.2).
 */
export function checkJsonSchemaCompiles(schema: unknown): ValidationIssue[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return [
      {
        instancePath: "",
        schemaPath: "",
        keyword: "type",
        message: "The value is not a schema object.",
        params: { type: "object" },
      },
    ];
  }
  try {
    ajv.compile(schema);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      {
        instancePath: "",
        schemaPath: "",
        keyword: "schema",
        message,
        params: {},
      },
    ];
  }
}
