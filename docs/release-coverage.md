# Release coverage

This document maps every normative statement of `SPEC.md` (version
`0.1.0-draft.1`, 23 sections, 137 statements that use MUST or MUST NOT)
to its implementation and its validation evidence. It is the coverage
review the first release owes its readers: nothing here claims support
the repository cannot show.

## How to read this map

Each row names the requirement in one line, with the `SPEC.md` line
number of the statement. Implementation names source files under
`src/`. Evidence names one of three kinds:

- `test:<file>` — a suite under `src/` that `npm test` runs. For
  example, `test:runtime/lifecycle` is `src/runtime/lifecycle.test.ts`.
- `conf:<case>` — a conformance case the `conformance` command runs
  (SPEC.md section 21).
- `demo` — an assertion of the acceptance demonstration
  (`src/acceptance/demonstration.test.ts`, SPEC.md section 22.1).

A requirement that the first release does not meet appears in
"Unsupported requirements", never silently omitted from this map.

## Verified workflows

Three workflows are the release checks. Each was executed on the
committed tree; see "Verification record" for the results.

### Clean-checkout build

1. Copy the repository to a fresh directory.
2. Remove `node_modules` and `dist` from the copy.
3. Run `npm ci --no-audit --no-fund`.
4. Run `npm test`. The command builds with `tsc`, then runs every
   suite under `dist/` with `node --test`.

```bash
rm -rf /tmp/porta-clean
cp -r . /tmp/porta-clean
cd /tmp/porta-clean
rm -rf node_modules dist
npm ci --no-audit --no-fund
npm test
```

The clean checkout proves the package file set is complete: no suite
depends on a file that the lockfile install cannot restore.

### Local conformance suite

The suite loads one adapter module and runs the SPEC.md section 21
case packs against it. Two runs cover every pack with the adapters
this repository ships.

The local process adapter, with both authority grants:

```bash
mkdir -p /tmp/porta-conf/supervisor /tmp/porta-conf/workspace
cat > /tmp/porta-conf/worker-adapter.mjs <<'EOF'
import { LocalProcessAdapter } from "<repo>/dist/adapters/local-process-adapter.js";
export const adapter = new LocalProcessAdapter({
  supervisorDir: "/tmp/porta-conf/supervisor",
  workingCopyRoot: "/tmp/porta-conf/workspace",
});
EOF
node dist/cli/main.js conformance \
  --adapter /tmp/porta-conf/worker-adapter.mjs \
  --adapter-version 0.1.0 \
  --external-effects --paid-allocation \
  --store /tmp/porta-conf/store.db
```

Replace `<repo>` with the checkout path. This run executes every pack.
The `python` pack skips with reason `capability-not-offered`, because
the local process adapter offers no `exec.python@1` capability. The
expected report is 70 cases: 63 pass, 0 fail, 7 skip, and the process
exits with code 3. Exit 3 means "no failure, but at least one skip":
skipped support is not established support.

The lightweight Python adapter, for the `python` pack:

```bash
node dist/cli/main.js conformance \
  --adapter <a module exporting a MontyPythonAdapter> \
  --adapter-version 0.1.0 \
  --profile python --external-effects \
  --store /tmp/porta-conf/store-python.db
```

The expected report is 7 cases: all pass, and the process exits 0.

A run without grants exercises the refusal path: cases that cause
external effects or paid allocation skip with
`external-effects-not-authorized`. The expected report is 70 cases:
43 pass, 0 fail, 27 skip (26 for the missing grant and
`python.full-python-requirement` for the missing capability), and the
exit code is 3.

### Authorized acceptance demonstration

The demonstration is one suite inside `npm test`
(`src/acceptance/demonstration.test.ts`). Run it alone:

```bash
npm run build
node --test dist/acceptance/demonstration.test.js
```

The run walks the seven steps of SPEC.md section 22.1 over
`fixtures/acceptance`. It asserts the acceptance criteria directly:
old compute handles fail after a switch, the browser handle survives,
the workspace conflict names the earlier revision, and no obligation
stays pending at the end. The automated destination is the honest
local stand-in; see "Unsupported requirements" for the remote Linux
story.

## Requirements coverage

### 1. Purpose

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| MUST and MUST NOT define requirements; SHOULD and MAY are weaker (line 19). | This convention governs `SPEC.md` and this map. | This document marks weaker items only where the spec marks them. |

### 2. Architecture and ownership

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| The runtime MUST check requested capabilities and authorized limits; a manifest alone does not establish trust (line 67). | `runtime/acquisition.ts` validates the acquired manifest against the stored request and policy; `core/matching.ts` evaluates requirements. | `test:runtime/acquisition`, `conf:matching.declared-restrictions` |
| Portable MUST NOT assume attached environments share a filesystem, network, operating system, or identity (line 69). | Workspaces cross attachments as revisions and transfers (`runtime/workspace.ts`, `runtime/export.ts`); services cross through authorized connections (`runtime/service-connections.ts`); no attachment reads another's files implicitly. | `test:runtime/export`, `test:runtime/service-connections`, `conf:bundle.import-without-execution`, `demo` |

