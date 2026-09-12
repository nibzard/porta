# Review repair plan

Date: 2026-09-12. Status: in progress. R1 through R3 are complete; R4 through R9 remain.

This plan covers all eight defects found in the project review. It includes the related documentation and validation work.

The review baseline is 442 passing tests, zero failures, and one skipped test. Focused reproductions expose gaps outside that coverage. Remote transfer reproductions use an injected client. They do not establish live E2B behavior.

## Repair order

| Order | Work item | Priority | Dependency |
| --- | --- | --- | --- |
| 1 | R1: Enforce acquisition policy | P1 | None |
| 2 | R2: Claim operation dispatch once | P1 | None |
| 3 | R3: Apply E2B network restrictions | P1 | R1 for integrated validation |
| 4 | R4: Enforce browser network restrictions | P1 | R1 for integrated validation |
| 5 | R5: Release orphaned process groups | P2 | None |
| 6 | R6: Preserve remote executable bits | P2 | None |
| 7 | R7: Publish exact remote workspace trees | P2 | R6 for complete tree verification |
| 8 | R8: Export entry type changes | P2 | None |
| 9 | R9: Complete conformance and release evidence | Release gate | R1–R8 |

Keep each repair and its regression tests in one reviewable change. R6 and R7 share transfer interfaces. Design those interfaces together, then implement them in this order. R3 and R4 can use the policy contract established by R1.

Each repair starts with a failing regression test. Use temporary files, loopback servers, and injected provider clients. Coordinate concurrency tests with explicit barriers instead of timing assumptions.

## R1: Enforce acquisition policy

> **Status: complete (2026-09-12).** Typed `enforcementFacts` gate every
> match and every activation; unnamed requests cross the provider allow
> list; `AuthorizedAcquireRequest.limits` carries the effective
> acquisition limits; adapters refuse limits they cannot enforce before
> allocating; every lease names its end and `checkLeaseGrant` refuses
> grants past the ceiling. Coverage: `test:runtime/acquisition`
> (21 cases), `conf:acquisition-policy`, adapter tests, the acceptance
> demonstration, and the CLI tests under `--policy-file`.

**Problem:** An omitted `providerId` bypasses the provider allowlist. Acquisition also fails to compare actual enforcement with network, location, host access, lifetime, and allocation limits.

**Primary files:** `src/core/policy.ts`, `src/core/matching.ts`, `src/runtime/acquisition.ts`, `src/runtime/lifecycle.ts`, `src/schema/adapter.ts`, `src/schema/capability.ts`, and the shipped adapters.

**Implementation steps**

1. Define a typed policy evaluation surface for offers and acquired manifests. Include execution location, network enforcement, host access, resource allocation, and lease limits. Keep adapter-specific descriptions separate from values used for authorization.
2. Filter discovery offers through the trusted policy before selection. Check the selected provider even when the request omits it. Treat locality preferences as preferences; check the actual execution location independently.
3. Pass effective acquisition limits through a dedicated, validated field in `AuthorizedAcquireRequest`. Construct it from `PolicyAuthority`. Request constraints and extensions must never widen it.
4. Require adapters to reject restrictions they cannot enforce before allocation. Constrain allocation where possible. Reject unknown enforcement evidence for a required restriction. For resources known only after allocation, verify actual values before activation and release an excessive allocation.
5. Validate the returned manifest against the selected provider, request, and effective policy. Persist lease expiration from a defined adapter contract. Apply the same checks during reconciliation and replacement acquisition.
6. Update schemas, fixtures, conformance policies, and examples. Existing local examples must explicitly allow the host access and network access they use. Define how older manifests are revalidated; missing evidence must not become an implicit grant.

**Acceptance checks**

- A policy with `providers: []` refuses acquisition with and without an explicit provider. The adapter allocation counter remains zero.
- A selected provider cannot change between discovery and activation without validation failure and a cleanup obligation.
- Denied locations remain denied when locality preferences are absent.
- A local process environment refuses `networkEgress: "none"` and denied host access.
- Enforced limits cover subprocesses, not only exposed tool operations.
- Lifetime and actual allocation stay within policy ceilings. Expired leases refuse new admission.
- Derived policy, recovery, and replacement cannot widen authority.

**Design constraint:** The runtime remains independent of adapter modules. Use common contracts and adapter declarations. Do not add provider-name switches to runtime policy code.

