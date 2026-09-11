import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, validateAgainstSchema } from "../schema/validate.js";
import { portableErrorSchema } from "../schema/error.js";
import type { PortableError } from "../schema/error.js";
import {
  ALL_ERROR_CODES,
  ERROR_TAXONOMY,
  ambiguousEnvironmentError,
  cleanupPendingError,
  failureCategory,
  handoffBlockedError,
  integrityFailureError,
  invalidRequestError,
  invalidRequestFromValidation,
  isProviderFailure,
  isSafeRetry,
  leaseExpiredError,
  operationUnknownError,
  policyDeniedError,
  portableError,
  providerUnavailableError,
  requestConflictError,
  requirementUnsatisfiedError,
  sanitizeError,
  scrubStringValue,
  serializeError,
  staleHandleError,
  toPortableError,
  unsupportedOperationError,
  workspaceConflictError,
  workspaceUnstableError,
} from "./errors.js";

test("every required code has taxonomy metadata", () => {
  assert.equal(ALL_ERROR_CODES.length, 15);
  for (const code of ALL_ERROR_CODES) {
    const spec = ERROR_TAXONOMY[code];
    assert.ok(spec, `missing taxonomy for ${code}`);
    assert.equal(typeof spec.description, "string");
    assert.ok(spec.description.length > 0, `empty description for ${code}`);
    assert.ok(
      ["safe", "after-reconciliation", "never"].includes(spec.defaultRetry),
      `bad retry for ${code}`,
    );
  }
});

test("the taxonomy distinguishes input, policy, semantic, and provider", () => {
  const categories = new Set(ALL_ERROR_CODES.map((code) => ERROR_TAXONOMY[code].category));
  for (const required of ["input", "policy", "semantic", "provider"]) {
    assert.ok(categories.has(required as never), `missing category ${required}`);
  }
});

test("every required code serializes stably through its factory", () => {
  const messages: Record<string, () => PortableError> = {
    InvalidRequest: () => invalidRequestError("bad shape"),
    RequirementUnsatisfied: () => requirementUnsatisfiedError("no match"),
    AmbiguousEnvironment: () => ambiguousEnvironmentError("two matches"),
    PolicyDenied: () => policyDeniedError("not allowed"),
    UnsupportedOperation: () => unsupportedOperationError("exec.process@1", "shell"),
    StaleHandle: () => staleHandleError({ kind: "generation", value: 2 }, { kind: "generation", value: 3 }),
    LeaseExpired: () => leaseExpiredError("att_01", "2026-09-11T13:00:00Z"),
    WorkspaceConflict: () => workspaceConflictError("rev_01", "rev_02"),
    WorkspaceUnstable: () => workspaceUnstableError("source changed"),
    IntegrityFailure: () => integrityFailureError("blob", "a".repeat(64), "b".repeat(64)),
    RequestConflict: () => requestConflictError("rk-1", "different input"),
    OperationUnknown: () => operationUnknownError("op_01", "response lost"),
    HandoffBlocked: () => handoffBlockedError("unknown operation"),
    ProviderUnavailable: () => providerUnavailableError("unreachable"),
    CleanupPending: () => cleanupPendingError("acq_01", "release failed"),
  };
  for (const code of ALL_ERROR_CODES) {
    const factory = messages[code];
    assert.ok(factory, `no factory for ${code}`);
    const error = factory();
    assert.equal(error.code, code);
    assert.deepEqual(validateAgainstSchema(portableErrorSchema, error), []);
    const parsed = JSON.parse(serializeError(error));
    assert.deepEqual(parsed, error);
  }
});

test("default retry classifications match the taxonomy", () => {
  assert.equal(policyDeniedError("x").retry, "never");
  assert.equal(providerUnavailableError("x").retry, "safe");
  assert.equal(operationUnknownError("op_1", "x").retry, "after-reconciliation");
  assert.equal(leaseExpiredError("a", "2026-09-11T13:00:00Z").retry, "after-reconciliation");
  assert.equal(workspaceConflictError("a", "b").retry, "never");
});