### 3. Terms and identifiers

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Identifiers MUST be opaque; their representation MUST NOT grant authorization or embed credentials (line 88). | Every identifier is a generated opaque string; authorization comes from the policy authority, never from parsing an identifier. | `test:schema/records`, `test:core/policy` |
| Consumers MUST NOT infer behavior from identifier prefixes (line 90). | Prefixes (`ses_`, `att_`, and so on) are display conventions only; no code path branches on them. | `test:schema/records` |
| Attachment names MUST be unique in a session and match `[a-z][a-z0-9_-]{0,63}` (line 92). | `runtime/session.ts` validates names; the control store enforces uniqueness per session. | `test:runtime/session` |
| Timestamps MUST use UTC with a `Z` suffix; durations use integer milliseconds; sizes use integer bytes (line 94). | `core/time.ts` formats timestamps; schemas declare integer milliseconds and bytes. | `test:schema/scalars` |

### 4. Core invariants

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| The implementation MUST maintain the invariant list: durable admission before dispatch, no silent retry, fencing on every mutation, explicit unknowns, and no implicit cross-environment assumptions (line 98). | `store/control-store.ts` (transactions, compare-and-swap, fencing tokens), `runtime/admission.ts`, `runtime/outcomes.ts`, `runtime/replacement.ts`. | `test:store/mutation-lease`, `test:store/control-store`, `test:runtime/admission`, `test:runtime/outcomes`, `conf:replacement.phase-failures` |

### 5. Sessions and control storage

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| The control store MUST support durable transactions, uniqueness constraints, and atomic compare-and-swap (line 139). | `store/control-store.ts`: `transaction`, `casUpdate`, `CAS_TABLES`, schema constraints. | `test:store/control-store` |
| Multiple CLI processes MUST share the same store and locking rules (line 141). | The CLI opens one store file through the same `ControlStore`; mutation leases and fencing serialize writers across processes. | `test:cli/main.e2e`, `test:store/mutation-lease` |
| Blob durable existence MUST be verified before a transaction references a blob (line 143). | `store/blob-store.ts` verifies presence before a referencing commit. | `test:store/blob-store`, `conf:bundle.missing-blobs` |
| An attachment mutation MUST hold a durable lease with a monotonically increasing fencing token, validated in every transaction (line 145). | `store/control-store.ts`: `acquireMutationLease`, `mutateWithLease`, token checks inside each transaction. | `test:store/mutation-lease` |
| An expired worker MUST NOT commit after another worker acquires the lease, even on a late provider success (line 147). | Fencing rejects stale tokens in `mutateWithLease`; every lifecycle write passes through it. | `test:store/mutation-lease`, `conf:replacement.expired-mutation-lease` |
| Provider acquisition MUST use a durable request identifier; the adapter MUST be idempotent or reconcile by it (line 149). | `runtime/acquisition.ts` stores the request with its identifier; adapters implement idempotent `acquire` plus `reconcile`. | `test:runtime/acquisition`, `conf:acquisition.duplicate-request`, `conf:acquisition.reconciliation` |
| An unidentifiable allocation MUST surface as an unresolved allocation; the runtime MUST NOT silently retry and forget it (line 151). | `runtime/lifecycle.ts` records unresolved-allocation obligations; `reconcileAttachment` resolves them by identity. | `test:runtime/lifecycle`, `conf:acquisition.lost-response` |
| Invocation admission MUST atomically check session status, attachment status, generation, and lease validity while recording the operation (line 155). | `runtime/admission.ts` performs the check and the insert in one transaction. | `test:runtime/admission`, `conf:operations.duplicate-request` |
| Replacement preparation MUST block new admissions atomically before inspecting active operations (line 157). | `runtime/replacement.ts` moves the attachment to `replacing` under the mutation lease before the fence check. | `test:runtime/replacement`, `conf:replacement.phase-failures` |

### 6. Capability contracts

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Provider-specific behavior MUST NOT be presented as a shared capability unless it satisfies that capability's semantics (line 171). | Capability descriptors live in `runtime/process-capability.ts`, `runtime/python-capability.ts`, `runtime/browser-capability.ts`, `runtime/workspace-capability.ts`, `runtime/service-capability.ts`; matching reads the contract semantics in `core/matching.ts`. | `test:core/matching`, `conf:matching.unknown-constraint` |
| Input and output schemas MUST use JSON Schema draft 2020-12 and stay JSON-serializable (line 195). | `schema/contracts.ts` declares the schemas; `schema/validate.ts` enforces them. | `test:schema/contracts` |
| Retry and cancellation semantics MUST be specified per operation (line 197). | Each operation schema declares its retry and cancellation shape; `runtime/cancellation.ts` implements the runtime side. | `test:schema/contracts`, `conf:operations.unconfirmed-cancellation` |
| Unknown descriptive extensions MAY be ignored; unknown requirements or policy constraints MUST be rejected (line 201). | `core/compatibility.ts` sorts required extensions; `core/matching.ts` rejects constraints no contract defines. | `test:core/compatibility`, `conf:matching.unknown-constraint`, `conf:bundle.unknown-required-extension` |
| The runtime MUST validate the acquired manifest against the request (line 223). | `runtime/acquisition.ts` compares manifest capabilities, platform, and enforcement with the stored request. | `test:runtime/acquisition` |
| `requires`, platform fields, resource minima, and constraints are mandatory; matching rules MUST come from the contract (line 244). | `core/matching.ts` implements only the contract's rule set; object similarity is never used. | `test:core/matching`, `conf:matching.insufficient-resources` |
| Version one MUST support explicit provider selection; zero matches return `RequirementUnsatisfied`, multiple matches return `AmbiguousEnvironment` (line 246). | `core/matching.ts` `matchEnvironment` returns exactly those codes. | `test:core/matching`, `conf:matching.ambiguous-provider`, `conf:python.full-python-requirement` |