## R2: Claim operation dispatch once

> **Status: complete (2026-09-12).** `claimOperationDispatch` is the
> compare-and-set from `accepted` to `running`: the one transaction
> that moves the record owns the provider call, and every other
> caller adopts the record — settled answers from storage, running
> work through bounded waiting or `inspect`, unknown outcomes through
> reconciliation. The session exposes `claimDispatch`; the harness,
> the reconstruction steps, and the acceptance demonstration claim
> before they invoke. Admission now conflicts on the whole invocation
> identity, not only the input hash, and a repeated verification
> preparation returns the recorded staging. Coverage:
> `test:harness/agents-sdk` (concurrent callers, one invocation),
> `test:runtime/outcomes` (claim race across two store connections),
> `test:runtime/admission` (identity conflicts),
> `test:runtime/provenance` (idempotent preparation), the full
> replacement suite, and the acceptance demonstration.

**Problem:** Admission deduplicates records, but the harness still dispatches an existing running operation. Concurrent calls produce duplicate effects.

**Primary files:** `src/runtime/admission.ts`, `src/runtime/outcomes.ts`, `src/runtime/session.ts`, `src/store/control-store.ts`, `src/harness/agents-sdk.ts`, and `src/runtime/replacement.ts`.

**Implementation steps**

1. Add a regression with two callers, one request key, and an instrumented provider. Pause the first dispatch while the second caller reaches the same operation.
2. Add an atomic dispatch claim in the control store. Return both the operation and whether this caller acquired the claim. Only the caller that changes an accepted operation into a claimed operation may invoke the provider.
3. Expose the claim through the session interface. Update the harness and every internal dispatch path, including reconstruction. An idempotent state update must not serve as permission to execute again.
4. Return stored results for settled requests. Return or inspect existing running and unknown operations without redispatch. Preserve uncertain outcomes after a lost provider response. Resolve them through reconciliation.
5. Define crash behavior around the claim. A crash after claiming but before a response must not trigger an unsafe automatic retry. Handle verification preparation and cleanup so repeated calls do not create conflicting copies or leave permanent accepted operations.
6. Check request identity across attachment, generation, capability, operation, and input. Reject a reused key for different work. Document any change to stored request hashes and recovery of older records.

**Acceptance checks**

- Concurrent callers produce one provider invocation and one external effect.
- Separate processes sharing a control store obey the same rule.
- A completed retry returns the recorded result without invoking the provider.
- A running retry and a retry after a lost response produce no additional effect.
- Different operations or attachment targets cannot share a request key accidentally.
- Existing cancellation, revocation, and reconstruction tests continue to pass.

**Design constraint:** This establishes at-most-once runtime dispatch. It must not claim exactly-once provider effects across a crash.

## R3: Apply E2B network restrictions

> **Status: complete (2026-09-12).** The `allowInternetAccess` option
> crosses to `Sandbox.create` on every acquisition. Policy narrows and
> the operator configures: `none` forces a blocked sandbox even when
> the operator allows internet, and an `allowlist` policy refuses with
> `PolicyDenied` instead of approximating a boolean. The setting
> persists in the acquisition record — provider inspection cannot read
> it back — and manifests build from the recorded setting, so reopened
> defaults never relabel an allocation; pre-field records read as
> `internet-allowed`. The opt-in live smoke test probes outbound access
> from a subprocess in both configurations and skips (unverified) when
> credentials or the blocked-sandbox allocation are absent. Coverage:
> `test:adapters/e2b-adapter` (creation forwarding, policy narrowing,
> record-driven manifests, legacy honesty), `docs/adapters/e2b-linux.md`.

**Problem:** `allowInternetAccess: false` changes advertised enforcement but never reaches sandbox creation.

**Primary files:** `src/adapters/e2b-adapter.ts`, its tests, and `docs/adapters/e2b-linux.md`.

**Implementation steps**

1. Inspect the installed E2B package contract for the supported creation option. Add that option to `E2BClient` and forward it through `SdkE2BClient.create`.
2. Resolve the sandbox setting from operator configuration and effective policy. A permissive default must not override a restrictive policy. Refuse unsupported allowlist semantics.
3. Persist the allocation's network setting. Build its manifest from that recorded setting, not from a later adapter instance's defaults.
4. Reconcile older or uncertain allocations without claiming unverified enforcement. Define whether provider inspection can prove the setting or whether the environment must be replaced.
5. Update provider documentation and add an opt-in live smoke test with guaranteed cleanup.

