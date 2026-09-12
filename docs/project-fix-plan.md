# Project fix plan

Status: complete, including the four follow-up review repairs below.
See the [follow-up completion record](#follow-up-completion-record) for current commits and results.

Source: [Project review](project-review.md), findings 1–7.
Review baseline: `8380d5350cedc442ce435c7b6cc8f55ce5001c30`.
Recorded validation at the baseline: 477 tests pass, zero fail, and one live E2B test skips.
These counts describe the review baseline, not future repair results.

This plan is separate from the completed [R1–R9 repair plan](review-fix-plan.md).
Use F1–F8 below to identify the new work.

## Order and dependencies

| Order | Task | Priority | Dependency | Status |
| --- | --- | --- | --- | --- |
| 1 | F1: Hide resolved secret values | High | None | Done, `4ed62c0` |
| 2 | F2: Prevent destination link traversal | High | None | Done, `5725181` |
| 3 | F3: Make verification preparation recoverable | Medium | F2 for file safety | Done, `3f01913` and `8db4078` |
| 4 | F4: Reject invalid approval expiry | Medium | None | Done, `5901599` |
| 5 | F5: Reject invalid command grammar | Medium | None | Done, `74df319` |
| 6 | F6: Honor policy configuration from the environment | Medium | F5 for parser changes | Done, `67fe53c` and `420ba48` |
| 7 | F7: Repair and execute the README example | Medium | F1–F6 for integrated validation | Done, `4fe32d1` |
| 8 | F8: Verify the repaired project and update evidence | Completion gate | F1–F7 | Done, this commit |

Implement one task at a time. Keep each behavior repair and its regression tests in one commit.
Start each repair with a failing test that reproduces its finding.
Use temporary directories and synthetic secret values. Use explicit barriers for concurrency tests.
Preserve unrelated local changes, including `.claude/ralph-loop.local.md`.

## F1: Hide resolved secret values

**Files:** `src/core/secrets.ts`, `src/core/secrets.test.ts`.

**Implementation**

1. Replace `private secretValue` with an ECMAScript private field.
2. Add `toJSON()` that returns only `{ reference }`.
3. Preserve `use()` as the explicit method for consuming the value.
4. Check the surrounding resolver fields for the same accidental exposure through enumeration or inspection.

**Acceptance checks**

- JSON serialization, object spread, `Object.keys`, and ordinary `util.inspect` output contain no synthetic secret value.
- Nested serialization also exposes only the reference.
- `use()` still passes the original value to its callback.
- Existing authorization, redaction, and revoked-reference tests pass.

**Boundary:** This protects accidental exposure. It does not isolate the value from authorized callback code.

## F2: Prevent destination link traversal

**Files:** `src/store/workspace-tree.ts`, `src/store/workspace-tree.test.ts`, and affected materialization callers and tests.

**Implementation**

1. Define the destination contract, including supported platforms and ownership of the destination parent directory.
2. Validate the destination, existing ancestors, and manifest paths before writing. Use `lstat` to detect symbolic links.
3. Reject directory links and dangling file links. Open new files exclusively and apply permissions through the opened descriptor.
4. Check callback and write ordering. A `readBlob` callback must not invalidate checks and redirect a later write.
5. Use private staging and controlled publication where callers cannot guarantee exclusive access to the destination.
6. Preserve path names, executable bits, collision errors, and read-only behavior. Remove only staging owned by this operation.

**Acceptance checks**

- Directory links and dangling file links fail with structured errors. Outside files and permissions remain unchanged.
- Test a linked destination root and a linked ancestor according to the documented contract.
- Inject a path replacement during blob retrieval. The writer must refuse or remain confined to its owned destination.
- Existing content is not overwritten, and failures do not remove caller-owned files.
- Ordinary materialization, export, bundle, and verification tests still pass.

**Design constraint:** Separate path checks do not prevent every concurrent rename attack.
Do not claim protection against hostile concurrent writers from `lstat` alone.
Use descriptor-relative operations where available, or require a trusted parent and exclusive destination ownership.
Document any stricter destination requirement at the public API and its callers.

## F3: Make verification preparation recoverable

**Files:** `src/harness/agents-sdk.ts`, `src/harness/agents-sdk.test.ts`, `src/runtime/provenance.ts`, and related store methods if needed.

**Implementation**

1. Replace instance counters as directory identifiers with operation-owned records and unique directory allocation.
2. Look up existing verification preparation before synchronizing the bridge or creating copies for a retry.
3. Serialize preparation for the same operation. Persist the winning preparation so separate processes can adopt it.
4. Derive `cwd` from the recorded verification copy, not a newly calculated directory name.
5. Retain the existing dispatch claim. A retry must not execute a completed, running, or unknown operation again.
6. Define cleanup and recovery for failed staging. Remove only uncommitted copies owned by the failed attempt.

**Acceptance checks**

- A new toolkit instance can verify a new request using the same session and runs directory.
- Different requests from concurrent toolkit instances use distinct directories.
- Concurrent preparation of one request records one authoritative preparation and causes at most one provider invocation.
- A completed retry returns its recorded result and tested revision after the bridge changes.
- A retry after preparation uses the recorded directory. A preparation failure leaves recoverable state.
- Existing provenance and dispatch deduplication tests pass.

**Compatibility:** Preserve existing working-copy records and their paths. Avoid a migration unless new durable state requires one.

## F4: Reject invalid approval expiry

**Files:** `src/harness/agents-sdk.ts`, `src/harness/agents-sdk.test.ts`, `src/core/time.ts` if a shared helper needs adjustment.

**Implementation**

1. Check the runtime type of any supplied `expiresAt` value.
2. Validate it with the existing `isUtcTimestamp` contract before comparing its time.
3. Return `InvalidRequest` for malformed timestamps and `PolicyDenied` for expired approvals.
4. Preserve omitted expiry and valid future expiry behavior. Document the accepted timestamp format.

**Acceptance checks**

- Reject an invalid string, an impossible calendar date, an empty value, and a non-string value.
- Reject an expiry equal to or earlier than the current time.
- Accept a valid future timestamp and preserve authority narrowing.
- Rejected approvals never reach invocation admission or provider dispatch.

Use a controlled clock or fixed comparison boundary rather than timing-sensitive sleeps.

## F5: Reject invalid command grammar

**Files:** `src/cli/args.ts`, `src/cli/cli.ts`, `src/cli/cli.test.ts`, `src/cli/main.e2e.test.ts`.

**Implementation**

1. Require the matched command to consume every command word.
2. Define accepted boolean options per command. Keep `--json` global and `--plan` specific to `replace`.
3. Restrict effect and payment options to the conformance command.
4. Complete grammar validation before opening a store or loading an adapter.

**Acceptance checks**

- `session create accidental-extra-word` exits two and creates no database or session.
- Extra words on single-word and multiword commands are rejected.
- Misplaced boolean options exit two without side effects.
- Valid commands, help, version, and documented boolean combinations retain their behavior.

## F6: Honor policy configuration from the environment

**Files:** `src/cli/args.ts`, `src/cli/cli.ts`, `src/cli/config.ts`, and command configuration tests.

**Implementation**

1. Separate required request options from required resolved configuration.
2. Resolve configuration after grammar validation and before checking required configuration values.
3. Preserve explicit flag precedence over environment variables.
4. Validate required policy input before opening a store or performing an adapter action.
5. Preserve commands that need neither a policy nor a session. Update help text if validation rules change.

**Acceptance checks**

- `attach`, `invoke`, and `materialize` accept a valid `PORTABLE_POLICY` without `--policy-file`.
- A supplied policy flag takes precedence. An invalid explicit file does not silently fall back to the environment.
- Missing or empty policy configuration produces a clear error and exit code two.
- Existing `PORTABLE_STORE` and `PORTABLE_SESSION` behavior remains correct.
- Tests restore environment variables and remain isolated from each other.

## F7: Repair and execute the README example

**Files:** `README.md`, an executable example, and its smoke test under `src/acceptance` or the existing example tests.

**Implementation**

1. Add the local adapter's required location, network, host access, lifetime, and resource grants. Explain the grants briefly.
2. Use `claimDispatch`. Invoke the provider only when the caller wins the claim.
3. Handle completed, failed, and uncertain provider outcomes without recording false success.
4. Release the attachment and close every store connection on success and failure.
5. Execute the exact documented code through extraction or a shared example source. Avoid a separately maintained test copy.

**Acceptance checks**

- The example completes attachment, invocation, checkpoint, release, and reopen in temporary directories.
- A denied policy refuses execution. A failed provider response does not become a completed operation.
- Repeated dispatch attempts cause at most one provider call.
- The smoke test requires no provider credentials and leaves no child processes or open stores.

## F8: Verify the repaired project and update evidence

1. Run each task's focused tests after its repair. Record the regression that changes from failing to passing.
2. Run `npm test` on the final tree. Investigate every new failure or skip.
3. Verify a clean checkout with `npm ci` followed by `npm test`.
4. Record local conformance and acceptance results from the repaired tree. Keep live provider evidence explicitly separate.
5. Update `project-review.md` and this plan with commit identifiers, test results, and any remaining limitations.
6. Run `git diff --check` and verify that no unrelated files or local runtime artifacts enter repair commits.

**Done means:** Every F1–F7 acceptance check passes, all seven review findings have evidence of repair, and F8 records the results.
A skipped live provider test remains unverified. Passing local tests must not relabel it as verified.

## Initial completion record

Date: 2026-09-12. All work ran on Node.js `v24.18.0` under Linux.

Each repair started with a failing test and landed with its regression
in one commit. Test counts are total tests in the full suite.

| Task | Commit | New tests | Regression that turned from failing to passing |
| --- | --- | --- | --- |
| F1 | `4ed62c0` | 2 | Serialization, enumeration, and inspection of resolved secrets and the resolver expose no value. |
| F2 | `5725181` | 3 | Linked destination roots, ancestors, and entries refuse; a path replaced during blob retrieval never redirects the write; an exclusive create refuses a raced target. |
| F3 | `3f01913` | 5 | Restart in the same runs directory, concurrent same-request preparation, completed retry, crash adoption, and refused-preparation recovery. |
| F3 | `8db4078` | 1 | Concurrent different requests both complete in distinct copies under distinct directories. |
| F4 | `5901599` | 1 | Malformed expiry values grant nothing and reach no admission; the equal-time boundary is expired. |
| F5 | `74df319` | 3 | Extra command words exit 2 creating no database (in process and as a spawned binary); misplaced booleans exit 2. |
| F6 | `67fe53c` | 3 | `PORTABLE_POLICY` admits attach, invoke, and materialize; an explicit flag wins; missing and empty policy exits 2. |
| F6 | `420ba48` | 0 | Test hygiene: the policy tests restore every environment variable they set. |
| F7 | `4fe32d1` | 4 | The exact README block runs green in a temporary directory; a denied policy refuses; a failed answer settles failed; repeated dispatches reach the provider once. |

Final validation of the repaired tree at `420ba48`:

- `npm test` on the working tree: 500 tests, 499 pass, 0 fail, 1 skip.
- A clean checkout of `HEAD` (`git worktree`), then `npm ci` and
  `npm test`: 500 tests, 499 pass, 0 fail, 1 skip. `npm ci` reported
  zero vulnerabilities.
- An adversarial re-verification ran one independent agent per finding
  against the plan's acceptance checks. Five findings passed outright.
  The two failures drove the amendments above: F3 lacked evidence that
  concurrent different requests use distinct directories, and F6's new
  tests leaked two environment variables. Both re-verified after the
  amendments.
- `git diff --check` is clean, and no repair commit carries unrelated
  files. `.claude/ralph-loop.local.md` stays modified and uncommitted.

Limitations, stated plainly:

- The one skipped test is the live E2B lifecycle test. No live provider
  behavior is established by this plan, and local passes do not verify it.
- F2 relies on `lstat` chain checks and exclusive creation. Node has no
  descriptor-relative directory operations, so the destination contract
  requires a trusted parent that the caller owns exclusively. The public
  callers document that requirement.
- F3 chains bridge synchronizations inside one process. Separate
  processes that share one bridge can still race their checkpoints; the
  store's expected-head comparison refuses the loser, as designed.
- F4 checks expiry when authority is derived. The derived authority
  carries no expiry of its own; the harness re-derives from a fresh
  approval on every run.

## Follow-up completion record

The review of `b5c2e54` found four remaining gaps. All four are now repaired.
The initial completion record above describes the earlier tree and its evidence.

| Task | Commit | Added regression coverage |
| --- | --- | --- |
| F2 | `512b791` | An existing directory behind an implicit linked ancestor cannot change outside permissions. A blob callback cannot redirect the destination through a replaced ancestor. |
| F3 | `fe765a6` | Failed preparation preserves published input copies. A lost preparation response preserves and adopts the published verification copy. |
| F6 | `1452261` | Missing, malformed, and schema-invalid policy files refuse before store creation or adapter loading for attach, invoke, and materialize. |
| F7 | `6557b65` | The extracted README example releases attachments and closes stores after attachment, checkpoint, release, and reopen failures. |

Verification at `6557b65`, on Node.js `v24.18.0` under Linux:

- Focused suites: 58 tests pass, zero fail, zero skip.
- Full working-tree suite: 506 tests, 505 pass, zero fail, one skip.
- Detached clean checkout: `npm ci` and `npm test` succeed with the same full-suite counts.
- The skipped test requires live E2B credentials. No live provider result is claimed.
- `git diff --check` passes. The existing local agent state change remains uncommitted.

F3 deliberately retains an attempt directory when a working-copy record references it.
This includes input copies published before failed verification preparation.
Only attempts without published copies are removed immediately.
Unused published copies remain available for later retention work; this repair does not delete their durable records.
F2 still requires exclusive ownership of the destination parent against hostile concurrent filesystem writers.

## Follow-up improvements

Schedule these after the seven defects are repaired. They do not block this repair plan.

| Work | Concrete completion criterion |
| --- | --- |
| Continuous integration | GitHub runs clean installs and tests across the supported Node.js matrix; the tested minimum matches `engines`. |
| Package checks | Install a built package in a temporary consumer and exercise imports, types, and the executable. |
| Conformance cancellation | A timed-out case cannot overlap later cases or leave unreported resources after cleanup. |
| Storage durability | Document process-crash versus host-crash guarantees and test the required write ordering and recovery. |
| Local state hygiene | Ignore documented runtime state paths and remove tracked local agent state while preserving the local file. |
| Retention | Remove only unreachable copies, blobs, and records; retained revisions and recovery operations remain usable. |
| Module size | Extract transfer and phase logic after repairs, with existing transaction and recovery tests passing. |