### 7. Authorization and policy

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Principal and policy come from the embedding application; they MUST NOT come from model-controlled input (line 252). | Every runtime method takes an explicit `authority`; no operation input carries a principal or policy. | `test:runtime/admission`, `test:core/policy` |
| The CLI uses its configured local account; hosted embeddings MUST provide their own boundary (line 254). | `cli/config.ts` resolves the principal and policy file for CLI commands. | `test:cli/cli`, `docs/cli.md` |
| Policy MUST be checked before acquisition, invocation, resource binding, workspace transfer, and service exposure (line 256). | The checks sit at the entry of `runtime/acquisition.ts`, `runtime/admission.ts`, `runtime/resources.ts`, `runtime/export.ts`, and `runtime/service-connections.ts`. | `test:core/policy`, `conf:matching.policy-denial` |
| Version one MUST represent the listed limits: providers, operations, lifetimes, transfer destinations, network egress, and service audiences (line 258). | `schema/policy.ts` declares the policy record; `core/policy.ts` enforces every limit. | `test:core/policy` |
| An unspecified permission MUST inherit the configured policy; it MUST NOT default to broader access (line 267). | `core/policy.ts` resolves each check against the policy record; absence of a grant is refusal. | `test:core/policy` |
| A local process adapter MUST declare its actual host access and reject isolation requirements it cannot enforce (line 271). | `adapters/local-process-adapter.ts` declares `ENFORCEMENT` (no isolation, full host filesystem, inherited network) and rejects unsatisfiable requirements at acquisition. | `conf:matching.declared-restrictions`, `docs/adapters` |
| Offers and manifests MUST carry typed enforcement facts; a target without them never matches, and missing evidence never becomes an implicit grant (line 273). | `schema/capability.ts` types `enforcementFacts` on offers and manifests; `core/policy.ts` `checkAcquisitionTarget` denies any target without facts, at match and again at activation. | `test:runtime/acquisition`, `conf:acquisition-policy` |
| Every acquire MUST carry the effective acquisition limits; a provider rejects restrictions it cannot enforce before allocating, and every lease names its end (line 275). | `PolicyAuthority.acquisitionLimits()` builds the `limits` field of `AuthorizedAcquireRequest`; each adapter refuses unsatisfiable limits before allocation; `checkLeaseGrant` refuses a grant without an expiration or beyond the ceiling. | `test:runtime/acquisition`, `test:adapters`, `conf:matching.unenforceable-limits`, `docs/adapters` |
| Credentials MUST arrive through an authorized secret resolver at execution time; checkpoints and references carry references, not values (line 277). | `core/secrets.ts` resolves and scrubs; bundle export refuses credential-shaped values. | `test:core/secrets`, `conf:bundle.credential-references` |
| Revocation blocks new admissions at once, cancels existing operations where possible, and reports unconfirmed cancellation (line 281). | `runtime/revocation.ts` updates policy, issues cancellations, and records unconfirmed stops as unknown. | `test:runtime/revocation` |

### 8. Environment adapters and leases

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Named supporting types MUST be defined by the implementation's schemas under this specification's rules (line 305). | `schema/adapter.ts`, `schema/capability.ts`, and their siblings define every named type. | `test:schema/records` |
| Adapter invocation context MUST include the operation identifier, deadline, limits, and allocation identity; credentials stay outside public inputs (line 307). | `schema/adapter.ts` `AdapterInvocation` carries exactly those fields. | `test:schema/contracts` |
| `release` MUST be idempotent; adapters MUST report unsupported binding and cancellation explicitly (line 309). | Adapters' `release` succeeds on repeat; `bind` returns `unsupported`; cancellation reports `best-effort` with a detail. The local adapter also stops descendants orphaned by an exited leader — with the same grace and escalation, and from a reopened adapter — and reports a group that will not confirm as a failed release. | `conf:acquisition.release-retry`, `conf:process.release-orphaned-group`, `test:runtime/release`, `test:adapters/local-process-adapter` |
| Each lease MUST record expiration, renewal support, and enforcement behavior; the runtime MUST stop new invocations after expiration (line 311). | Lease status in `schema/adapter.ts`; `runtime/lifecycle.ts` refuses work past expiry; leases enforce their own expiry. | `conf:acquisition.lease-expiration`, `test:runtime/lifecycle` |
| Cleanup obligations MUST survive restart and stay visible through inspection (line 315). | Obligations are rows in the control store; `describe()` reports `pendingCleanup`. The local adapter keeps an unconfirmed stop in the durable process record, where a later process reads it. | `test:runtime/lifecycle`, `conf:replacement.failed-source-cleanup`, `test:adapters/local-process-adapter` |
| An expired or unreachable attachment MAY enter `unavailable` and MUST reject invocations until reconciliation succeeds (line 329). | `runtime/lifecycle.ts` `checkAttachmentAcceptsOperations` returns `LeaseExpired` and `ProviderUnavailable` as separate codes; `reconcileAttachment` restores. | `test:runtime/lifecycle` |
| Release and replacement MUST serialize on the same attachment mutation lease (line 331). | Both flows take the mutation lease before writing; the fencing token guards the switch. | `test:runtime/release`, `test:runtime/replacement`, `conf:replacement.expired-mutation-lease` |

