import {
  DEFS,
  type Extensions,
  type Identifier,
  type Sha256Hex,
  type UtcTimestamp,
} from "./defs.js";
import type { StateDisposition } from "./handoff.js";

/** One content-addressed file inside a bundle. */
export interface BundleArtifact {
  path: string;
  digest: Sha256Hex;
  sizeBytes: number;
  mediaType: string;
}

/** Authorized location of a blob that a reference-only bundle omits. */
export interface BundleRetrievalLocation {
  digest: Sha256Hex;
  location: string;
}

/**
 * Manifest of a portable state bundle (SPEC.md section 19).
 *
 * Includes schema version, source session, workspace revision and root
 * hash, attachment generations, artifact inventory, and state dispositions.
 * `selfContained` declares whether every referenced blob is included;
 * otherwise `retrievalLocations` identifies authorized locations.
 */
export interface BundleManifest {
  schemaVersion: 1;
  kind: "portable.bundle";
  sourceSessionId: Identifier;
  workspaceRevisionId: Identifier;
  rootHash: Sha256Hex;
  attachmentGenerations: Record<string, number>;
  artifactInventory: BundleArtifact[];
  stateDispositions: StateDisposition[];
  selfContained: boolean;
  retrievalLocations?: BundleRetrievalLocation[];
  /** Opaque harness context reference. Import MUST NOT claim to interpret it. */
  harnessContextRef?: string;
  requiredExtensions?: string[];
  createdAt: UtcTimestamp;
  extensions?: Extensions;
}

export const bundleManifestSchema = {
  $id: "https://portable.dev/schema/bundle-manifest.json",
  $defs: DEFS,
  type: "object",
  required: [
    "schemaVersion",
    "kind",
    "sourceSessionId",
    "workspaceRevisionId",
    "rootHash",
    "attachmentGenerations",
    "artifactInventory",
    "stateDispositions",
    "selfContained",
    "createdAt",
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { $ref: "#/$defs/schemaVersion" },
    kind: { const: "portable.bundle" },
    sourceSessionId: { $ref: "#/$defs/identifier" },
    workspaceRevisionId: { $ref: "#/$defs/identifier" },
    rootHash: { $ref: "#/$defs/digest" },
    attachmentGenerations: {
      type: "object",
      propertyNames: { $ref: "#/$defs/attachmentName" },
      additionalProperties: { $ref: "#/$defs/generation" },
    },
    artifactInventory: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "digest", "sizeBytes", "mediaType"],
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: 4096 },
          digest: { $ref: "#/$defs/digest" },
          sizeBytes: { $ref: "#/$defs/byteSize" },
          mediaType: { type: "string", minLength: 1, maxLength: 255 },
        },
      },
    },
    stateDispositions: {
      type: "array",
      items: { $ref: "https://portable.dev/schema/state-disposition.json" },
    },
    selfContained: { type: "boolean" },
    retrievalLocations: {
      type: "array",
      items: {
        type: "object",
        required: ["digest", "location"],
        additionalProperties: false,
        properties: {
          digest: { $ref: "#/$defs/digest" },
          location: { type: "string", minLength: 1, maxLength: 2048 },
        },
      },
    },
    harnessContextRef: { type: "string", minLength: 1, maxLength: 2048 },
    requiredExtensions: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 } },
    createdAt: { $ref: "#/$defs/timestamp" },
    extensions: { $ref: "#/$defs/extensions" },
  },
} as const;
