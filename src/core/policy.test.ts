import test from "node:test";
import assert from "node:assert/strict";
import { PolicyAuthority } from "./policy.js";
import type { PortablePolicy } from "../schema/policy.js";
import type { EnvironmentRequest } from "../schema/capability.js";
import { assertValid } from "../schema/validate.js";
import { policySchema } from "../schema/policy.js";

const GIB = 1 << 30;

/** A policy that grants a narrow, concrete set of limits. */
const BASE: PortablePolicy = {
  schemaVersion: 1,
  providers: ["provider-local", "provider-remote"],
  operations: ["exec.process@1", "python.lite@1/run"],
  locations: ["local"],
  transferDestinations: ["local"],
  networkEgress: "allowlist",
  egressAllowlist: ["example.com", "*.internal.dev", "proxy.corp:8080"],
  hostFilesystemAccess: true,
  maxEnvironmentLifetimeMs: 3_600_000,
  maxResources: { memoryBytes: 4 * GIB, storageBytes: 10 * GIB },
  secrets: ["secret://ci/token"],
  serviceAudiences: ["aud://session-owner"],
};

function isPolicyDenied(value: unknown): value is { code: string; message: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { code?: unknown }).code === "PolicyDenied"
  );
}

test("every version-one dimension is checked", () => {
  const authority = PolicyAuthority.fromPolicy(BASE);

  // Provider.
  assert.equal(authority.checkProvider("provider-local"), null);
  assert.ok(isPolicyDenied(authority.checkProvider("provider-evil")));

  // Operation: whole-capability grants and single-operation grants.
  assert.equal(authority.checkOperation("exec.process@1", "start"), null);
  assert.equal(authority.checkOperation("exec.process@1", "terminate"), null);
  assert.equal(authority.checkOperation("python.lite@1", "run"), null);
  assert.ok(isPolicyDenied(authority.checkOperation("python.lite@1", "reset")));
  assert.ok(isPolicyDenied(authority.checkOperation("browser.session@1", "navigate")));

  // Execution location and transfer destination.
  assert.equal(authority.checkLocation("local"), null);
  assert.ok(isPolicyDenied(authority.checkLocation("remote")));
  assert.equal(authority.checkTransferDestination("local"), null);
  assert.ok(isPolicyDenied(authority.checkTransferDestination("remote")));

  // Egress mode.
  assert.equal(authority.checkEgress("none"), null);
  assert.equal(authority.checkEgress("allowlist"), null);
  assert.ok(isPolicyDenied(authority.checkEgress("unrestricted")));

  // Host filesystem access.
  assert.equal(authority.allowsHostFilesystemAccess(), true);
  assert.equal(authority.checkHostFilesystemRequirement(true), null);
  assert.equal(authority.checkHostFilesystemRequirement(false), null);

  // Environment lifetime.
  assert.equal(authority.checkLifetime(3_600_000), null);
  assert.ok(isPolicyDenied(authority.checkLifetime(3_600_001)));

  // Resource ceilings, one dimension at a time.
  assert.equal(
    authority.checkResources({
      memoryBytes: { min: 4 * GIB },
      storageBytes: { min: 10 * GIB },
    }),
    null,
  );
  assert.ok(
    isPolicyDenied(authority.checkResources({ memoryBytes: { min: 4 * GIB + 1 } })),
  );
  assert.ok(
    isPolicyDenied(authority.checkResources({ storageBytes: { min: 10 * GIB + 1 } })),
  );
  assert.ok(isPolicyDenied(authority.checkResources({ gpuMemoryBytes: { min: 1 } })));

  // Secret references and service audiences.
  assert.equal(authority.checkSecretReference("secret://ci/token"), null);
  assert.ok(isPolicyDenied(authority.checkSecretReference("secret://evil/key")));
  assert.equal(authority.checkServiceAudience("aud://session-owner"), null);
  assert.ok(isPolicyDenied(authority.checkServiceAudience("aud://public")));
});

test("host filesystem withheld denies requests that need it", () => {
  const authority = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    hostFilesystemAccess: false,
  });
  assert.equal(authority.allowsHostFilesystemAccess(), false);
  assert.ok(isPolicyDenied(authority.checkHostFilesystemRequirement(true)));
  assert.equal(authority.checkHostFilesystemRequirement(false), null);
});

