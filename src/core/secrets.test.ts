import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  AuthorizedSecretResolver,
  checkRawTransfer,
  checkRetrievalLocation,
} from "./secrets.js";
import { PolicyAuthority } from "./policy.js";
import type { PortablePolicy } from "../schema/policy.js";
import { ControlStore } from "../store/control-store.js";
import { SessionEventStream } from "../store/event-stream.js";

const REFERENCE = "secret://ci/token";
const VALUE = "ghp_secretvalue0123456789abcdefghijklmnopqrstuvwxyz";

function isPortableCode(value: unknown): value is { code: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** A resolver over a policy the test can swap at any time. */
function makeResolver(policy: PortablePolicy): {
  holder: { policy: PortablePolicy };
  resolver: AuthorizedSecretResolver;
} {
  const holder = { policy };
  const resolver = new AuthorizedSecretResolver({
    authority: () => PolicyAuthority.fromPolicy(holder.policy),
    lookup: (reference) => (reference === REFERENCE ? VALUE : null),
  });
  return { holder, resolver };
}

test("resolve serves authorized references through a scoped handle", () => {
  const { resolver } = makeResolver({ schemaVersion: 1, secrets: [REFERENCE] });
  const secret = resolver.resolve(REFERENCE);
  assert.equal(secret.reference, REFERENCE);
  assert.equal(
    secret.use((value) => value.length),
    VALUE.length,
  );
  assert.deepEqual(resolver.resolvedReferences(), [REFERENCE]);
});

test("resolution checks the current authority on every call", () => {
  const { holder, resolver } = makeResolver({ schemaVersion: 1, secrets: [REFERENCE] });
  assert.equal(resolver.resolve(REFERENCE).use((value) => value), VALUE);

  // The policy update commits; the same reference is revoked now.
  holder.policy = { schemaVersion: 1 };
  assert.throws(
    () => resolver.resolve(REFERENCE),
    (error: unknown) => isPortableCode(error) && error.code === "PolicyDenied",
  );

  // A narrowed policy keeps the reference only while it lists it.
  holder.policy = { schemaVersion: 1, secrets: [REFERENCE, "secret://other"] };
  const narrowed = PolicyAuthority.fromPolicy(holder.policy).derive({
    schemaVersion: 1,
    secrets: ["secret://other"],
  });
  assert.ok(narrowed.checkSecretReference(REFERENCE) !== null);
});

test("references the lookup cannot serve fail closed", () => {
  const missing = new AuthorizedSecretResolver({
    authority: () => PolicyAuthority.fromPolicy({ schemaVersion: 1, secrets: ["secret://gone"] }),
    lookup: () => null,
  });
  assert.throws(
    () => missing.resolve("secret://gone"),
    (error: unknown) => isPortableCode(error) && error.code === "InvalidRequest",
  );
  assert.deepEqual(missing.resolvedReferences(), []);
});

test("the resolver never serializes its released values", () => {
  const { resolver } = makeResolver({ schemaVersion: 1, secrets: [REFERENCE] });
  resolver.resolve(REFERENCE);
  const serialized = JSON.stringify(resolver);
  assert.equal(serialized.includes(VALUE), false);
  assert.deepEqual(JSON.parse(serialized), { resolvedReferences: [REFERENCE] });

  // Detection still finds a released value inside an arbitrary record.
  assert.equal(resolver.containsReleasedValue({ nested: { leak: `echo ${VALUE}` } }), true);
  assert.equal(resolver.containsReleasedValue({ safe: "unrelated text" }), false);
});

test("resolved secrets expose no value through serialization or enumeration", () => {
  const { resolver } = makeResolver({ schemaVersion: 1, secrets: [REFERENCE] });
  const secret = resolver.resolve(REFERENCE);

  // Serialization returns the reference only.
  assert.deepEqual(JSON.parse(JSON.stringify(secret)), { reference: REFERENCE });

  // Nested serialization exposes only the reference too.
  const nested = JSON.stringify({ wrapped: secret, list: [secret] });
  assert.equal(nested.includes(VALUE), false);
  assert.deepEqual(JSON.parse(nested), {
    wrapped: { reference: REFERENCE },
    list: [{ reference: REFERENCE }],
  });

  // Spread, enumeration, and ordinary inspection carry no value.
  assert.deepEqual({ ...secret }, { reference: REFERENCE });
  assert.deepEqual(Object.keys(secret), ["reference"]);
  assert.deepEqual(Object.values(secret), [REFERENCE]);
  assert.equal(inspect(secret).includes(VALUE), false);

  // The scoped callback still receives the original value.
  assert.equal(secret.use((value) => value), VALUE);
});

test("the resolver exposes no released value through enumeration or inspection", () => {
  const { resolver } = makeResolver({ schemaVersion: 1, secrets: [REFERENCE] });
  resolver.resolve(REFERENCE);

  assert.deepEqual({ ...resolver }, {});
  assert.deepEqual(Object.keys(resolver), []);
  assert.deepEqual(Object.getOwnPropertyNames(resolver), []);
  assert.equal(inspect(resolver).includes(VALUE), false);
});

test("scrub removes released values, credential keys, and shapes", () => {
  const { resolver } = makeResolver({ schemaVersion: 1, secrets: [REFERENCE] });
  resolver.resolve(REFERENCE);
  const scrubbed = resolver.scrub({
    command: `auth login ${VALUE}`,
    apiToken: VALUE,
    header: "Bearer abcdefghijklmnopqrstuvwxyz",
    references: [REFERENCE],
    nested: { env: { GITHUB_TOKEN: VALUE } },
  }) as Record<string, unknown>;
  const text = JSON.stringify(scrubbed);
  assert.equal(text.includes(VALUE), false);
  assert.equal(text.includes(REFERENCE), true);
  assert.equal((scrubbed.command as string).includes("[redacted]"), true);
  // Credential-named keys drop entirely.
  assert.equal("apiToken" in scrubbed, false);
  assert.deepEqual(scrubbed.references, [REFERENCE]);
});

test("journal events persist redacted data through the stream hook", () => {
  const { resolver } = makeResolver({ schemaVersion: 1, secrets: [REFERENCE] });
  resolver.resolve(REFERENCE);
  const store = ControlStore.inMemory();
  store.createSession({
    id: "sess-secrets",
    schemaVersion: 1,
    status: "open",
    workspaceId: "ws-secrets",
    eventSequence: 0,
    policyRef: "policy://test",
    createdAt: "2026-09-11T00:00:00Z",
  });
  const stream = new SessionEventStream(store, "sess-secrets", (data) =>
    resolver.scrub(data) as Record<string, unknown>,
  );

  const appended = stream.append("provider.telemetry", "env-1", {
    environmentId: "env-1",
    detail: `startup used ${VALUE}`,
  });
  assert.equal(JSON.stringify(appended).includes(VALUE), false);

  const committed = stream.commitWith(
    "provider.telemetry",
    "env-1",
    { environmentId: "env-1", detail: VALUE },
    () => 7,
  );
  assert.equal(committed.result, 7);
  assert.equal(JSON.stringify(committed.event).includes(VALUE), false);

  // The durable record stays clean after restart-style re-reads.
  const batch = stream.read(0);
  assert.equal(batch.events.length, 2);
  for (const event of batch.events) {
    assert.equal(JSON.stringify(event).includes(VALUE), false);
    assert.equal(JSON.stringify(event).includes("[redacted]"), true);
  }
});

test("raw transfers follow the configured export policy", () => {
  const authority = PolicyAuthority.fromPolicy({
    schemaVersion: 1,
    transferDestinations: ["local"],
  });
  assert.equal(checkRawTransfer(authority, "local"), null);
  const denied = checkRawTransfer(authority, "remote");
  assert.ok(denied !== null);
  assert.ok(isPortableCode(denied) && denied.code === "PolicyDenied");
});

test("retrieval locations reject credential-shaped material", () => {
  assert.equal(checkRetrievalLocation("https://store.local/artifacts/abc"), null);
  const refused = [
    "https://cdn.example/file?token=abc123",
    "https://cdn.example/file?X-Amz-Signature=deadbeef",
    "https://cdn.example/file?api_key=abc123",
    "Bearer abcdefghijklmnopqrstuvwxyz",
  ];
  for (const location of refused) {
    const denial = checkRetrievalLocation(location);
    assert.ok(denial !== null, location);
    assert.ok(isPortableCode(denial) && denial.code === "InvalidRequest", location);
    // The refusal reports the location without echoing the credential.
    assert.equal(JSON.stringify(denial).includes("abc123"), false, location);
    assert.equal(JSON.stringify(denial).includes("deadbeef"), false, location);
  }
});