### 9. Invocation and operation journal

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| The runtime MUST record acceptance before dispatch and outcomes before acknowledging (line 361). | `runtime/admission.ts` commits the record first; `runtime/outcomes.ts` commits the settlement before the call returns. | `test:runtime/admission`, `demo` |
| `(sessionId, requestKey)` MUST identify one request; reuse for different work returns `RequestConflict` (line 363). | Admission compares the whole invocation identity — input hash, capability, operation, attachment identifier, and generation — before answering a used key. | `conf:operations.duplicate-request`, `conf:operations.mismatched-input`, `test:runtime/admission` |
| A repeated request returns the existing operation and MUST NOT blindly redispatch (line 365). | The admission path returns the stored record without a second dispatch. | `conf:operations.duplicate-request`, `test:runtime/admission` |
| Dispatch is claimed once; only the caller whose transaction moves `accepted` to `running` may invoke the provider, and every other caller adopts the record (line 367). | `claimOperationDispatch` in `runtime/outcomes.ts` owns the compare-and-set; the session exposes it as `claimDispatch`, and the harness, the reconstruction steps, and the acceptance demonstration claim before every provider call. A lost claim reads the stored outcome, waits bounded for a running holder, or reports the unknown. | `test:runtime/outcomes`, `test:harness/agents-sdk`, `test:runtime/replacement`, `conf:operations.concurrent-dispatch-claim`, `demo` |
| A timeout does not establish cancellation; a lost response after dispatch MUST yield `unknown` unless reconciliation resolves it (line 382). | `runtime/cancellation.ts` records the attempt as unconfirmed; `runtime/outcomes.ts` marks the outcome unknown. | `conf:operations.unconfirmed-cancellation`, `conf:operations.lost-response-after-effects` |
| An unknown record MAY resolve later; the journal MUST retain the original uncertainty and the evidence (line 384). | `runtime/outcomes.ts` `reconcileOperation` appends reconciliation trails and never rewrites history. | `conf:operations.reconciliation-history` |
| Journal entries MUST be append-only and ordered, with identifier, sequence, timestamp, and event type (line 388). | `store/event-stream.ts` appends numbered events inside each state transaction. | `test:store/event-stream`, `conf:events.state-transaction-consistency` |
| Output chunks MUST identify operation, stream, and sequence; standard output and error stay separate (line 390). | `runtime/output.ts` shapes chunk records with stream identity. | `test:runtime/output`, `conf:process.binary-output` |
| Sequence order within one stream MUST be preserved (line 392). | Assembly follows chunk sequence per stream. | `test:runtime/output` |
| Output limits MUST be explicit; truncation MUST report omitted bytes and whether execution continued (line 394). | `runtime/output.ts` and the local adapter's `Capture` report `truncated` and `omittedBytes`. | `conf:process.output-limits` |
| Artifact records MUST include digest, byte size, media type, and authorized retrieval location (line 396). | `store/blob-store.ts` records digests and sizes; artifact records carry media type and location. | `test:store/blob-store`, `test:runtime/provenance` |
| Operation metadata MUST NOT contain secret values (line 398). | `core/secrets.ts` scrubs metadata; export policy governs raw outputs. | `test:core/secrets`, `conf:bundle.credential-references` |

### 10. Resource references

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Resolving a resource MUST check authorization, owner generation, resource status, and lease validity (line 414). | `runtime/resources.ts` performs all four checks. | `test:runtime/resources`, `conf:resources.stale-generation` |
| The provider resource identifier MAY stay stable; the runtime MUST NOT make an old binding valid again (line 418). | Replacement invalidates bindings; reattachment mints a new binding record. | `conf:resources.stale-generation` |
| Dependent service bindings MUST be invalidated and recreated explicitly (line 422). | The switch invalidates service bindings; `reconnectBrowserService` recreates them on request. | `test:runtime/service-connections`, `conf:resources.invalidated-service-connection`, `demo` |
| Reference serialization MUST omit tokens, signed URLs, and cookies (line 424). | `core/secrets.ts` refuses credential-shaped values in serialized references. | `conf:bundle.credential-references` |

