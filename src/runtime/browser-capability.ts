import { invalidRequestError, invalidRequestFromValidation } from "../core/errors.js";
import { DEFS } from "../schema/defs.js";
import type { CapabilityDescriptor } from "../schema/capability.js";
import type { ResourceRef } from "../schema/resource.js";
import { ValidationError, assertValid } from "../schema/validate.js";

/**
 * The `browser.session@1` capability contract (SPEC.md section 14.4).
 *
 * Five operations — `create`, `navigate`, `screenshot`, `inspect`, and
 * `close` — carry validated requests and results. This module is the
 * contract, not an adapter: the independent browser adapter (SPEC.md
 * section 14.4) implements it behind an environment lease.
 *
 * A browser session is independent state. Its lifetime does not follow
 * the compute attachment that created it: closing compute must not
 * close a browser another attachment owns, and provider expiration is
 * reported through `inspect`, never inferred. Cookies and
 * authenticated state stay provider-owned; version one never exports
 * them into the workspace.
 */

/** Identifier of the capability this module contracts. */
export const BROWSER_CAPABILITY_ID = "browser.session@1";

/** Operations version one requires (SPEC.md section 14.4). */
export const BROWSER_OPERATIONS = [
  "create",
  "navigate",
  "screenshot",
  "inspect",
  "close",
] as const;

/** One operation name of `browser.session@1`. */
export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];

/** Resource type of one browser session. */
export const BROWSER_RESOURCE_TYPE = "browser.session";

/** Viewport size a created session starts with. */
export interface BrowserViewport {
  width: number;
  height: number;
}

/** Input of the `create` operation. */
export interface BrowserCreateInput {
  /** Caller-chosen label; provenance only, no authority. */
  name?: string;
  viewport?: BrowserViewport;
  /** Locale tag the provider should honor, when it can. */
  locale?: string;
  /** User agent the provider should report, when it can. */
  userAgent?: string;
}

/** How far a navigation waits before it returns. */
export type BrowserWaitUntil = "load" | "dom-content-loaded" | "network-idle";

/** Input of the `navigate` operation. */
export interface BrowserNavigateInput {
  /** The browser session resource to drive. */
  resourceId: string;
  /** Absolute HTTP or HTTPS URL. */
  url: string;
  waitUntil?: BrowserWaitUntil;
  /** Wall-clock bound on the navigation, in milliseconds. */
  timeoutMs?: number;
}

/** One rectangular region of a page, in CSS pixels. */
export interface BrowserRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Output encodings a screenshot may name. */
export type BrowserImageFormat = "png" | "jpeg";

/** Input of the `screenshot` operation. */
export interface BrowserScreenshotInput {
  resourceId: string;
  format?: BrowserImageFormat;
  /** `true` captures the full scrollable page, not the viewport. */
  fullPage?: boolean;
  /** Capture region; absent means the whole viewport or page. */
  region?: BrowserRegion;
}

/** Input of the `inspect` operation. */
export interface BrowserInspectInput {
  resourceId: string;
}

/** Input of the `close` operation. */
export interface BrowserCloseInput {
  resourceId: string;
}

/** Result of the `create` operation. */
export interface BrowserCreateResult {
  /** The browser session resource this create established. */
  resource: ResourceRef;
  /** Provider-side session identity; provenance only, no authority. */
  providerSessionId?: string;
  createdAt: string;
}

/** Result of the `navigate` operation. */
export interface BrowserNavigateResult {
  resourceId: string;
  /** The URL the navigation was asked for. */
  url: string;
  /** The URL the session ended on, after provider redirects. */
  finalUrl: string;
  /** HTTP status the main document returned, when the provider knows it. */
  status?: number;
  waitUntil: BrowserWaitUntil;
  navigatedAt: string;
}

/** One captured screenshot: inline bytes or an artifact reference. */
export interface BrowserImageCapture {
  /** Inline capture, base64; present for small images. */
  dataBase64?: string;
  /** Artifact-store digest; present when the capture went to storage. */
  digest?: string;
  /** Captured bytes held by this capture. */
  byteLength: number;
  /** `true` when the provider dropped part of the image. */
  truncated: boolean;
}

