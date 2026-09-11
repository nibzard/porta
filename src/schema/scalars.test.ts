import test from "node:test";
import assert from "node:assert/strict";
import { isUtcTimestamp } from "../core/time.js";
import { validateAgainstSchema } from "./validate.js";

const stringSchema = (def: object) => ({
  $defs: def,
  $ref: Object.keys(def)[0] ? `#/$defs/${Object.keys(def)[0]}` : "#/$defs/x",
});

test("utc timestamps accept canonical forms", () => {
  assert.equal(isUtcTimestamp("2026-09-11T12:00:00Z"), true);
  assert.equal(isUtcTimestamp("2026-09-11T12:00:00.123Z"), true);
  assert.equal(isUtcTimestamp("2024-02-29T23:59:59Z"), true);
});

test("utc timestamps reject invalid values", () => {
  assert.equal(isUtcTimestamp("2026-02-30T00:00:00Z"), false);
  assert.equal(isUtcTimestamp("2023-02-29T00:00:00Z"), false);
  assert.equal(isUtcTimestamp("2026-09-11T12:00:00+00:00"), false);
  assert.equal(isUtcTimestamp("2026-09-11 12:00:00Z"), false);
  assert.equal(isUtcTimestamp("2026-9-11T12:00:00Z"), false);
  assert.equal(isUtcTimestamp(""), false);
});

test("attachment names follow the spec pattern", () => {
  const schema = stringSchema({ attachmentName: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,62}$" } });
  assert.deepEqual(validateAgainstSchema(schema, "build"), []);
  assert.deepEqual(validateAgainstSchema(schema, "a"), []);
  assert.deepEqual(validateAgainstSchema(schema, "web-browser-2"), []);
  for (const bad of ["Build", "1build", "build box", "", "b".repeat(64)]) {
    assert.notDeepEqual(validateAgainstSchema(schema, bad), [], `expected rejection: ${bad}`);
  }
});

test("capability identifiers use name@major", () => {
  const schema = stringSchema({ capabilityId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*@[0-9]+$" } });
  assert.deepEqual(validateAgainstSchema(schema, "exec.process@1"), []);
  assert.deepEqual(validateAgainstSchema(schema, "com.example.video.render@2"), []);
  for (const bad of ["exec.process", "exec.process@", "@1", "Exec.Process@1", ""]) {
    assert.notDeepEqual(validateAgainstSchema(schema, bad), [], `expected rejection: ${bad}`);
  }
});

test("extension maps require domain-namespace keys", () => {
  const schema = stringSchema({
    extensions: {
      type: "object",
      propertyNames: { pattern: "^[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)+$" },
      additionalProperties: true,
    },
  });
  assert.deepEqual(validateAgainstSchema(schema, { "com.example.x": 1 }), []);
  assert.deepEqual(validateAgainstSchema(schema, {}), []);
  assert.notDeepEqual(validateAgainstSchema(schema, { x: 1 }), []);
});

test("durations and byte sizes are nonnegative integers", () => {
  const duration = stringSchema({ durationMs: { type: "integer", minimum: 0 } });
  assert.deepEqual(validateAgainstSchema(duration, 0), []);
  assert.deepEqual(validateAgainstSchema(duration, 1500), []);
  assert.notDeepEqual(validateAgainstSchema(duration, -1), []);
  assert.notDeepEqual(validateAgainstSchema(duration, 1.5), []);
  const bytes = stringSchema({ byteSize: { type: "integer", minimum: 0 } });
  assert.deepEqual(validateAgainstSchema(bytes, 4096), []);
  assert.notDeepEqual(validateAgainstSchema(bytes, "4096"), []);
});
