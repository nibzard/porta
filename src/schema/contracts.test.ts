import test from "node:test";
import assert from "node:assert/strict";
import { jsonRoundTrip, validateAgainstSchema } from "./validate.js";
import {
  capabilityDescriptorSchema,
  environmentManifestSchema,
  environmentOfferSchema,
  environmentRequestSchema,
  operationDescriptorSchema,
  resourceRequirementsSchema,
} from "./capability.js";
import type {
  CapabilityDescriptor,
  EnvironmentManifest,
  EnvironmentOffer,
  EnvironmentRequest,
  OperationDescriptor,
} from "./capability.js";
import {
  acquisitionStatusSchema,
  adapterInvocationSchema,
  authorizedAcquireRequestSchema,
  bindingResultSchema,
  cancellationResultSchema,
  leaseStatusSchema,
  releaseResultSchema,
} from "./adapter.js";
import type {
  AcquisitionStatus,
  AdapterInvocation,
  AuthorizedAcquireRequest,
  BindingResult,
  CancellationResult,
  LeaseStatus,
  ReleaseResult,
} from "./adapter.js";
import {
  cleanupObligationSchema,
  handoffPlanSchema,
  handoffResultSchema,
  reconstructionRecipeSchema,
  replaceRequestSchema,
  stateDispositionSchema,
} from "./handoff.js";
import type {
  CleanupObligation,
  HandoffPlan,
  HandoffResult,
  ReconstructionRecipe,
  ReplaceRequest,
  StateDisposition,
} from "./handoff.js";
import { bundleManifestSchema } from "./bundle.js";
import type { BundleManifest } from "./bundle.js";

const HEX64 = "b".repeat(64);

function issuesFor(schema: object, value: unknown): string[] {
  return validateAgainstSchema(schema, value).map(
    (issue) => `${issue.instancePath || "/"}:${issue.keyword}`,
  );
}

const attachmentRef = {
  sessionId: "ses_01",
  attachmentId: "att_01",
  generation: 3,
};

const operationDescriptor: OperationDescriptor = {
  inputSchema: { type: "object", properties: { argv: { type: "array" } } },
  outputSchema: { type: "object" },
  stateful: false,
  effects: "external",
  retry: "unsafe",
  cancellation: "best-effort",
  streaming: true,
  createsResource: "process",
};

test("operation descriptors validate semantics fields", () => {
  assert.deepEqual(issuesFor(operationDescriptorSchema, operationDescriptor), []);
  assert.ok(
    issuesFor(operationDescriptorSchema, {
      ...operationDescriptor,
      effects: "world",
    }).includes("/effects:enum"),
  );
  assert.ok(
    issuesFor(operationDescriptorSchema, {
      ...operationDescriptor,
      inputSchema: "not-a-schema",
    }).includes("/inputSchema:type"),
  );
});

const capabilityDescriptor: CapabilityDescriptor = {
  id: "exec.process@1",
  operations: { run: operationDescriptor },
  attributes: { signals: ["SIGTERM", "SIGKILL"], descendants: "confirmed" },
};

test("capability descriptors round-trip and constrain operation names", () => {
  const parsed = jsonRoundTrip(capabilityDescriptorSchema, capabilityDescriptor);
  assert.deepEqual(parsed, capabilityDescriptor);
  assert.notDeepEqual(
    issuesFor(capabilityDescriptorSchema, {
      ...capabilityDescriptor,
      operations: { "9bad-name": operationDescriptor },
    }),
    [],
  );
  assert.ok(
    issuesFor(capabilityDescriptorSchema, {
      ...capabilityDescriptor,
      id: "exec.process",
    }).includes("/id:pattern"),
  );
});

const manifest: EnvironmentManifest = {
  environmentId: "env_01",
  providerId: "local",
  platform: { os: "linux", arch: "x64" },
  capabilities: [capabilityDescriptor],
  resources: { cpuCount: 4, memoryBytes: 8_589_934_592 },
  enforcement: { networkEgress: "none", hostFilesystem: true },
  adapterVersion: "0.1.0",
};

test("environment manifests validate platform and resources", () => {
  const parsed = jsonRoundTrip(environmentManifestSchema, manifest);
  assert.deepEqual(parsed, manifest);
  const issues = issuesFor(environmentManifestSchema, {
    ...manifest,
    platform: { os: "linux" },
    resources: { cpuCount: 0 },
  });
  assert.ok(issues.includes("/platform:required"));
  assert.ok(issues.includes("/resources/cpuCount:minimum"));
  assert.ok(
    issuesFor(environmentManifestSchema, { ...manifest, adapterVersion: "" }).includes(
      "/adapterVersion:minLength",
    ),
  );
});

const environmentRequest: EnvironmentRequest = {
  name: "build",
  requires: { "exec.process@1": { descendants: "confirmed" } },
  platform: { os: "linux", arch: "x64" },
  resources: { memoryBytes: { min: 1_073_741_824 } },
  constraints: { providerTier: "standard" },
  preferences: { locality: "local-first" },
  workspace: { revisionId: "rev_01", mode: "proposal" },
};

