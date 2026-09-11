import {
  DEFS,
  type Extensions,
  type Identifier,
  type UtcTimestamp,
} from "./defs.js";
import type { AttachmentRef } from "./session.js";

/** Resource lifetime scope (SPEC.md section 10). */
export type ResourceLifetime = "operation" | "attachment" | "external";

/** State class of a resource across handoff (SPEC.md sections 10 and 12). */
export type RecoveryMode = "none" | "reconstruct" | "reattach" | "native";

/**
 * Portable reference to a stateful object (SPEC.md section 10).
 *
 * The reference contains no reusable authorization secrets, provider tokens,
 * signed URLs, or cookies. Binding obtains credentials from the current
 * authorized context.
 */
export interface ResourceRef {
  id: Identifier;
  sessionId: Identifier;
  type: string;
  owner: AttachmentRef;
  lifetime: ResourceLifetime;
  recovery: RecoveryMode;
  expiresAt?: UtcTimestamp;
  extensions?: Extensions;
}

export const resourceRefSchema = {
  $id: "https://portable.dev/schema/resource-ref.json",
  $defs: DEFS,
  type: "object",
  required: ["id", "sessionId", "type", "owner", "lifetime", "recovery"],
  additionalProperties: false,
  properties: {
    id: { $ref: "#/$defs/identifier" },
    sessionId: { $ref: "#/$defs/identifier" },
    type: { type: "string", minLength: 1, maxLength: 128 },
    owner: { $ref: "https://portable.dev/schema/attachment-ref.json" },
    lifetime: { enum: ["operation", "attachment", "external"] },
    recovery: { enum: ["none", "reconstruct", "reattach", "native"] },
    expiresAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;

/** Validity of a resource at resolution time (SPEC.md section 10). */
export type ResourceValidity =
  | "valid"
  | "stale-generation"
  | "expired"
  | "released"
  | "unauthorized"
  | "not-found";

/**
 * Result of `Session.resolve()` (SPEC.md section 15).
 *
 * Reports actual persisted state. `providerResourceId` is the provider-side
 * identity when one exists; it grants no authority.
 */
export interface ResourceDescription {
  ref: ResourceRef;
  validity: ResourceValidity;
  providerResourceId?: string;
  detail?: string;
  extensions?: Extensions;
}

export const resourceDescriptionSchema = {
  $id: "https://portable.dev/schema/resource-description.json",
  $defs: DEFS,
  type: "object",
  required: ["ref", "validity"],
  additionalProperties: false,
  properties: {
    ref: { $ref: "https://portable.dev/schema/resource-ref.json" },
    validity: {
      enum: ["valid", "stale-generation", "expired", "released", "unauthorized", "not-found"],
    },
    providerResourceId: { type: "string", minLength: 1, maxLength: 256 },
    detail: { type: "string", maxLength: 2048 },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