/** Result of the `screenshot` operation. */
export interface BrowserScreenshotResult {
  resourceId: string;
  format: BrowserImageFormat;
  image: BrowserImageCapture;
  capturedAt: string;
}

/** Observation states of a browser session. */
export type BrowserState = "active" | "expired" | "closed" | "unknown";

/** Result of the `inspect` operation. */
export interface BrowserInspectResult {
  resourceId: string;
  state: BrowserState;
  /** Why the provider says the session ended, when it expired. */
  expirationReason?: string;
  url?: string;
  title?: string;
  /** Session expiry the provider reports, when it reports one. */
  expiresAt?: string;
  inspectedAt: string;
}

/** Result of the `close` operation. */
export interface BrowserCloseResult {
  resourceId: string;
  /** `true` only when the provider confirmed the close. */
  confirmed: boolean;
  state: BrowserState;
}

/**
 * Declared attributes of a browser provider (SPEC.md section 14.4).
 *
 * The descriptor MUST declare session persistence, reattachment
 * support, supported interaction operations, and network constraints.
 * An incomplete declaration fails matching rather than narrowing.
 */
export interface BrowserAttributeDeclarations {
  /**
   * How far the session outlives an invocation. `external` sessions
   * survive their owning attachment's release.
   */
  sessionPersistence: "operation" | "attachment" | "external";
  /**
   * Whether a new compute attachment can adopt the provider session.
   * `none` means the session dies with its attachment.
   */
  reattachment: "none" | "provider-session";
  /** Interaction operations the provider supports beyond the five. */
  interactionOperations: string[];
  /** Network policy the provider enforces for every session. */
  networkConstraints: {
    /**
     * Origins pages may contact: an explicit list restricts to those
     * origins, `["*"]` restricts none, and an empty list admits no
     * origin at all.
     */
    allowedOrigins: string[];
    /** Whether loopback and private address ranges are blocked. */
    blockPrivateRanges: boolean;
  };
}

/** Attribute keys every `browser.session@1` provider must declare. */
export const BROWSER_ATTRIBUTE_KEYS = [
  "sessionPersistence",
  "reattachment",
  "interactionOperations",
  "networkConstraints",
] as const;