**Acceptance checks**

- An injected client receives `false` for a blocked allocation and `true` only when authorized.
- A wrapper-level test proves the setting reaches the E2B package call.
- Reopening the adapter with different defaults cannot relabel an existing allocation.
- The live test checks outbound access from a subprocess in both configurations. Record it as unverified if credentials or allocation authorization are absent.

## R4: Enforce browser network restrictions

**Problem:** Only the initial navigation URL is checked. Redirects and page dependencies can contact forbidden origins.

**Primary files:** `src/adapters/browser-adapter.ts`, `src/acceptance/demonstration.ts`, browser tests, and browser conformance cases.

**Implementation steps**

1. Extend the driver contract to carry enforced network rules. Require enforcement before requests leave the driver. Cover navigation, redirects, dependencies, frames, and other supported network channels.
2. Make driver enforcement support explicit. Refuse a restrictive acquisition when a driver cannot enforce it. Checking a final URL after the request is insufficient.
3. Update `HttpBrowserDriver` to follow redirects manually with a finite limit. Validate every redirect destination and declared dependency before fetching it. Resolve relative dependency URLs against the final document URL.
4. Define private-address enforcement at connection time. Cover IPv4, IPv6, mapped addresses, DNS answers, and changes between resolution and connection. Use a controlled transport or refuse unsupported guarantees.
5. Return structured denials and keep browser session state consistent after blocked navigation. Update fake drivers to exercise the enforcement contract.

**Acceptance checks**

- An allowed origin redirecting to a forbidden origin produces zero requests at the forbidden server.
- Multi-hop and relative redirects cannot bypass the allowlist.
- Forbidden dependencies produce zero requests at their destination.
- Controlled DNS and transport tests reject private addresses and address changes.
- A driver without enforcement support cannot advertise restrictive networking.

**Design constraint:** The HTTP stand-in does not become a rendered browser. Real browser drivers must enforce requests inside their own engine or transport.

## R5: Release orphaned process groups

**Problem:** Release skips termination when the recorded parent has exited, even if descendants remain.

**Primary files:** `src/adapters/local-process-adapter.ts`, its tests, and process conformance cases.

**Implementation steps**

1. Reproduce a shell that starts a descendant and exits. Wait for confirmed parent exit before calling release.
2. Evaluate process-group liveness independently of parent liveness. Terminate groups that still contain owned processes.
3. Apply the normal termination grace period and escalation to orphaned groups. Wait for confirmation after escalation.
4. Aggregate termination results. Report unresolved cleanup if an owned group remains; do not mark the environment fully released.
5. Review persisted process identity against identifier reuse. Record and verify available operating-system identity evidence before signaling. State any platform limitation explicitly.

**Acceptance checks**

- Release stops descendants after their parent exits, including after reopening the adapter.
- Descendants that ignore graceful termination receive escalation.
- Repeated release is idempotent.
- Unconfirmed termination remains visible as cleanup work.
- Unrelated process groups remain untouched. Test identifier reuse through controlled process observations rather than signaling unrelated real processes.

## R6: Preserve remote executable bits

**Problem:** Upload and download transfer bytes but omit executable metadata. A round trip changes the tree hash.

**Primary files:** `src/adapters/e2b-adapter.ts`, its transfer interfaces and tests, and workspace conformance cases.

**Implementation steps**

1. Extend remote file metadata with the information needed to represent the portable executable bit. Add an explicit permission-setting operation to the client surface.
2. Set canonical file permissions after upload, independently of the remote creation mask. Preserve the specification's directory semantics.
3. Read executable metadata during download. Apply canonical local permissions before building the imported tree.
4. Preserve explicit distinctions between files, directories, links, and unsupported special entries. Refuse unsupported entries before following them.
5. Update the fake filesystem to model permissions and entry types. Do not let a byte-only fake stand in for complete workspace evidence.

**Acceptance checks**

- Executable and non-executable files preserve their bits and root hash through a round trip.
- Binary files, Unicode paths, empty directories, and restrictive creation masks work.
- An uploaded executable script runs directly in the authorized live smoke test.
- Unsupported links and special files fail explicitly.

## R7: Publish exact remote workspace trees