test("environment requests validate names, minima, and modes", () => {
  const parsed = jsonRoundTrip(environmentRequestSchema, environmentRequest);
  assert.deepEqual(parsed, environmentRequest);
  assert.ok(
    issuesFor(environmentRequestSchema, { ...environmentRequest, name: "Build Box" }).includes(
      "/name:pattern",
    ),
  );
  assert.ok(
    issuesFor(environmentRequestSchema, {
      ...environmentRequest,
      resources: { memoryBytes: { min: -1 } },
    }).includes("/resources/memoryBytes/min:minimum"),
  );
  assert.ok(
    issuesFor(environmentRequestSchema, {
      ...environmentRequest,
      workspace: { revisionId: "rev_01", mode: "read-write" },
    }).includes("/workspace/mode:enum"),
  );
  assert.notDeepEqual(
    issuesFor(resourceRequirementsSchema, { memoryBytes: { min: "big" } }),
    [],
  );
});

const offer: EnvironmentOffer = {
  providerId: "local",
  adapterId: "adapter-local",
  platform: { os: "linux", arch: "x64" },
  capabilities: [{ id: "exec.process@1", attributes: { descendants: "confirmed" } }],
};

test("environment offers validate as discovery hints", () => {
  const parsed = jsonRoundTrip(environmentOfferSchema, offer);
  assert.deepEqual(parsed, offer);
  assert.notDeepEqual(issuesFor(environmentOfferSchema, { ...offer, capabilities: [] }), []);
});

const acquireRequest: AuthorizedAcquireRequest = {
  acquisitionId: "acq_01",
  request: environmentRequest,
  authority: { principal: "user://local/alice", policyRef: "policy://local/default" },
  deadline: "2026-09-11T12:05:00Z",
};

test("authorized acquire requests carry durable identity and authority", () => {
  const parsed = jsonRoundTrip(authorizedAcquireRequestSchema, acquireRequest);
  assert.deepEqual(parsed, acquireRequest);
  assert.ok(
    issuesFor(authorizedAcquireRequestSchema, {
      ...acquireRequest,
      authority: { principal: "alice" },
    }).includes("/authority:required"),
  );
});

const acquisitionStatus: AcquisitionStatus = {
  acquisitionId: "acq_01",
  state: "allocated",
  environmentId: "env_01",
  manifest,
  expiresAt: "2026-09-11T13:00:00Z",
};

test("acquisition statuses cover reconciliation states", () => {
  const parsed = jsonRoundTrip(acquisitionStatusSchema, acquisitionStatus);
  assert.deepEqual(parsed, acquisitionStatus);
  assert.ok(
    issuesFor(acquisitionStatusSchema, { ...acquisitionStatus, state: "gone" }).includes(
      "/state:enum",
    ),
  );
  const unknown: AcquisitionStatus = { acquisitionId: "acq_02", state: "unknown" };
  assert.deepEqual(issuesFor(acquisitionStatusSchema, unknown), []);
});

const adapterInvocation: AdapterInvocation = {
  operationId: "op_02",
  capability: "exec.process@1",
  operation: "run",
  input: { argv: ["make", "test"] },
  environmentId: "env_01",
  deadline: "2026-09-11T12:10:00Z",
  limits: { maxOutputBytes: 1_048_576 },
  requestKey: "rk-002",
};

test("adapter invocations validate operation identity and limits", () => {
  const parsed = jsonRoundTrip(adapterInvocationSchema, adapterInvocation);
  assert.deepEqual(parsed, adapterInvocation);
  const { limits, ...withoutLimits } = adapterInvocation;
  void limits;
  assert.ok(issuesFor(adapterInvocationSchema, withoutLimits).includes("/:required"));
});

const cancellation: CancellationResult = {
  outcome: "confirmed",
  stopped: true,
  descendantsStopped: true,
};

test("cancellation results report confirmation and descendants", () => {
  assert.deepEqual(issuesFor(cancellationResultSchema, cancellation), []);
  assert.ok(
    issuesFor(cancellationResultSchema, { ...cancellation, outcome: "maybe" }).includes(
      "/outcome:enum",
    ),
  );
});

test("lease, release, and binding results validate", () => {
  const lease: LeaseStatus = {
    status: "active",
    expiresAt: "2026-09-11T13:00:00Z",
    renewalSupported: true,
  };
  assert.deepEqual(issuesFor(leaseStatusSchema, lease), []);
  const release: ReleaseResult = { status: "released", retryable: false };
  const parsedRelease = jsonRoundTrip(releaseResultSchema, release);
  assert.deepEqual(parsedRelease, release);
  const binding: BindingResult = {
    status: "bound",
    binding: {
      id: "res_02",
      sessionId: "ses_01",
      type: "service-connection",
      owner: attachmentRef,
      lifetime: "external",
      recovery: "reattach",
    },
  };
  const parsedBinding = jsonRoundTrip(bindingResultSchema, binding);
  assert.deepEqual(parsedBinding, binding);
});

const disposition: StateDisposition = {
  subject: "dependency:node_modules",
  class: "reconstructable",
  action: "reconstruct",
  detail: "npm ci from lockfile",
};