test("category and retry helpers classify errors", () => {
  assert.equal(failureCategory("PolicyDenied"), "policy");
  assert.equal(failureCategory("InvalidRequest"), "input");
  assert.equal(failureCategory("UnsupportedOperation"), "semantic");
  assert.ok(isProviderFailure(providerUnavailableError("down")));
  assert.ok(!isProviderFailure(policyDeniedError("no")));
  assert.ok(isSafeRetry(providerUnavailableError("down")));
  assert.ok(!isSafeRetry(policyDeniedError("no")));
});

test("construction scrubs credential keys and values from details", () => {
  const error = portableError("ProviderUnavailable", "connection failed", {
    details: {
      endpoint: "https://api.example.test",
      authorization: "Bearer abc123",
      nested: { apiKey: "sk-abcdefgh1234", keep: 42, cookie: "session=1" },
      note: "used token sk-abcdefgh1234 at 12:00",
    },
  });
  const text = JSON.stringify(error.details);
  assert.ok(!text.includes("abc123"));
  assert.ok(!text.includes("sk-abcdefgh1234"));
  assert.ok(!text.includes("session=1"));
  assert.ok(text.includes("endpoint"));
  assert.ok(text.includes("keep"));
  const details = error.details as Record<string, unknown>;
  assert.ok(!("authorization" in details));
  const nested = details.nested as Record<string, unknown>;
  assert.ok(!("apiKey" in nested));
  assert.ok(!("cookie" in nested));
  assert.equal(nested.keep, 42);
});

test("message text with credential shapes is redacted", () => {
  const scrubbed = scrubStringValue("failed after Bearer eyJhbGciOi.905x");
  assert.ok(scrubbed.includes("[redacted]"));
  assert.ok(!scrubbed.includes("eyJhbGciOi"));
  const error = portableError("InvalidRequest", "key ghp_abcdefghijklmnopqrst turned out invalid");
  assert.ok(!error.message.includes("ghp_"));
});

test("benign technical values survive scrubbing", () => {
  const digest = "a".repeat(64);
  const error = portableError("IntegrityFailure", "hash mismatch", {
    details: { expected: digest, actual: "b".repeat(64) },
  });
  assert.equal(error.details?.expected, digest);
});

test("sanitizeError cleans externally built errors", () => {
  const dirty = {
    code: "ProviderUnavailable",
    message: "auth failed for Bearer xyz",
    retry: "safe",
    details: { accessToken: "z", retryAfterMs: 500 },
  } as PortableError;
  const clean = sanitizeError(dirty);
  assert.ok(!("accessToken" in (clean.details ?? {})));
  assert.equal((clean.details as Record<string, unknown>).retryAfterMs, 500);
  assert.ok(!clean.message.includes("xyz"));
});

test("serializeError validates against the public schema", () => {
  const error = policyDeniedError("remote execution is not permitted", {
    details: { operation: "exec.process@1/run" },
  });
  const parsed = JSON.parse(serializeError(error));
  assert.deepEqual(validateAgainstSchema(portableErrorSchema, parsed), []);
});

test("toPortableError normalizes thrown values", () => {
  const fromValidation = toPortableError(
    new ValidationError([
      {
        instancePath: "/name",
        schemaPath: "#/properties/name",
        keyword: "pattern",
        message: "must match",
        params: {},
      },
    ]),
  );
  assert.equal(fromValidation.code, "InvalidRequest");
  assert.deepEqual(
    (fromValidation.details as { issues: Array<{ path: string; keyword: string }> }).issues,
    [{ path: "/name", keyword: "pattern", message: "must match" }],
  );

  const fromError = toPortableError(new Error("adapter exploded"));
  assert.equal(fromError.code, "portable.internal");
  assert.equal(fromError.retry, "never");
  assert.deepEqual(validateAgainstSchema(portableErrorSchema, fromError), []);

  const fromString = toPortableError("boom");
  assert.equal(fromString.code, "portable.internal");

  const alreadyPortable = toPortableError(policyDeniedError("no"));
  assert.equal(alreadyPortable.code, "PolicyDenied");
});

test("extension codes remain schema valid", () => {
  const error = portableError("com.example.limit.hit", "quota exhausted");
  assert.deepEqual(validateAgainstSchema(portableErrorSchema, error), []);
});
