import test from "node:test";
import assert from "node:assert/strict";
import { matchEnvironment, validateCapabilityDescriptors } from "../core/matching.js";
import type { EnvironmentOffer } from "../schema/capability.js";
import {
  BROWSER_CAPABILITY_ID,
  BROWSER_OPERATIONS,
  BROWSER_RESOURCE_TYPE,
  browserCapabilityDescriptor,
  browserResourceRef,
  browserSurvivesOwnerRelease,
  checkBrowserAttributes,
  validateBrowserCloseInput,
  validateBrowserCreateInput,
  validateBrowserInput,
  validateBrowserInspectInput,
  validateBrowserNavigateInput,
  validateBrowserScreenshotInput,
} from "./browser-capability.js";
import type { BrowserAttributeDeclarations, BrowserNavigateInput } from "./browser-capability.js";

function isPortableCode(value: unknown): value is { code: string; details?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Capture the refusal of one call instead of throwing it. */
function refuse(run: () => unknown): { code: string; details?: unknown } | null {
  try {
    run();
  } catch (error) {
    if (isPortableCode(error)) {
      return error;
    }
    throw error;
  }
  return null;
}

/** The reference declarations the default descriptor must carry. */
const REFERENCE: BrowserAttributeDeclarations = {
  sessionPersistence: "external",
  reattachment: "provider-session",
  interactionOperations: ["navigate", "screenshot"],
  networkConstraints: {
    allowedOrigins: ["https://example.org"],
    blockPrivateRanges: true,
  },
};

/** The reference declarations with one field replaced. */
function declaredWith(patch: Partial<BrowserAttributeDeclarations>): Record<string, unknown> {
  return { ...REFERENCE, ...patch };
}

/** One offer whose only capability is the reference browser descriptor. */
function browserOffer(attributes?: BrowserAttributeDeclarations): EnvironmentOffer {
  const descriptor = browserCapabilityDescriptor(attributes);
  return {
    providerId: "browser-reference",
    platform: { os: "linux", arch: "x64" },
    capabilities: [{ id: descriptor.id, attributes: descriptor.attributes }],
  };
}

test("the reference descriptor validates and parses its own attributes", () => {
  const descriptor = browserCapabilityDescriptor();
  assert.equal(descriptor.id, BROWSER_CAPABILITY_ID);
  assert.deepEqual(Object.keys(descriptor.operations), [...BROWSER_OPERATIONS]);
  assert.equal(descriptor.operations.create!.createsResource, BROWSER_RESOURCE_TYPE);
  assert.doesNotThrow(() => validateCapabilityDescriptors([descriptor]));

  const parsed = checkBrowserAttributes(descriptor.attributes);
  assert.ok(parsed !== null);
  assert.deepEqual(parsed, REFERENCE);

  // A malformed or incomplete declaration fails the parse, and
  // therefore matching, instead of narrowing silently.
  assert.equal(checkBrowserAttributes({}), null);
  assert.equal(
    checkBrowserAttributes(
      declaredWith({ sessionPersistence: "forever" as BrowserAttributeDeclarations["sessionPersistence"] }),
    ),
    null,
  );
  assert.equal(
    checkBrowserAttributes(declaredWith({ reattachment: "cookies" as BrowserAttributeDeclarations["reattachment"] })),
    null,
  );
  assert.equal(checkBrowserAttributes(declaredWith({ interactionOperations: ["not valid!"] })), null);
  assert.equal(
    checkBrowserAttributes(
      declaredWith({ networkConstraints: { allowedOrigins: ["ftp://example.org"], blockPrivateRanges: true } }),
    ),
    null,
  );
  assert.equal(
    checkBrowserAttributes(
      declaredWith({ networkConstraints: { allowedOrigins: ["https://example.org"], blockPrivateRanges: "yes" as unknown as boolean } }),
    ),
    null,
  );
});

test("matching distinguishes persistent reattachable sessions from closed ones", () => {
  const offer = browserOffer();

  const persistent = matchEnvironment(
    {
      name: "browser",
      requires: {
        [BROWSER_CAPABILITY_ID]: {
          sessionPersistence: { equals: "external" },
          reattachment: { equals: "provider-session" },
        },
      },
    },
    [offer],
  );
  assert.equal(persistent.providerId, "browser-reference");

  // A requirement for a session that dies with its attachment never
  // matches the reference offer.
  const ephemeral = refuse(() =>
    matchEnvironment(
      {
        name: "browser",
        requires: {
          [BROWSER_CAPABILITY_ID]: { sessionPersistence: { equals: "operation" } },
        },
      },
      [offer],
    ),
  );
  assert.equal(ephemeral?.code, "RequirementUnsatisfied");
});

test("every operation input validates its own shape", () => {
  assert.deepEqual(validateBrowserCreateInput({}), {});
  assert.deepEqual(validateBrowserCreateInput({
    name: "docs",
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    userAgent: "porta/1",
  }), { name: "docs", viewport: { width: 1280, height: 720 }, locale: "en-US", userAgent: "porta/1" });

  const navigate = validateBrowserNavigateInput({
    resourceId: "res-browser-1",
    url: "https://example.org/docs",
    waitUntil: "network-idle",
    timeoutMs: 5000,
  });
  assert.equal(navigate.url, "https://example.org/docs");

  // Non-HTTP schemes and malformed URLs refuse outright.
  assert.equal(
    refuse(() => validateBrowserNavigateInput({ resourceId: "res-1", url: "ftp://example.org" }))?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() => validateBrowserNavigateInput({ resourceId: "res-1", url: "not a url" }))?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() => validateBrowserNavigateInput({ resourceId: "res-1" }))?.code,
    "InvalidRequest",
  );

  validateBrowserScreenshotInput({
    resourceId: "res-1",
    format: "jpeg",
    fullPage: true,
    region: { x: 0, y: 0, width: 100, height: 50 },
  });
  assert.equal(
    refuse(() =>
      validateBrowserScreenshotInput({ resourceId: "res-1", format: "bmp" }),
    )?.code,
    "InvalidRequest",
  );
  assert.equal(
    refuse(() =>
      validateBrowserScreenshotInput({
        resourceId: "res-1",
        region: { x: -1, y: 0, width: 10, height: 10 },
      }),
    )?.code,
    "InvalidRequest",
  );

  assert.deepEqual(validateBrowserInspectInput({ resourceId: "res-1" }), { resourceId: "res-1" });
  assert.deepEqual(validateBrowserCloseInput({ resourceId: "res-1" }), { resourceId: "res-1" });
  assert.equal(
    refuse(() => validateBrowserCloseInput({ resourceId: "" }))?.code,
    "InvalidRequest",
  );

  // The dispatcher routes each operation to its own schema.
  assert.deepEqual(validateBrowserInput("create", {}), {});
  const routed = validateBrowserInput("navigate", {
    resourceId: "res-1",
    url: "https://example.org",
  }) as BrowserNavigateInput;
  assert.equal(routed.url, "https://example.org");
  assert.deepEqual(validateBrowserInput("inspect", { resourceId: "res-1" }), { resourceId: "res-1" });
});