### 11. Workspace specification

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Version one MUST support binary content and UTF-8 paths (line 430). | `store/workspace-tree.ts` stores bytes and paths without text assumptions. | `conf:workspace.binary-roundtrip`, `conf:workspace.unicode-paths` |
| Paths MUST be relative with `/` separators and no empty, `.`, or `..` segments; absolute paths and null bytes MUST be rejected (line 432). | `runtime/workspace.ts` validates every path. | `conf:workspace.invalid-paths` |
| Version one MUST reject symbolic links, hard links, device files, and sockets with explicit errors, never dereferencing them (line 434). | The importer refuses them with a naming reason. | `conf:workspace.unsupported-links` |
| Materialization MUST reject collisions and unrepresentable paths; adapters MUST NOT silently rename (line 438). | `runtime/workspace.ts` materialization stops on collision. | `test:runtime/materialize` |
| Blobs MUST be addressed by SHA-256; tree manifests MUST sort entries by UTF-8 path bytes (line 460). | `store/workspace-tree.ts` computes digests and sorts entries. | `test:store/workspace-tree` |
| The root digest MUST hash the sorted entry array exactly as specified, with original Unicode sequences kept (line 464). | `store/workspace-tree.ts` implements the encoding rule. | `test:store/workspace-tree`, `conf:workspace.unicode-paths` |
| Importers MUST validate every referenced blob before publishing (line 466). | Publication follows blob verification. | `conf:workspace.hash-mismatch` |
| Acceptance MUST compare the head with the proposal base in one transaction; a mismatch returns `WorkspaceConflict` without moving the head (line 476). | `runtime/proposal.ts` performs the compare-and-set. | `conf:workspace-authority.concurrent-proposals`, `demo` |
| Version one MUST NOT merge automatically (line 478). | No merge code exists; a new proposal against the current head is the only path. | `test:runtime/proposal` |
| A checkpoint requires a stable source through a lock or snapshot (line 484). | `Session.checkpoint` requires a stability declaration. | `conf:workspace-authority.stability-declaration` |
| Without a lock or snapshot, the runtime MUST refuse a consistency-guaranteed checkpoint (line 486). | The stability declaration names its kind; reading files twice is not an accepted kind. | `conf:workspace-authority.stability-declaration` |
| The bridge MUST stage contents and keep a recovery journal before changing destination files (line 490). | `runtime/workspace.ts` stages and journals; a crash completes from the stage. `runtime/export.ts` applies the staged tree by path and kind, verifies it against the journal hash before recovery publishes, and records the bridge state only after the destination hashes to the revision. | `conf:workspace-authority.interrupted-export`, `conf:workspace-authority.export-type-change`, `conf:workspace-authority.checkpoint-lock` |
| Export MUST fail when local files differ from the recorded base, without overwriting them (line 492). | The bridge compares before applying. | `conf:workspace-authority.local-edits-during-export` |
| Every workspace-backed invocation MUST record its base revision and working copy identifier (line 496). | `runtime/provenance.ts` records both. | `test:runtime/provenance`, `demo` |
| A command on a modified copy MUST NOT claim it tested the unmodified base (line 498). | Provenance reports `copyModified`. | `test:runtime/provenance`, `demo` |
| Verification runs MUST exclude unrelated writers and record input and output tree hashes; input changes MUST be reported (line 500). | `prepareVerificationRun` and `settleVerificationRun` enforce and record; both are idempotent, so a repeated call returns the recorded staging or answer without staging a second copy. | `test:runtime/provenance`, `demo` |
| Results MUST record command arguments, adapter version, manifest digest, and dependency identifiers (line 502). | The provenance record carries every field. | `test:runtime/provenance` |
| Transfers MUST validate destination policy before sending bytes (line 508). | `runtime/export.ts` checks policy first. | `test:runtime/export` |
| The importer MUST enforce limits on file count, file size, and total size before publishing (line 510). | Import options carry the limits; publication follows the checks. | `conf:workspace.size-limits` |
| Exclusion rules MUST be explicit and stored with import provenance (line 512). | Import options name exclusions; the record keeps them. | `test:runtime/workspace` |
| Excluded content is not preserved; required dependencies MUST be reconstructed or stored as artifacts (line 514). | Reconstruction recipes rebuild dependencies on the destination. | `test:runtime/reconstruction`, `demo` |

### 12. State classes and reconstruction

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Recipes MUST declare input revision, required capabilities, operations, outputs, and failure conditions (line 525). | `schema/handoff.ts` defines the recipe shape; validation rejects incomplete recipes. | `test:runtime/replacement`, `test:schema/records` |
| Recipes MUST use ordinary authorized invocations and MUST NOT run implicitly while parsing a bundle (line 527). | `runtime/reconstruction.ts` dispatches through admission; `runtime/bundle-import.ts` never executes recipes. | `conf:bundle.import-without-execution`, `test:runtime/reconstruction` |
| Version one MUST support invalidation of native state; snapshot restoration is optional (line 529). | The switch records invalidated bindings per resource; no native snapshot restore exists. | `test:runtime/replacement`, `demo` |

