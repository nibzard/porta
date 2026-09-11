import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityIdSatisfies,
  checkUnknownConstraints,
  checkUnknownRequirements,
  isDomainNamespaced,
  missingRequiredExtensions,
  parseCapabilityId,
  recognizedExtensions,
  requireExtensions,
} from "./compatibility.js";

test("capability ids parse into name and major", () => {
  assert.deepEqual(parseCapabilityId("exec.process@1"), { name: "exec.process", major: 1 });
  assert.deepEqual(parseCapabilityId("com.example.video.render@12"), {
    name: "com.example.video.render",
    major: 12,
  });
  for (const bad of ["exec.process", "@1", "exec.process@", "a@0", "a@x", "a@-1", "", "A@1"]) {
    assert.equal(parseCapabilityId(bad), null, `expected rejection: ${bad}`);
  }
});

test("requirements need an exact name and major match", () => {
  assert.equal(capabilityIdSatisfies("exec.process@1", "exec.process@1"), true);
  // A higher major version may break semantics; it does not satisfy.
  assert.equal(capabilityIdSatisfies("exec.process@1", "exec.process@2"), false);
  assert.equal(capabilityIdSatisfies("exec.process@2", "exec.process@1"), false);
  assert.equal(capabilityIdSatisfies("exec.process@1", "exec.python@1"), false);
  assert.equal(capabilityIdSatisfies("broken", "exec.process@1"), false);
});

test("third-party names use domain namespaces", () => {
  assert.equal(isDomainNamespaced("com.example.video.render@1"), true);
  assert.equal(isDomainNamespaced("exec.process@1"), false);
});

test("required extensions the consumer lacks are rejected", () => {
  const error = requireExtensions(
    ["com.example.gpu", "com.example.other"],
    ["com.example.gpu"],
  );
  assert.ok(error);
  assert.equal(error.code, "InvalidRequest");
  assert.equal(error.retry, "never");
  assert.deepEqual((error.details as { missingExtensions: string[] }).missingExtensions, [
    "com.example.other",
  ]);
  assert.equal(requireExtensions(["com.example.gpu"], ["com.example.gpu", "x"]), null);
  assert.deepEqual(missingRequiredExtensions(["a", "b"], ["b"]), ["a"]);
});

test("unknown capability requirements are rejected, not ignored", () => {
  const error = checkUnknownRequirements(
    { "exec.process@1": {}, "com.example.mystery@1": {} },
    ["exec.process@1", "exec.python@1"],
  );
  assert.ok(error);
  assert.equal(error.code, "RequirementUnsatisfied");
  assert.deepEqual((error.details as { unknownRequirements: string[] }).unknownRequirements, [
    "com.example.mystery@1",
  ]);
  assert.equal(
    checkUnknownRequirements({ "exec.process@1": {} }, ["exec.process@1"]),
    null,
  );
});

test("unknown policy constraints are rejected", () => {
  const error = checkUnknownConstraints({ tier: "standard", mystery: true }, ["tier"]);
  assert.ok(error);
  assert.equal(error.code, "InvalidRequest");
  assert.deepEqual((error.details as { unknownConstraints: string[] }).unknownConstraints, [
    "mystery",
  ]);
  assert.equal(checkUnknownConstraints({ tier: "standard" }, ["tier"]), null);
});

test("unknown descriptive extensions are tolerated and filtered", () => {
  const extensions = {
    "com.example.display": { theme: "dark" },
    "com.example.other": { value: 1 },
    "com.third.thing": { value: 2 },
  };
  const kept = recognizedExtensions(extensions, ["com.example.display"]);
  assert.deepEqual(kept, { "com.example.display": { theme: "dark" } });
  assert.deepEqual(recognizedExtensions(undefined, ["com.example.display"]), {});
});