**Problem:** Upload retains obsolete remote entries but reports the local tree hash as the remote identity.

**Primary files:** `src/adapters/e2b-adapter.ts`, transfer interfaces and tests, and `docs/adapters/e2b-linux.md`.

**Implementation steps**

1. Define an exclusive workspace transfer boundary. Refuse or coordinate execution and concurrent uploads while publishing a new copy. Apply the same rule to all adapter instances that share the environment.
2. Upload into a unique staging directory inside the authorized remote workspace area. Verify bytes, executable metadata, and the full tree hash before publication.
3. Publish the staged tree using a recoverable swap supported by the provider transport. If atomic replacement is unavailable, persist a journal and block workspace use until recovery finishes.
4. Remove obsolete entries through complete-tree replacement. Support deletions and file/directory type changes. Leave paths outside the managed workspace untouched.
5. Persist `lastPush` only after publication succeeds. Base the report on verified remote state. Resolve interrupted and uncertain publication through inspection, not an assumed success.

**Acceptance checks**

- A second upload removes deleted files and directories. An empty revision produces an empty managed tree.
- File/directory changes succeed in both directions.
- Remote and reported hashes equal the requested revision hash, including executable bits.
- Injected failures during upload and publication preserve the previous copy or expose a recoverable incomplete state.
- Concurrent uploads cannot publish mixed trees. Running work cannot observe a partial publication.

**Design constraint:** Do not implement deletion as an unchecked recursive removal of a caller-supplied remote path. Keep all staging, backup, and publication paths under the fixed managed boundary.

## R8: Export entry type changes

**Problem:** Export compares path names without entry types. It retains a file where the next revision needs a directory.

**Primary files:** `src/runtime/export.ts`, its tests, and workspace conformance cases.

**Implementation steps**

1. Add regressions for file-to-directory and directory-to-file changes, including nested entries.
2. Compare both path and kind when calculating removals. Remove obsolete descendants and conflicting entries before creating the new type.
3. Correct directory removal order to process children before parents. Preserve reserved bridge paths and existing checks for local edits.
4. Keep the staged tree and recovery journal sufficient to repeat the apply after a failure. Verify the staged tree against the journal hash before recovery publishes it.
5. Write the new bridge state only after the destination matches the target revision. Preserve executable metadata throughout the change.

**Acceptance checks**

- Both type changes produce the requested tree and root hash.
- Nested changes remove obsolete directories fully.
- Local edits still cause a conflict before overwrite.
- Failures after removal and during creation recover to a complete, verified revision.
- Reserved bridge files survive. Corrupt staging content cannot be published under a valid revision hash.

## R9: Complete conformance and release evidence

**Primary files:** `src/conformance/cases/`, `src/acceptance/`, `docs/release-coverage.md`, adapter documentation, `docs/harness.md`, and `README.md`.

1. Add applicable regressions to public conformance packs. Test observable adapter behavior, including negative enforcement cases.
2. Update the acceptance demonstration's policies and driver contracts. Keep the local stand-in identity explicit in its records.
3. Run `npm run check` and focused tests during each repair. Run `npm test` once the combined changes are complete.
4. Run the documented local conformance workflows. Check expected skips and exit codes, then run the acceptance demonstration. Repeat the clean-checkout workflow using the lockfile through `npm ci`.
5. Run authorized live E2B smoke tests when credentials and allocation authorization are available. Ensure every allocated environment has cleanup in a finalization path. Record unavailable live evidence explicitly.
6. Update the release coverage map with exact regression names and results. Correct claims that rely only on injected clients. Document adapter contract changes and any control-store migration.
7. Review the final diff for unrelated changes and unresolved cleanup. Mark a repair complete only when its acceptance checks pass.

## Completion criteria

- All eight original reproductions pass as regression tests.
- Policy checks occur before avoidable external effects and before attachment activation.
- Runtime retries do not dispatch duplicate effects.
- Resource release reports actual cleanup results.
- Local and remote workspace operations preserve exact portable trees.
- Existing tests, conformance cases, and acceptance workflows have no unexplained regression.
- Documentation distinguishes tested local behavior, injected-client evidence, and verified live provider behavior.

The existing `to-do.json` is a top-level array, while its schema requires an object containing task metadata. This plan leaves that separate format issue unchanged. Backlog import must preserve existing task identifiers and completed history if it is done later.