### 13. Replacement protocol

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| `planReplace` MUST report preserved, reconstructed, reattached, and invalidated state and allocate nothing (line 549). | `runtime/session.ts` `planReplace` reads durable state only. | `test:runtime/replacement` |
| An execution request MUST reject invalidation of a resource in `requiredResources` (line 551). | Request validation in `runtime/replacement.ts`. | `test:runtime/replacement` |
| An unknown operation outcome blocks replacement; a timeout MUST NOT bypass the block (line 563). | The fence refuses an unknown outcome under every policy. | `conf:replacement.unknown-operations` |
| Background writers of the managed copy MUST stop before checkpointing (line 565). | The fence quiesces active operations; recipe failure conditions name them. | `test:runtime/replacement`, `conf:replacement.phase-failures` |
| The switch MUST verify source generation, fencing token, and the validated destination record, then atomically record the new generation, invalidations, and events (lines 565 and 567). | The switch transaction in `runtime/replacement.ts` checks all three and commits as one unit. | `conf:replacement.expired-mutation-lease`, `conf:replacement.duplicate-switch` |
| Unrelated attachments MUST NOT change generation (line 580). | The transaction touches only the named attachment. | `test:runtime/replacement`, `demo` |
| Replacement transfers a revision but MUST NOT advance the workspace head (line 582). | The head moves only through proposal acceptance. | `test:runtime/replacement`, `demo` |
| Recovery MUST NOT reactivate the old generation after a committed switch (line 596). | A committed switch is terminal; only new requests move state. | `conf:replacement.duplicate-switch` |
| Surviving effects of an abort MUST be listed in the failure report (line 598). | `abortReplacement` returns `survivingEffects`. | `test:runtime/replacement`, `demo` |
| Version one MUST support compute replacement and MAY reject browser replacement while preserving the browser (line 600). | Compute replacement is complete; browsers are preserved and reconnected, never replaced. | `conf:resources.browser-survival`, `demo` |

### 14. Initial capability profiles

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Commands MUST accept argument arrays; shell interpretation only on explicit shell invocation (line 608). | `exec.process@1` run input takes `args`. | `conf:process.argument-preservation` |
| Working directories MUST resolve inside the authorized copy unless host access is explicit (line 610). | `resolveProcessCwd` in `runtime/process-capability.ts`. | `conf:process.working-directory` |
| `terminate` MUST state whether termination and descendant stops are confirmed (line 614). | The terminate result carries `confirmed` and `descendantsStopped`. | `conf:process.descendant-termination` |
| Adapters MUST describe signals, descendant termination, binary output, and process lifetime; unsupported requirements MUST fail matching (line 616). | Process attributes in `runtime/process-capability.ts`; matching enforces them. | `conf:matching.declared-restrictions` |
| The Python descriptor MUST declare engine, subset, imports, persistent-state behavior, and limits (line 624). | `runtime/python-capability.ts`. | `conf:python.declared-subset` |
| Matching MUST distinguish lightweight interpreter semantics from full Python (line 626). | The subset requirement refuses providers that declare a lesser subset. | `conf:python.full-python-requirement` |
| Evaluation calls MUST be isolated; interpreter locals MUST NOT become portable state (line 628). | Every evaluate call runs standalone. | `conf:python.state-isolation` |
| Filesystem writes MUST be atomic per file; read-only copies MUST reject mutations (line 634). | `runtime/workspace-capability.ts`. | `test:runtime/workspace-capability` |
| Binary reads and writes MUST use an explicit encoding or artifact transfer; path validation applies to every operation (line 636). | Same module. | `test:runtime/workspace-capability` |
| `create` returns a browser resource; the descriptor MUST declare persistence, reattachment, interactions, and network constraints (line 644). | `runtime/browser-capability.ts` and `adapters/browser-adapter.ts`. | `test:runtime/browser-capability` |
| Closing compute MUST NOT close a browser of another attachment; provider browser expiry MUST be reported (line 646). | Browser lifetime is independent; `observeSession` reports provider state. | `conf:resources.browser-survival`, `conf:resources.expired-browser`, `demo` |
| Cookies and browser state stay provider-owned; Portable MUST NOT export them (line 648). | Browser sessions carry provider identifiers only; export scrubs the rest. | `conf:bundle.credential-references` |
| Service exposure MUST require explicit authorization; credentials resolve at use time and stay out of bundles (line 654). | `runtime/service-connections.ts` authority checks. | `test:runtime/service-connections` |
| `expose` identifies process, port, protocol, audience, and expiration; public exposure MUST be explicit (line 662). | The expose input carries every field; the audience names the grant. | `test:runtime/service-connections` |
| `connect` MUST validate exposure and consumer network policy (line 664). | `connectService` checks both. | `test:runtime/service-connections` |
| The service reference MUST identify its compute generation; replacing or releasing that generation invalidates it (line 666). | Service bindings name their owner generation; the switch and release invalidate. | `conf:resources.invalidated-service-connection`, `demo` |