test("egress targets follow the mode and the allowlist", () => {
  const authority = PolicyAuthority.fromPolicy(BASE);
  const allowed = [
    "example.com",
    "example.com:443",
    "internal.dev",
    "api.internal.dev",
    "deep.nest.internal.dev",
    "proxy.corp:8080",
    "Example.COM",
  ];
  for (const host of allowed) {
    assert.equal(authority.checkEgressTarget(host), null, host);
  }
  const refused = [
    "api.example.com",
    "evilinternal.dev",
    "proxy.corp",
    "proxy.corp:90",
    "proxy.evil:8080",
    "internal.dev.evil",
  ];
  for (const host of refused) {
    assert.ok(isPolicyDenied(authority.checkEgressTarget(host)), host);
  }

  // Every host is denied under `none` and allowed under `unrestricted`.
  const none = PolicyAuthority.fromPolicy({ schemaVersion: 1 });
  assert.ok(isPolicyDenied(none.checkEgressTarget("example.com")));
  const open = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    networkEgress: "unrestricted",
  });
  assert.equal(open.checkEgressTarget("anything.anywhere"), null);
});

test("omitted permissions grant nothing at the root", () => {
  const authority = PolicyAuthority.fromPolicy({ schemaVersion: 1 });
  assert.ok(isPolicyDenied(authority.checkProvider("provider-local")));
  assert.ok(isPolicyDenied(authority.checkOperation("exec.process@1", "run")));
  assert.ok(isPolicyDenied(authority.checkLocation("local")));
  assert.ok(isPolicyDenied(authority.checkTransferDestination("local")));
  assert.ok(isPolicyDenied(authority.checkEgress("allowlist")));
  assert.ok(isPolicyDenied(authority.checkEgress("unrestricted")));
  assert.ok(isPolicyDenied(authority.checkEgressTarget("example.com")));
  assert.equal(authority.allowsHostFilesystemAccess(), false);
  assert.ok(isPolicyDenied(authority.checkLifetime(1)));
  assert.ok(isPolicyDenied(authority.checkResources({ memoryBytes: { min: 1 } })));
  assert.ok(isPolicyDenied(authority.checkSecretReference("secret://any")));
  assert.ok(isPolicyDenied(authority.checkServiceAudience("aud://any")));
});

test("omitted permissions inherit configured limits inside a narrowing", () => {
  const authority = PolicyAuthority.fromPolicy(BASE);
  const inherited = authority.derive({ schemaVersion: 1 });

  // Nothing was specified, so nothing changed: inheritance, not clamping.
  assert.equal(inherited.checkProvider("provider-remote"), null);
  assert.equal(inherited.checkEgress("allowlist"), null);
  assert.equal(inherited.allowsHostFilesystemAccess(), true);
  assert.equal(inherited.checkLifetime(3_600_000), null);

  // Partial narrowing: memory tightens, storage inherits the parent cap.
  const tightened = authority.derive({
    schemaVersion: 1,
    maxResources: { memoryBytes: 1 * GIB },
  });
  assert.ok(isPolicyDenied(tightened.checkResources({ memoryBytes: { min: 2 * GIB } })));
  assert.equal(tightened.checkResources({ storageBytes: { min: 10 * GIB } }), null);

  // Present sets intersect with the parent.
  const shared = authority.derive({
    schemaVersion: 1,
    providers: ["provider-remote", "provider-other"],
  });
  assert.equal(shared.checkProvider("provider-remote"), null);
  assert.ok(isPolicyDenied(shared.checkProvider("provider-local")));
});

test("a narrowing can never widen any dimension", () => {
  const authority = PolicyAuthority.fromPolicy(BASE);
  const wider = authority.derive({
    schemaVersion: 1,
    providers: ["provider-evil"],
    operations: ["browser.session@1"],
    locations: ["remote"],
    transferDestinations: ["remote"],
    networkEgress: "unrestricted",
    hostFilesystemAccess: false,
    maxEnvironmentLifetimeMs: 100_000_000,
    maxResources: { memoryBytes: 100 * GIB },
    secrets: ["secret://evil/key"],
    serviceAudiences: ["aud://public"],
  });

  // Sets intersect to the parent's members only.
  assert.ok(isPolicyDenied(wider.checkProvider("provider-evil")));
  assert.ok(isPolicyDenied(wider.checkProvider("provider-local")));
  assert.ok(isPolicyDenied(wider.checkOperation("browser.session@1", "navigate")));
  assert.ok(isPolicyDenied(wider.checkLocation("remote")));
  assert.ok(isPolicyDenied(wider.checkTransferDestination("remote")));

  // Scalars and egress stay at or below the parent.
  assert.ok(isPolicyDenied(wider.checkEgress("unrestricted")));
  assert.equal(wider.checkEgress("allowlist"), null);
  assert.ok(isPolicyDenied(wider.checkLifetime(3_600_001)));
  assert.equal(wider.checkLifetime(3_600_000), null);
  assert.ok(isPolicyDenied(wider.checkResources({ memoryBytes: { min: 5 * GIB } })));

  // Booleans only tighten.
  const flipped = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    hostFilesystemAccess: false,
  }).derive({ schemaVersion: 1, hostFilesystemAccess: true });
  assert.equal(flipped.allowsHostFilesystemAccess(), false);
});