/** One allowed-origins entry: an origin, or the wildcard `*`. */
const ORIGIN_PATTERN = /^(?:\*|https?:\/\/[^\s/"']+)$/;

/**
 * Read one provider's declared browser attributes.
 *
 * Returns the parsed declarations, or null when an attribute is
 * missing or malformed: an incomplete declaration fails matching
 * rather than narrowing silently.
 */
export function checkBrowserAttributes(
  attributes: Record<string, unknown>,
): BrowserAttributeDeclarations | null {
  const { sessionPersistence, reattachment, interactionOperations, networkConstraints } =
    attributes as Partial<BrowserAttributeDeclarations>;
  if (
    sessionPersistence !== "operation" &&
    sessionPersistence !== "attachment" &&
    sessionPersistence !== "external"
  ) {
    return null;
  }
  if (reattachment !== "none" && reattachment !== "provider-session") {
    return null;
  }
  if (
    !Array.isArray(interactionOperations) ||
    !interactionOperations.every(
      (operation) => typeof operation === "string" && /^[a-z][a-z.]*[a-z]$/.test(operation),
    )
  ) {
    return null;
  }
  const constraints = networkConstraints as BrowserAttributeDeclarations["networkConstraints"] | undefined;
  if (constraints === null || typeof constraints !== "object") {
    return null;
  }
  if (
    !Array.isArray(constraints.allowedOrigins) ||
    !constraints.allowedOrigins.every(
      (origin) => typeof origin === "string" && ORIGIN_PATTERN.test(origin),
    )
  ) {
    return null;
  }
  if (typeof constraints.blockPrivateRanges !== "boolean") {
    return null;
  }
  return {
    sessionPersistence,
    reattachment,
    interactionOperations,
    networkConstraints: {
      allowedOrigins: constraints.allowedOrigins,
      blockPrivateRanges: constraints.blockPrivateRanges,
    },
  };
}

// -- Schemas ------------------------------------------------------------------

const resourceIdProperty = { $ref: "#/$defs/identifier" };
const urlProperty = { type: "string", minLength: 8, maxLength: 2048, pattern: "^https?://" };
const viewportSchema = {
  type: "object",
  required: ["width", "height"],
  additionalProperties: false,
  properties: {
    width: { type: "integer", minimum: 1, maximum: 16384 },
    height: { type: "integer", minimum: 1, maximum: 16384 },
  },
};
const regionSchema = {
  type: "object",
  required: ["x", "y", "width", "height"],
  additionalProperties: false,
  properties: {
    x: { type: "integer", minimum: 0, maximum: 16384 },
    y: { type: "integer", minimum: 0, maximum: 16384 },
    width: { type: "integer", minimum: 1, maximum: 16384 },
    height: { type: "integer", minimum: 1, maximum: 16384 },
  },
};
const timeoutProperty = { type: "integer", minimum: 1, maximum: 2147483647 };

/** Schema of the `create` input. */
export const browserCreateInputSchema = {
  $id: "https://portable.dev/schema/browser/create-input.json",
  $defs: DEFS,
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    viewport: viewportSchema,
    locale: { type: "string", minLength: 2, maxLength: 35 },
    userAgent: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;

/** Schema of the `navigate` input. */
export const browserNavigateInputSchema = {
  $id: "https://portable.dev/schema/browser/navigate-input.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId", "url"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    url: urlProperty,
    waitUntil: { enum: ["load", "dom-content-loaded", "network-idle"] },
    timeoutMs: timeoutProperty,
  },
} as const;

/** Schema of the `screenshot` input. */
export const browserScreenshotInputSchema = {
  $id: "https://portable.dev/schema/browser/screenshot-input.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    format: { enum: ["png", "jpeg"] },
    fullPage: { type: "boolean" },
    region: regionSchema,
  },
} as const;

/** Schema of the `inspect` input. */
export const browserInspectInputSchema = {
  $id: "https://portable.dev/schema/browser/inspect-input.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId"],
  additionalProperties: false,
  properties: { resourceId: resourceIdProperty },
} as const;

/** Schema of the `close` input. */
export const browserCloseInputSchema = {
  $id: "https://portable.dev/schema/browser/close-input.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId"],
  additionalProperties: false,
  properties: { resourceId: resourceIdProperty },
} as const;

