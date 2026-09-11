import test from "node:test";
import assert from "node:assert/strict";
import {
  manifestTarget,
  matchEnvironment,
  validateCapabilityDescriptors,
  validateManifest,
} from "./matching.js";
import type { CapabilityDescriptor, EnvironmentManifest, EnvironmentOffer } from "../schema/capability.js";

function isPortableCode(value: unknown): value is { code: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

const GIB = 1 << 30;

/** Descriptor of a native process capability. */
function processDescriptor(engine: string): CapabilityDescriptor {
  return {
    id: "exec.process@1",
    operations: {
      run: {
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
        outputSchema: { type: "object", properties: { exitCode: { type: "number" } } },
        stateful: false,
        effects: "external",
        retry: "unsafe",
        cancellation: "best-effort",
        streaming: true,
      },
    },
    attributes: { engine, maxProcesses: 16 },
  };
}

function liteDescriptor(interpreter: string): CapabilityDescriptor {
  return {
    id: "python.lite@1",
    operations: {
      run: {
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        stateful: false,
        effects: "none",
        retry: "safe",
        cancellation: "unsupported",
        streaming: false,
      },
    },
    attributes: { interpreter, subset: "lite" },
  };
}

function offer(
  providerId: string,
  capabilities: CapabilityDescriptor[],
  overrides: Partial<EnvironmentOffer> = {},
): EnvironmentOffer {
  return {
    providerId,
    platform: { os: "linux", arch: "x64" },
    capabilities: capabilities.map((capability) => ({
      id: capability.id,
      attributes: capability.attributes,
    })),
    resources: { memoryBytes: 4 * GIB, storageBytes: 20 * GIB },
    enforcement: { "network.egress": "allowlist", "host.filesystem": true },
    ...overrides,
  };
}

function manifestOf(
  providerId: string,
  capabilities: CapabilityDescriptor[],
  overrides: Partial<EnvironmentManifest> = {},
): EnvironmentManifest {
  return {
    environmentId: `env-${providerId}`,
    providerId,
    platform: { os: "linux", arch: "x64" },
    capabilities,
    resources: { memoryBytes: 4 * GIB, storageBytes: 20 * GIB },
    enforcement: { "network.egress": "allowlist", "host.filesystem": true },
    adapterVersion: "1.0.0",
    ...overrides,
  };
}

const LOCAL_OFFER = offer("provider-local", [processDescriptor("process-local")]);
const REMOTE_OFFER = offer("provider-remote", [processDescriptor("process-remote")]);

test("explicit provider selection returns that provider's match", () => {
  const result = matchEnvironment(
    {
      name: "worker",
      providerId: "provider-local",
      requires: { "exec.process@1": {} },
    },
    [LOCAL_OFFER, REMOTE_OFFER],
  );
  assert.equal(result.providerId, "provider-local");
  assert.equal(result.target.capabilities.length, 1);
});

test("a named provider that does not satisfy the request is unsatisfied", () => {
  assert.throws(
    () =>
      matchEnvironment(
        {
          name: "worker",
          providerId: "provider-local",
          requires: { "exec.process@1": { engine: { equals: "process-remote" } } },
        },
        [LOCAL_OFFER, REMOTE_OFFER],
      ),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
  // A provider with no configured offer is also unsatisfied, not guessed.
  assert.throws(
    () =>
      matchEnvironment(
        { name: "worker", providerId: "provider-ghost", requires: {} },
        [LOCAL_OFFER],
      ),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
});

test("without a provider, zero matches are unsatisfied and several are ambiguous", () => {
  // Both providers satisfy a bare process requirement.
  assert.throws(
    () =>
      matchEnvironment(
        { name: "worker", requires: { "exec.process@1": {} } },
        [LOCAL_OFFER, REMOTE_OFFER],
      ),
    (error: unknown) =>
      isPortableCode(error) &&
      error.code === "AmbiguousEnvironment" &&
      JSON.stringify(error).includes("provider-local"),
  );

  // A platform nobody offers leaves zero matches.
  assert.throws(
    () =>
      matchEnvironment(
        { name: "worker", requires: {}, platform: { os: "darwin" } },
        [LOCAL_OFFER, REMOTE_OFFER],
      ),
    (error: unknown) => {
      if (!isPortableCode(error) || error.code !== "RequirementUnsatisfied") {
        return false;
      }
      const failures = (error as { details?: { failures?: unknown[] } }).details?.failures;
      return Array.isArray(failures) && failures.length === 2;
    },
  );
});

test("platform fields and resource minima are mandatory", () => {
  const mixed = [
    LOCAL_OFFER,
    offer("provider-arm", [processDescriptor("process-arm")], {
      platform: { os: "linux", arch: "arm64" },
    }),
  ];
  const result = matchEnvironment(
    {
      name: "worker",
      requires: { "exec.process@1": {} },
      platform: { os: "linux", arch: "arm64" },
    },
    mixed,
  );
  assert.equal(result.providerId, "provider-arm");

  // A missing resource quantity counts as zero and refuses the request.
  assert.throws(
    () =>
      matchEnvironment(
        {
          name: "worker",
          requires: {},
          resources: { gpuMemoryBytes: { min: 1 } },
        },
        [LOCAL_OFFER],
      ),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
  // An exact minimum passes.
  const exact = matchEnvironment(
    {
      name: "worker",
      requires: {},
      resources: { memoryBytes: { min: 4 * GIB } },
    },
    [LOCAL_OFFER],
  );
  assert.equal(exact.providerId, "provider-local");
});

test("capability identities and engine semantics never fall back silently", () => {
  const lite = offer("provider-lite", [liteDescriptor("monty")]);
  // Full Python is a different contract; lite does not satisfy it.
  assert.throws(
    () => matchEnvironment({ name: "worker", requires: { "python.full@1": {} } }, [lite]),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
  // A different major version is a different contract too.
  assert.throws(
    () => matchEnvironment({ name: "worker", requires: { "python.lite@2": {} } }, [lite]),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
  // Attribute matchers hold.
  const matched = matchEnvironment(
    {
      name: "worker",
      requires: {
        "python.lite@1": {
          interpreter: { equals: "monty" },
          subset: { oneOf: ["lite", "lite-plus"] },
        },
      },
    },
    [lite],
  );
  assert.equal(matched.providerId, "provider-lite");
  // The wrong interpreter is unsatisfied, without guessing a substitute.
  assert.throws(
    () =>
      matchEnvironment(
        {
          name: "worker",
          requires: { "python.lite@1": { interpreter: { equals: "cpython" } } },
        },
        [lite],
      ),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
  // Numeric attributes compare with min and max.
  const sized = matchEnvironment(
    {
      name: "worker",
      requires: { "exec.process@1": { maxProcesses: { min: 8, max: 32 } } },
    },
    [LOCAL_OFFER],
  );
  assert.equal(sized.providerId, "provider-local");
  assert.throws(
    () =>
      matchEnvironment(
        {
          name: "worker",
          requires: { "exec.process@1": { maxProcesses: { min: 32 } } },
        },
        [LOCAL_OFFER],
      ),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
});

test("malformed requirement matchers are invalid requests", () => {
  const broken: Array<Record<string, Record<string, unknown>>> = [
    // A raw value is not a matcher.
    { "exec.process@1": { engine: "monty" } },
    // An unknown verb names input no contract defines.
    { "exec.process@1": { engine: { near: "a" } } },
    // Numeric verbs need numeric arguments.
    { "exec.process@1": { maxProcesses: { min: "eight" } } },
    { "exec.process@1": { maxProcesses: { oneOf: 8 } } },
  ];
  for (const requires of broken) {
    assert.throws(
      () => matchEnvironment({ name: "worker", requires }, [LOCAL_OFFER]),
      (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
      JSON.stringify(requires),
    );
  }
});

test("constraints match declared enforcement and unknown names are rejected", () => {
  const constrained = matchEnvironment(
    {
      name: "worker",
      requires: {},
      constraints: { "network.egress": { equals: "allowlist" } },
    },
    [LOCAL_OFFER],
  );
  assert.equal(constrained.providerId, "provider-local");

  // Unsatisfied constraint refuses the target.
  assert.throws(
    () =>
      matchEnvironment(
        {
          name: "worker",
          requires: {},
          constraints: { "network.egress": { equals: "none" } },
        },
        [LOCAL_OFFER],
      ),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );

  // A constraint no configured adapter declares is unknown, not ignored.
  assert.throws(
    () =>
      matchEnvironment(
        {
          name: "worker",
          requires: {},
          constraints: { "gpu.isolation": { equals: "required" } },
        },
        [LOCAL_OFFER],
      ),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
});

test("acquired manifests pass the same validation before activation", () => {
  const request = {
    name: "worker",
    providerId: "provider-local",
    requires: { "exec.process@1": { engine: { equals: "process-local" } } },
    resources: { memoryBytes: { min: 2 * GIB } },
  };
  validateManifest(request, manifestOf("provider-local", [processDescriptor("process-local")]));

  // The manifest must still satisfy every dimension after acquisition.
  assert.throws(
    () =>
      validateManifest(
        request,
        manifestOf("provider-local", [processDescriptor("wrong-engine")]),
      ),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
  assert.throws(
    () =>
      validateManifest(
        request,
        manifestOf("provider-local", [processDescriptor("process-local")], {
          resources: { memoryBytes: 1 * GIB },
        }),
      ),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
  // A different provider than requested never activates.
  assert.throws(
    () =>
      validateManifest(request, manifestOf("provider-remote", [processDescriptor("x")])),
    (error: unknown) => isPortableCode(error) && error.code === "RequirementUnsatisfied",
  );
});

test("manifests with invalid shapes or descriptors are invalid requests", () => {
  const request = { name: "worker", requires: {} };
  assert.throws(
    () =>
      validateManifest(request, {
        ...manifestOf("provider-local", [processDescriptor("process-local")]),
        platform: { os: "", arch: "x64" },
      }),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
  const badSchema = processDescriptor("process-local");
  badSchema.operations.run!.inputSchema = { type: "strin" } as Record<string, unknown>;
  assert.throws(
    () => validateManifest(request, manifestOf("provider-local", [badSchema])),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
  // The descriptor check is available on its own for offers and manifests.
  validateCapabilityDescriptors([processDescriptor("ok"), liteDescriptor("monty")]);
  assert.throws(
    () => validateCapabilityDescriptors([badSchema]),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
});

test("manifestTarget projects and validates the manifest", () => {
  const manifest = manifestOf("provider-local", [processDescriptor("process-local")]);
  const target = manifestTarget(manifest);
  assert.equal(target.providerId, "provider-local");
  assert.deepEqual(target.platform, { os: "linux", arch: "x64" });
  assert.equal(target.capabilities[0]?.id, "exec.process@1");
});