test("model-controlled request fields never replace authority", () => {
  const authority = PolicyAuthority.fromPolicy(BASE);

  // The request carries authority-shaped constraints and extensions. The
  // check reads none of them: the provider stays denied.
  const hostile: EnvironmentRequest = {
    name: "worker",
    providerId: "provider-evil",
    requires: { "exec.process@1": {} },
    constraints: {
      policy: {
        providers: ["provider-evil"],
        networkEgress: "unrestricted",
      },
      "auth.authority": { principal: "user://forged", policyRef: "policy://forged" },
    },
    preferences: { locality: "local-first" },
    extensions: {
      "trust.policy": { providers: ["provider-evil"] },
      "auth.principal": "user://forged",
    },
  };
  assert.ok(isPolicyDenied(authority.checkEnvironmentRequest(hostile)));

  // A locality preference outside the allowed locations is denied; it
  // never weakens the location limit (SPEC.md section 6.4).
  const remoteFirst = authority.checkEnvironmentRequest({
    name: "worker",
    requires: {},
    preferences: { locality: "remote-first" },
  });
  assert.ok(isPolicyDenied(remoteFirst));
  const localFirst = authority.checkEnvironmentRequest({
    name: "worker",
    requires: {},
    preferences: { locality: "local-first" },
  });
  assert.equal(localFirst, null);

  // Model input funneled through derive cannot widen either: the forged
  // document grants exactly what the parent already allowed.
  const forged = authority.derive({
    schemaVersion: 1,
    providers: ["provider-evil"],
    egressAllowlist: ["evil.example"],
  });
  assert.ok(isPolicyDenied(forged.checkProvider("provider-evil")));
  assert.ok(isPolicyDenied(forged.checkEgressTarget("evil.example")));
});

test("checkEnvironmentRequest combines provider, preference, and resources", () => {
  const authority = PolicyAuthority.fromPolicy(BASE);
  const accepted: EnvironmentRequest = {
    name: "worker",
    providerId: "provider-local",
    requires: { "exec.process@1": {} },
    resources: { memoryBytes: { min: 2 * GIB } },
    preferences: { locality: "local-first" },
  };
  assert.equal(authority.checkEnvironmentRequest(accepted), null);

  const tooBig: EnvironmentRequest = {
    name: "worker",
    providerId: "provider-local",
    requires: {},
    resources: { memoryBytes: { min: 5 * GIB } },
  };
  assert.ok(isPolicyDenied(authority.checkEnvironmentRequest(tooBig)));

  const unlisted: EnvironmentRequest = {
    name: "worker",
    requires: {},
  };
  // Without an explicit provider there is nothing to check yet; the
  // concrete location and provider are checked at offer time.
  assert.equal(authority.checkEnvironmentRequest(unlisted), null);
});

test("malformed policy documents fail closed with Portable errors", () => {
  const broken = {
    schemaVersion: 1,
    locations: ["mars"],
    egressAllowlist: ["not a host"],
  } as unknown as PortablePolicy;
  assert.throws(
    () => PolicyAuthority.fromPolicy(broken),
    (error: unknown) =>
      error !== null &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "InvalidRequest",
  );
  const authority = PolicyAuthority.fromPolicy({ schemaVersion: 1 });
  assert.throws(
    () => authority.derive({ schemaVersion: 2 } as unknown as PortablePolicy),
    (error: unknown) =>
      error !== null &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "InvalidRequest",
  );
});

test("effectivePolicy states resolved access and stays serializable", () => {
  const { maxEnvironmentLifetimeMs: omitted, ...withoutLifetime } = BASE;
  void omitted;
  const authority = PolicyAuthority.fromPolicy(withoutLifetime);
  const effective = authority.effectivePolicy();
  assertValid(policySchema, effective);
  assert.deepEqual(effective.providers, ["provider-local", "provider-remote"]);
  assert.deepEqual(effective.locations, ["local"]);
  assert.equal(effective.networkEgress, "allowlist");
  assert.equal(effective.hostFilesystemAccess, true);
  // A lifetime of zero grants nothing; the field stays absent.
  assert.equal("maxEnvironmentLifetimeMs" in effective, false);
  // The document is JSON-serializable.
  assert.deepEqual(JSON.parse(JSON.stringify(effective)), effective);

  const empty = PolicyAuthority.fromPolicy({ schemaVersion: 1 }).effectivePolicy();
  assert.deepEqual(empty.providers, []);
  assert.equal(empty.networkEgress, "none");
  assert.equal(empty.hostFilesystemAccess, false);
});