test("state dispositions classify handoff treatment", () => {
  assert.deepEqual(issuesFor(stateDispositionSchema, disposition), []);
  assert.ok(
    issuesFor(stateDispositionSchema, { ...disposition, action: "ignore" }).includes(
      "/action:enum",
    ),
  );
});

const recipe: ReconstructionRecipe = {
  id: "rcp_01",
  inputRevisionId: "rev_01",
  requiredCapabilities: ["exec.process@1"],
  steps: [
    { capability: "exec.process@1", operation: "run", input: { argv: ["npm", "ci"] } },
  ],
  outputs: ["node_modules/"],
  failureConditions: ["npm ci exits nonzero"],
};

test("reconstruction recipes declare revision, steps, and failure conditions", () => {
  const parsed = jsonRoundTrip(reconstructionRecipeSchema, recipe);
  assert.deepEqual(parsed, recipe);
  const { failureConditions, ...without } = recipe;
  void failureConditions;
  assert.ok(issuesFor(reconstructionRecipeSchema, without).includes("/:required"));
});

const replaceRequest: ReplaceRequest = {
  source: attachmentRef,
  destination: {
    requires: { "exec.process@1": {} },
    resources: { memoryBytes: { min: 4_294_967_296 } },
  },
  workspaceRevisionId: "rev_01",
  requiredResources: ["res_browser"],
  reconstruct: [recipe],
  activeOperations: "cancel",
  requestKey: "rk-replace-1",
};

test("replace requests reject a named destination", () => {
  const parsed = jsonRoundTrip(replaceRequestSchema, replaceRequest);
  assert.deepEqual(parsed, replaceRequest);
  const issues = issuesFor(replaceRequestSchema, {
    ...replaceRequest,
    destination: { ...replaceRequest.destination, name: "renamed" },
  });
  assert.ok(issues.some((issue) => issue.includes("/destination")));
  assert.ok(
    issuesFor(replaceRequestSchema, {
      ...replaceRequest,
      activeOperations: "force",
    }).includes("/activeOperations:enum"),
  );
});

const handoffPlan: HandoffPlan = {
  sessionId: "ses_01",
  attachmentId: "att_01",
  sourceGeneration: 3,
  workspaceRevisionId: "rev_01",
  preserved: [disposition],
  reconstructed: [],
  reattached: [
    { subject: "resource:res_browser", class: "reattachable", action: "reattach", resourceId: "res_browser" },
  ],
  invalidated: [
    { subject: "process memory", class: "native", action: "invalidate" },
  ],
  blockers: [],
};

test("handoff plans report all four state treatments", () => {
  const parsed = jsonRoundTrip(handoffPlanSchema, handoffPlan);
  assert.deepEqual(parsed, handoffPlan);
});

const obligation: CleanupObligation = {
  id: "cln_01",
  kind: "unresolved-allocation",
  targetId: "acq_09",
  detail: "acquisition response lost",
  createdAt: "2026-09-11T12:02:00Z",
};

const handoffResult: HandoffResult = {
  transitionId: "ho_01",
  sessionId: "ses_01",
  attachmentId: "att_01",
  outcome: "completed",
  oldGeneration: 3,
  newGeneration: 4,
  oldEnvironmentId: "env_01",
  newEnvironmentId: "env_02",
  workspaceRevisionId: "rev_01",
  preserved: [],
  reconstructed: [disposition],
  reattached: [],
  invalidated: [],
  cleanup: [obligation],
};

test("handoff results and cleanup obligations validate", () => {
  const parsed = jsonRoundTrip(handoffResultSchema, handoffResult);
  assert.deepEqual(parsed, handoffResult);
  assert.deepEqual(issuesFor(cleanupObligationSchema, obligation), []);
  assert.ok(
    issuesFor(cleanupObligationSchema, { ...obligation, kind: "forget" }).includes(
      "/kind:enum",
    ),
  );
});

const bundle: BundleManifest = {
  schemaVersion: 1,
  kind: "portable.bundle",
  sourceSessionId: "ses_01",
  workspaceRevisionId: "rev_02",
  rootHash: HEX64,
  attachmentGenerations: { build: 4 },
  artifactInventory: [
    { path: "reports/test-run.json", digest: HEX64, sizeBytes: 512, mediaType: "application/json" },
  ],
  stateDispositions: [disposition],
  selfContained: true,
  createdAt: "2026-09-11T12:03:00Z",
};

test("bundle manifests validate inventory and provenance", () => {
  const parsed = jsonRoundTrip(bundleManifestSchema, bundle);
  assert.deepEqual(parsed, bundle);
  const issues = issuesFor(bundleManifestSchema, {
    ...bundle,
    attachmentGenerations: { "Not A Name": 1 },
  });
  assert.notDeepEqual(issues, []);
  const referenceOnly: BundleManifest = {
    ...bundle,
    selfContained: false,
    retrievalLocations: [{ digest: HEX64, location: "https://objects.example/aa" }],
  };
  assert.deepEqual(issuesFor(bundleManifestSchema, referenceOnly), []);
});
