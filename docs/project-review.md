# Project review

Date: 2026-09-12. Baseline: `8380d5350cedc442ce435c7b6cc8f55ce5001c30`.
Status: repaired. All seven findings have evidence of repair; see the
[repair record](#repair-record).

The project has clear module boundaries, strict TypeScript settings, and substantial tests for failures and recovery.
Seven focused reproductions expose gaps outside the passing suite. Fix secret serialization first.
The proposals below do not change application behavior.

## Scope and evidence

The review covers repository setup, public exports, schemas, policy, storage, runtime flows, adapters, harness integration, command parsing, and test infrastructure.
It includes the README, specification structure, and the previous repair plan.
Source inspection concentrates on trust boundaries, file writes, dispatch, replacement, and recovery.
This is not a line-by-line proof of every implementation path.

`npm test` builds successfully on Node.js `v24.18.0`: 477 tests pass, zero fail, and one skips.
The skipped test is the live E2B lifecycle test. No live provider behavior is established by this review.
Focused reproductions use temporary directories, local execution, and synthetic secret values.

## Confirmed findings

### 1. High: Resolved secrets expose their values during serialization

Location: [`src/core/secrets.ts`](../src/core/secrets.ts), lines 36–55.

`ResolvedSecret.secretValue` uses TypeScript `private`, which does not hide the property at runtime.
The class also has no `toJSON` method. Logging, spreading, or serializing a resolved secret can expose its value.
This contradicts the comment that the value stays outside enumerable state.

Reproduction:

```js
JSON.stringify(new ResolvedSecret("secret://demo", "SYNTHETIC_REVIEW_VALUE"))
// {"reference":"secret://demo","secretValue":"SYNTHETIC_REVIEW_VALUE"}
```

`Object.keys` also returns both `reference` and `secretValue`.

Proposed fix: Use an ECMAScript private field, such as `#secretValue`.
Define `toJSON` to return the reference only.
Test JSON serialization, object spread, enumeration, and ordinary inspection.
Keep value access inside the existing `use` callback.

### 2. High: The public tree writer follows destination symlinks

Location: [`src/store/workspace-tree.ts`](../src/store/workspace-tree.ts), lines 401–438.

`materializeEntry` uses `statSync`, which follows symlinks, and creates parent directories recursively.
A destination directory entry can therefore redirect writes outside the requested destination.
A dangling file symlink also bypasses an `existsSync` check.

Reproduction: Create `dest/link` as a symlink to another temporary directory.
Materialize entries for directory `link` and file `link/file.txt` through the exported `materializeTree` function.
The file appears in the other directory.

Scope: `materializeRevision` rejects occupied destinations, which blocks this specific populated-directory example through that wrapper.
The exported lower-level function remains affected. Concurrent destination changes need separate tests.

Proposed fix: Reject symlinks in the destination and its path components with `lstat` checks.
Create files exclusively and reject link traversal during creation where the platform permits it.
For untrusted destinations, use a private staging directory and a controlled publication step.
Test directory links, dangling file links, and destination changes during writes.

### 3. Medium: Verification directories collide after a toolkit restart

Location: [`src/harness/agents-sdk.ts`](../src/harness/agents-sdk.ts), lines 457–481.

Each toolkit starts its counter at zero and creates `copy-1` and `verify-1` under the shared runs directory.
The directories persist after a successful run.
A new toolkit instance for the same session therefore reuses an occupied directory.

Reproduction: Complete one verified run, then create a new toolkit with the same options and submit a new request key.
The first run completes. The second refuses with `The materialization destination .../runs/copy-1 is not empty.`

Proposed fix: Persist directory ownership by operation identifier, or allocate unique directories with `mkdtemp`.
Check recorded verification preparation before creating new copies.
Derive the execution directory from the recorded verification copy when adopting an existing operation.
Test restart, concurrent toolkit instances, and retries of the same verification request.

### 4. Medium: Malformed approval expiry grants authority

Location: [`src/harness/agents-sdk.ts`](../src/harness/agents-sdk.ts), lines 179–192.

The expiry check rejects a past date only when `Date.parse` returns a finite number.
An invalid date bypasses the check and still creates an authority.

Reproduction: Pass `expiresAt: "invalid"` with a valid approver and a process grant.
The returned authority permits `exec.process@1/run`.

Proposed fix: Validate an explicitly supplied timestamp and reject malformed values before deriving authority.
Use the existing timestamp validation contract. Test malformed, expired, and future values.

### 5. Medium: Extra command words silently execute the matched prefix

Location: [`src/cli/args.ts`](../src/cli/args.ts), `matchCommand` and `parseArguments`.

The parser accepts the longest known prefix and discards remaining command words.
An invalid command can therefore perform a mutation successfully.

Reproduction: Run `session create accidental-extra-word --store <temporary-db> --policy-ref policy://review`.
The command exits zero and creates a session.

Proposed fix: Require the matched command to consume every command word.
Reject unknown words before opening the store. Test that invalid commands create no database or session.
Also validate boolean options against the selected command.

### 6. Medium: Required policy flags ignore the documented environment variable

Location: [`src/cli/cli.ts`](../src/cli/cli.ts), lines 59–63.

Required-option validation runs before configuration resolution.
Commands that require `--policy-file` reject a valid `PORTABLE_POLICY` setting.
The help text explicitly documents the variable as an alternative.

Reproduction: Set `PORTABLE_POLICY` to a valid policy file and invoke `materialize` without `--policy-file`.
The command exits two with `Missing required option --policy-file for materialize.`

Proposed fix: Resolve configuration before checking required configuration values.
Keep request arguments separate from configuration requirements.
Test environment-only policy configuration for `attach`, `invoke`, and `materialize`, plus explicit flag precedence.

### 7. Medium: The README library example fails during attachment

Location: [`README.md`](../README.md), lines 56–70.

The example grants only a provider and an operation.
Policy defaults deny the local execution location, host access, network access, and environment lifetime needed by the local adapter.

Reproduction: Run the example's policy construction and attachment call.
Attachment throws `PolicyDenied: Execution location local is not allowed.`

Proposed fix: Supply the complete local policy required by the adapter and explain those grants.
Update the dispatch example to use `claimDispatch` and invoke only when the claim succeeds.
Handle the provider result status before settlement.
Turn the exact README example into an executable smoke test to prevent further drift.

## Further improvements

These are follow-up proposals, not additional reproduced defects.

- Add continuous integration on GitHub. Run `npm ci` and `npm test` on the supported Node.js versions.
  Establish the exact minimum Node.js version, including its `node:sqlite` support, through that matrix.
  Keep credential-dependent provider tests explicit and separate.
- Strengthen conformance timeouts. `runner.ts` races the case against a timer but does not cancel the case.
  A timed-out case can continue while later cases run. Add cancellation and cleanup contracts or process isolation.
- Define the storage crash model. Blob and adapter records use write-and-rename without explicit file or directory synchronization.
  If guarantees cover host power loss, synchronize data before committing references and test recovery through injected failures.
- Add package installation tests. Build a package, install it into a temporary project, and exercise the exported library and executable.
  Define an explicit package file list before distribution so fixtures, tests, and local agent state are not shipped accidentally.
- Ignore local runtime databases, credentials, supervisor records, and agent loop state where their paths are predictable.
  The repository currently tracks `.claude/ralph-loop.local.md`. Removing it from tracking should preserve the local file.
- Split large modules after the behavior fixes. `replacement.ts` and `e2b-adapter.ts` each exceed 2,200 lines.
  Extract phase guards, transfer code, and provider record handling while retaining transaction boundaries.
- Add storage retention and cleanup policies for verification copies, unreferenced blobs, and old provider records.
  Tie cleanup to durable references so retained revisions remain usable.

## Suggested repair order

1. Protect secret values and destination paths.
2. Fix verification directory ownership and approval timestamp validation.
3. Fix command parsing and configuration resolution.
4. Repair the README and run its exact example in tests.
5. Add continuous integration and package installation checks.
6. Define cancellation, storage durability, and retention contracts before larger refactors.

Keep each behavior repair and its regression tests in a separate commit.
The earlier R1–R9 repair plan remains historical evidence; this review records newly observed gaps.

## Repair record

The [project fix plan](project-fix-plan.md) repaired findings 1–7 on
2026-09-12. Each repair started with a failing test and landed with its
regression in one commit.

| Finding | Commit | Regression that turned from failing to passing |
| --- | --- | --- |
| 1 | `4ed62c0` | Serialization, enumeration, spread, and inspection of a resolved secret expose only its reference. |
| 2 | `5725181` | Linked destination roots, ancestors, and entries refuse; a path replaced during blob retrieval never redirects the write; an exclusive create refuses a raced target. |
| 3 | `3f01913`, `8db4078` | Restart, concurrent same-request and different-request preparation, completed retry, crash adoption, and refused-preparation recovery. |
| 4 | `5901599` | Malformed and non-string expiry values grant nothing and reach no admission; the equal-time boundary is expired. |
| 5 | `74df319` | Extra command words exit two creating no database, in process and as a spawned binary; misplaced booleans exit two. |
| 6 | `67fe53c`, `420ba48` | `PORTABLE_POLICY` admits attach, invoke, and materialize; an explicit flag wins; missing and empty policy exits two. The amendment restores every environment variable the policy tests set. |
| 7 | `4fe32d1` | The exact README block runs green in a temporary directory; a denied policy refuses; a failed answer settles failed; repeated dispatches reach the provider once. |

Validation of the repaired tree:

- `npm test` on the working tree: 500 tests, 499 pass, 0 fail, 1 skip.
- A clean checkout of the repaired head, then `npm ci` and `npm test`:
  the same counts, and `npm ci` reported zero vulnerabilities.
- One independent agent re-verified each finding against its acceptance
  checks. Five passed outright; findings 3 and 6 each failed one check and
  drove the amendment commits above. Both re-verified after repair.

The skipped test stays the live E2B lifecycle test. Local passes do not
verify any live provider behavior.