### 15. Library interface

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Public records MUST remain JSON-serializable (line 696). | Every record validates against JSON Schema; `schema/validate.ts` enforces it. | `test:schema/records`, `test:schema/contracts` |
| Long operations MUST expose durable identifiers before completion; cancelling a local wait MUST NOT cancel the remote operation (line 698). | Admission returns the operation identifier at once; cancellation is a separate explicit call. | `test:runtime/cancellation`, `test:cli/operations` |
| Typed helpers MAY wrap `invoke` but MUST preserve authorization, journaling, and errors (line 700). | The exported helpers in `runtime/session.ts` route through the same admission path. | `test:runtime/session`, `test:cli/examples` |

### 16. CLI contract

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| The CLI MUST call the same library contracts and MUST NOT keep separate lifecycle rules (line 704). | `cli/commands.ts` binds one store and calls `PortableRuntime` methods only. | `test:cli/cli`, `test:cli/main.e2e` |
| Structured requests SHOULD use files or standard input; the CLI MUST NOT require shell interpolation of JSON or secrets (line 724). | Commands read request files or standard input. | `test:cli/cli` |
| Each command MUST identify the session explicitly or through documented configuration; it MUST NOT guess (line 732). | `--session` or the local configuration; ambiguity refuses. | `test:cli/cli`, `docs/cli.md` |

### 17. Harness integration

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| The first integration MUST route managed execution through Portable (line 736). | `harness/agents-sdk.ts` exposes `portable_environment`, `portable_checkpoint`, and `portable_run` tools. | `test:harness/agents-sdk`, `docs/harness.md` |
| The integration MUST define whether built-in shell and file operations use a local bridge or stay excluded (line 738). | The toolkit routes local-bridge commands and documents exclusions. | `docs/harness.md` |
| Before remote verification, the integration MUST synchronize local edits through the checkpoint contract (line 740). | `portable_checkpoint` publishes a revision before remote runs. | `test:harness/agents-sdk`, `demo` |
| Environment changes MUST reach the agent through a tool result or explicit context update (line 742). | Tool results carry capability and revision state. | `test:harness/agents-sdk` |
| A harness approval MUST become bounded authority; Portable MUST NOT infer approval from generated text (line 744). | Approvals translate into a policy record the embedding supplies. | `test:harness/agents-sdk`, `docs/harness.md` |
| The integration MUST demonstrate session reopening without claiming conversation restoration (line 746). | `reopen()` reports `conversationRestored: false` and the retained state. | `test:harness/agents-sdk`, `demo` |

### 18. Events and errors

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| State changes and events MUST commit atomically; consumers resume by sequence and tolerate duplicates (line 773). | `store/event-stream.ts` `commitWith` joins event and state in one transaction. | `conf:events.state-transaction-consistency`, `conf:events.resume-by-sequence`, `conf:events.duplicate-delivery` |
| Replacement events MUST include generations, environments, capability changes, selected revision, and dispositions (line 775). | `schema/event-payload.ts` defines the replacement payload. | `test:schema/event-payload`, `test:runtime/replacement` |
| Errors MUST distinguish invalid input, policy denial, unsupported semantics, and temporary provider failure, and MUST NOT expose credentials (line 791). | `core/errors.ts` codes; scrubbing in `core/secrets.ts`. | `test:core/errors`, `test:core/secrets` |

### 19. Portable state bundle

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| The manifest MUST include schema version, session, revision and root hash, attachment generations, artifact inventory, and dispositions (line 808). | `schema/bundle.ts`. | `test:schema/records`, `test:runtime/bundle` |
| An export MUST declare blob inclusion; reference-only exports identify retrieval locations (line 810). | `runtime/bundle.ts` records the mode. | `test:runtime/bundle` |
| The optional harness context reference stays opaque; import MUST NOT claim interpretation (line 812). | `harnessContextRef` crosses uninterpreted. | `test:runtime/bundle`, `test:runtime/bundle-import` |
| Import MUST validate paths, hashes, sizes, schema versions, and policy before materializing, and MUST NOT execute recipes (line 814). | `runtime/bundle-import.ts`. | `conf:bundle.tampered-content`, `conf:bundle.import-without-execution` |
| A bundle MUST NOT create a second authoritative controller (line 818). | Import refuses when the source session exists in the store. | `conf:bundle.no-competing-controller` |