const browserResourceSchema = {
  type: "object",
  required: ["id", "sessionId", "type", "owner", "lifetime", "recovery"],
  properties: {
    id: { $ref: "#/$defs/identifier" },
    sessionId: { $ref: "#/$defs/identifier" },
    type: { const: BROWSER_RESOURCE_TYPE },
    owner: {
      type: "object",
      required: ["sessionId", "attachmentId", "generation"],
      properties: {
        sessionId: { $ref: "#/$defs/identifier" },
        attachmentId: { $ref: "#/$defs/identifier" },
        generation: { $ref: "#/$defs/generation" },
      },
    },
    lifetime: { enum: ["operation", "attachment", "external"] },
    recovery: { enum: ["none", "reconstruct", "reattach", "native"] },
    expiresAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
};
const imageCaptureSchema = {
  type: "object",
  required: ["byteLength", "truncated"],
  additionalProperties: false,
  properties: {
    dataBase64: { type: "string", maxLength: 8388608 },
    digest: { $ref: "#/$defs/digest" },
    byteLength: { $ref: "#/$defs/byteSize" },
    truncated: { type: "boolean" },
  },
};

/** Schema of the `create` result. */
export const browserCreateResultSchema = {
  $id: "https://portable.dev/schema/browser/create-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resource", "createdAt"],
  additionalProperties: false,
  properties: {
    resource: browserResourceSchema,
    providerSessionId: { type: "string", minLength: 1, maxLength: 256 },
    createdAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Schema of the `navigate` result. */
export const browserNavigateResultSchema = {
  $id: "https://portable.dev/schema/browser/navigate-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId", "url", "finalUrl", "waitUntil", "navigatedAt"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    url: urlProperty,
    finalUrl: urlProperty,
    status: { type: "integer", minimum: 100, maximum: 599 },
    waitUntil: { enum: ["load", "dom-content-loaded", "network-idle"] },
    navigatedAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Schema of the `screenshot` result. */
export const browserScreenshotResultSchema = {
  $id: "https://portable.dev/schema/browser/screenshot-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId", "format", "image", "capturedAt"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    format: { enum: ["png", "jpeg"] },
    image: imageCaptureSchema,
    capturedAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Schema of the `inspect` result. */
export const browserInspectResultSchema = {
  $id: "https://portable.dev/schema/browser/inspect-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId", "state", "inspectedAt"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    state: { enum: ["active", "expired", "closed", "unknown"] },
    expirationReason: { type: "string", minLength: 1, maxLength: 256 },
    url: urlProperty,
    title: { type: "string", maxLength: 2048 },
    expiresAt: { $ref: "#/$defs/timestamp" },
    inspectedAt: { $ref: "#/$defs/timestamp" },
  },
} as const;

/** Schema of the `close` result. */
export const browserCloseResultSchema = {
  $id: "https://portable.dev/schema/browser/close-result.json",
  $defs: DEFS,
  type: "object",
  required: ["resourceId", "confirmed", "state"],
  additionalProperties: false,
  properties: {
    resourceId: resourceIdProperty,
    confirmed: { type: "boolean" },
    state: { enum: ["active", "expired", "closed", "unknown"] },
  },
} as const;

// -- Validation ----------------------------------------------------------------

/** Validate one `create` input. */
export function validateBrowserCreateInput(input: unknown): BrowserCreateInput {
  return checked(browserCreateInputSchema, input) as BrowserCreateInput;
}

/** Validate one `navigate` input. */
export function validateBrowserNavigateInput(input: unknown): BrowserNavigateInput {
  return checked(browserNavigateInputSchema, input) as BrowserNavigateInput;
}

/** Validate one `screenshot` input. */
export function validateBrowserScreenshotInput(input: unknown): BrowserScreenshotInput {
  return checked(browserScreenshotInputSchema, input) as BrowserScreenshotInput;
}

/** Validate one `inspect` input. */
export function validateBrowserInspectInput(input: unknown): BrowserInspectInput {
  return checked(browserInspectInputSchema, input) as BrowserInspectInput;
}

/** Validate one `close` input. */
export function validateBrowserCloseInput(input: unknown): BrowserCloseInput {
  return checked(browserCloseInputSchema, input) as BrowserCloseInput;
}

/** Any validated `browser.session@1` input. */
export type BrowserInput =
  | BrowserCreateInput
  | BrowserNavigateInput
  | BrowserScreenshotInput
  | BrowserInspectInput
  | BrowserCloseInput;

/** Validate the input of one named operation. */
export function validateBrowserInput(operation: BrowserOperation, input: unknown): BrowserInput {
  switch (operation) {
    case "create":
      return validateBrowserCreateInput(input);
    case "navigate":
      return validateBrowserNavigateInput(input);
    case "screenshot":
      return validateBrowserScreenshotInput(input);
    case "inspect":
      return validateBrowserInspectInput(input);
    case "close":
      return validateBrowserCloseInput(input);
  }
}

function checked(schema: object, input: unknown): unknown {
  try {
    assertValid(schema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRequestFromValidation(error);
    }
    throw error;
  }
  return input;
}

// -- Field semantics -----------------------------------------------------------

/** Fields that fix one browser resource reference. */
export interface BrowserResourceShape {
  id: string;
  sessionId: string;
  owner: { sessionId: string; attachmentId: string; generation: number };
  /** Session expiry the provider reports, when it reports one. */
  expiresAt?: string;
}

/**
 * Build the resource reference of one browser session.
 *
 * The declared persistence fixes the lifetime and the reattachment
 * support fixes the recovery: a provider-session that survives its
 * attachment is external and reattachable; anything else dies with
 * its owner.
 */
export function browserResourceRef(
  shape: BrowserResourceShape,
  declared: Pick<BrowserAttributeDeclarations, "sessionPersistence" | "reattachment">,
): ResourceRef {
  const external = declared.sessionPersistence === "external";
  const reattachable = declared.reattachment === "provider-session";
  return {
    id: shape.id,
    sessionId: shape.sessionId,
    type: BROWSER_RESOURCE_TYPE,
    owner: shape.owner,
    lifetime: external ? "external" : declared.sessionPersistence,
    recovery: reattachable ? "reattach" : "none",
    ...(shape.expiresAt !== undefined ? { expiresAt: shape.expiresAt } : {}),
  };
}

/**
 * The validity rule of browser bindings (SPEC.md sections 10, 14.4).
 *
 * A browser session is independent state: it survives the release or
 * replacement of its owning attachment exactly when its persistence
 * is external and its state can be reattached. Provider expiration
 * stays a separate, provider-reported fact — `inspect` reports it;
 * nothing infers it from compute lifecycles.
 */
export function browserSurvivesOwnerRelease(
  browser: Pick<ResourceRef, "lifetime" | "recovery">,
): boolean {
  return browser.lifetime === "external" && browser.recovery === "reattach";
}

// -- Reference descriptor --------------------------------------------------------

/**
 * The reference descriptor of `browser.session@1`.
 *
 * The operation table states the shape of every input and output; the
 * attributes declare session persistence, reattachment support, the
 * supported interactions, and the network constraints. A concrete
 * adapter overrides the attributes with its own truth; an incomplete
 * declaration fails `checkBrowserAttributes` and therefore matching.
 */
export function browserCapabilityDescriptor(
  attributes: BrowserAttributeDeclarations = {
    sessionPersistence: "external",
    reattachment: "provider-session",
    interactionOperations: ["navigate", "screenshot"],
    networkConstraints: {
      allowedOrigins: ["https://example.org"],
      blockPrivateRanges: true,
    },
  },
): CapabilityDescriptor {
  return {
    id: BROWSER_CAPABILITY_ID,
    operations: {
      create: {
        inputSchema: browserCreateInputSchema,
        outputSchema: browserCreateResultSchema,
        stateful: true,
        effects: "external",
        retry: "unsafe",
        cancellation: "unsupported",
        streaming: false,
        createsResource: BROWSER_RESOURCE_TYPE,
      },
      navigate: {
        inputSchema: browserNavigateInputSchema,
        outputSchema: browserNavigateResultSchema,
        stateful: true,
        effects: "external",
        retry: "unsafe",
        cancellation: "best-effort",
        streaming: false,
      },
      screenshot: {
        inputSchema: browserScreenshotInputSchema,
        outputSchema: browserScreenshotResultSchema,
        stateful: false,
        effects: "none",
        retry: "safe",
        cancellation: "unsupported",
        streaming: false,
      },
      inspect: {
        inputSchema: browserInspectInputSchema,
        outputSchema: browserInspectResultSchema,
        stateful: false,
        effects: "none",
        retry: "safe",
        cancellation: "unsupported",
        streaming: false,
      },
      close: {
        inputSchema: browserCloseInputSchema,
        outputSchema: browserCloseResultSchema,
        stateful: true,
        effects: "external",
        retry: "deduplicated",
        cancellation: "unsupported",
        streaming: false,
      },
    },
    attributes: {
      sessionPersistence: attributes.sessionPersistence,
      reattachment: attributes.reattachment,
      interactionOperations: attributes.interactionOperations,
      networkConstraints: attributes.networkConstraints,
    },
  };
}