test("the browser reference fixes lifetime and recovery from the declaration", () => {
  const shape = {
    id: "res-browser-1",
    sessionId: "sess-1",
    owner: { sessionId: "sess-1", attachmentId: "att-compute-1", generation: 3 },
  };

  // A persistent, reattachable session is external state.
  const external = browserResourceRef(shape, {
    sessionPersistence: "external",
    reattachment: "provider-session",
  });
  assert.equal(external.type, BROWSER_RESOURCE_TYPE);
  assert.equal(external.lifetime, "external");
  assert.equal(external.recovery, "reattach");
  assert.ok(browserSurvivesOwnerRelease(external));

  // A session scoped to the attachment dies with it: no reattachment
  // path, no survival across the owner's release.
  const attached = browserResourceRef(shape, {
    sessionPersistence: "attachment",
    reattachment: "none",
  });
  assert.equal(attached.lifetime, "attachment");
  assert.equal(attached.recovery, "none");
  assert.equal(browserSurvivesOwnerRelease(attached), false);

  // External persistence without reattachment still dies: the state
  // exists but nothing can adopt it.
  const orphaned = browserResourceRef(shape, {
    sessionPersistence: "external",
    reattachment: "none",
  });
  assert.equal(browserSurvivesOwnerRelease(orphaned), false);
});