### 20. Extensions and compatibility

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Objects MAY carry an `extensions` map; optional data MUST NOT change core semantics (line 822). | Extension maps are declared across schemas and ignored when unknown. | `test:schema/records`, `test:core/compatibility` |
| A correctness-affecting extension MUST be declared in `requiredExtensions`; a consumer that lacks it MUST reject (line 824). | `core/compatibility.ts`. | `conf:bundle.unknown-required-extension` |
| Provider-native access MAY exist as an authorized extension and MUST disclose what it cannot enforce (line 826). | Adapter enforcement declarations name the gaps (for example, the local adapter's `isolation: none`). | `conf:matching.declared-restrictions`, `docs/adapters` |
| Published contracts MUST include schemas, semantics, and a conformance profile (line 828). | Each capability module pairs schemas with a conformance pack. | The pack files under `src/conformance/cases/` |

### 21. Conformance requirements

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Results MUST identify specification version, adapter version, provider configuration, tested profiles, and skips (line 832). | `conformance/runner.ts` builds and validates the report. | `test:conformance/runner`, the workflows above |
| Skips MUST NOT count as support; paid or external-effect tests MUST run only under configured authority (line 834). | The runner refuses by default and marks skips `established: false`. | `test:conformance/runner`, `test:conformance/cases/python` |
| Replacement tests MUST inject crashes before and after the switch and verify stale controllers cannot commit (line 850). | `conformance/cases/replacement-resources.ts`. | `conf:replacement.controller-restart`, `conf:replacement.expired-mutation-lease` |

### 22. First release deliverables

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| The release MUST include the runtime and schemas, the stores, the CLI, the three adapters, the browser adapter and service connectivity, recovery with reconciliation and visible cleanup, the conformance tests, and the demonstration (line 856). | `src/index.ts` and the modules it exports; `cli/`; `adapters/`; `conformance/`; `acceptance/`. | `npm test` runs every suite; the workflows above |
| Each selected provider MUST satisfy its profile or document an explicit unsupported requirement (line 866). | The providers that run locally satisfy their packs; the remote Linux provider's status appears below. | "Unsupported requirements" |
| The demonstration MUST show old compute handles failing and the browser handle valid (line 880). | Step 6 and step 7 assertions. | `demo` |
| The demonstration MUST show the workspace conflict and identify the earlier revision (line 882). | The conflict evidence block. | `demo` |

### 23. Deferred work

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Later additions MUST preserve explicit state validity, authorized execution, and workspace provenance (line 900). | No deferred feature exists in version one; the constraint governs future work and this document states it. | This section |

## Unsupported requirements

These are the honest gaps of the first release. Each one is a
deliberate stand-in or a documented limit, not a silent omission.

1. **Remote Linux in the automated demonstration.** The E2B adapter
   (`src/adapters/e2b-adapter.ts`, `docs/adapters/e2b-linux.md`)
   implements the remote Linux profile, but it needs operator
   credentials. The automated demonstration runs
   `remoteLinuxStandin`: a second, independent local process provider
   that identifies itself as `remote-linux-standin` in every durable
   record. The report says so and names the E2B path an operator with
   credentials takes. The demonstration never claims a remote machine
   ran.
2. **Rendered browser pages.** The reference browser driver loads
   documents over HTTP and follows the data endpoint each page
   declares. It executes no page script, and its screenshot is a
   one-pixel marker. Its network enforcement is real: every redirect
   hop and declared dependency is checked against the session's
   recorded rules before the request leaves the driver, and private
   ranges are refused by name, by literal address, and at the
   connection's own resolution (see `docs/adapters/browser-reference.md`).
   A real integration supplies a driver backed by a browser engine;
   the adapter and the flows above it do not change.
3. **E2B credentials.** No credentials exist in this repository, so
   the E2B adapter has no executed run here. Its write-ahead
   acquisition protocol is documented in `docs/adapters/e2b-linux.md`.
   The working-copy evidence — executable bits, staged-swap
   publication, interrupted upload and recovery — rests on the
   injected client of
   `test:adapters/e2b-adapter`, not on a live provider run. The
   opt-in live smoke test checks a full lifecycle, an uploaded
   executable script that must run, and outbound access from a
   subprocess in both network configurations when `E2B_API_KEY` is
   set; without the key it skips, and a skip is unverified, never
   passed.
4. **`browser.cdp@1` profile.** The browser capability exposes
   session, navigation, and observation operations. The Chrome DevTools
   Protocol profile is optional in the specification and no adapter
   offers it.
5. **Native snapshot restoration.** The specification makes it
   optional. Replacement reconstructs state through recipes and
   invalidates the old bindings instead.
6. **Deferred features.** Automatic provider selection, multiple
   authoritative workspace writers, automatic merging, harness
   migration, and an MCP transport are deferred (SPEC.md section 23).

## Verification record

- Clean checkout: `npm ci` then `npm test` — 478 tests, 477
  pass, 1 skip (live E2B, no key), 0 fail.
- Conformance, local process adapter, all packs, both grants: 70
  cases, 63 pass, 7 skip (`capability-not-offered`), exit 3.
- Conformance, Python pack, lightweight adapter, external effects
  granted: 7 cases, 7 pass, exit 0.
- Conformance, local process adapter, no grants: 70 cases, 43 pass,
  27 skip (26 `external-effects-not-authorized`, 1
  `capability-not-offered`), exit 3.
- Acceptance demonstration: part of `npm test`; all assertions pass
  with no leaked server process.
- Live E2B smoke: unverified — no `E2B_API_KEY` in this environment.
  The suite records it as skipped, never passed.
- Specification: `0.1.0-draft.1`. Implementation: `0.1.0`.
