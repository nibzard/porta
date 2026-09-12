# E2B remote Linux adapter

The `e2b-linux` adapter owns the machine lifecycle of one remote Linux
environment per acquisition (SPEC.md sections 8 and 22): discovery,
acquisition, reconciliation, renewal, and release. The provider is E2B;
the selection record and its sources are in
`docs/providers/selection.md`.

| Field | Value |
| --- | --- |
| Provider | E2B (`@e2b/sdk` 2.5.0) |
| Isolation | One Firecracker microVM per sandbox |
| Platform | linux, x86_64 |
| Template | `base` by default, configurable |
| Capability operations | `exec.process@1`: run, start, inspect, terminate |
| Working copies | Push and pull under `/home/user/portable` |

## Enforcement facts and limits

Every offer and manifest carries the typed enforcement facts of
SPEC.md section 7. Authorization reads these values, never the
adapter-specific descriptions:

| Fact | Value | Why |
| --- | --- | --- |
| `executionLocation` | `remote` | Sandboxes run in the provider cloud. |
| `networkEgress` | `unrestricted` | Until sandbox creation carries the network option through (R3), every sandbox reaches the internet; the honest fact is the wide one. |
| `hostFilesystemAccess` | `false` | A Firecracker microVM sees its own filesystem, never the host's. |

The acquire call reads the effective limits and refuses before any
spend exists when it cannot enforce them: a policy that allows no
`remote` execution, any egress mode below `unrestricted`, or a
lifetime ceiling of zero. The lease span it grants never exceeds the
lifetime ceiling.

## Durable identity

Every acquisition follows a write-ahead protocol over
`<stateDir>/acquisitions/<acquisitionId>.json`:

1. The intent record — acquisition identity, environment identity,
   provider metadata tags — is written before any provider call.
2. The sandbox is created with both identities in its provider
   metadata.
3. The provider sandbox identifier is confirmed back into the record.

A response lost at any step recovers by identity. A record with no
sandbox identifier re-attaches through a provider listing filtered by
the metadata tag, so a repeated `acquire` returns the existing
environment instead of creating a second one. When no sandbox carries
the tag, the create never landed or its sandbox already ended, and the
adapter may create under the same identity without duplicating a live
sandbox.

If a race ever creates two sandboxes under one tag, the adapter adopts
the newest and leaves the other visible in the provider listing and in
`allocations()`.

## Reconciliation

`reconcile` answers from provider truth, read by sandbox identifier:

| Provider answer | Record state | Answer |
| --- | --- | --- |
| Running or paused | held | `allocated` — a paused sandbox still holds the allocation |
| Not found | held | `released` — the provider confirms it no longer exists, whichever side ended it |
| Not found | released | `released` |
| Found | released, unconfirmed | `allocated` with `CleanupPending` — resources still stand |
| Request fails | any | `unknown` — uncertainty is never release |
| No record, or unconfirmed intent with no match | — | `unknown` |

A repeated `acquire` over an identity whose sandbox ended refuses with
`StaleHandle`: the runtime decides on a replacement generation, never
the adapter silently.

## Renewal

Renewal sets the provider timeout to cover the requested time. The
provider caps one timeout at twenty-four hours; accounts on the Hobby
tier cap at one hour. The adapter clamps every renewal to
`maxTimeoutMs` (one hour by default; raise it toward the provider cap
on Pro) and returns the effective time — never a pretend extension.

## Release

Release kills the sandbox; kill discards state. The call is
idempotent. A kill the provider does not confirm stays in the record
as an unconfirmed release: `release` answers `failed` with
`retryable: true`, `reconcile` keeps answering `allocated` with
`CleanupPending`, and `allocations()` keeps showing the record. The
obligation survives process restart, because it lives in the record
file.

## Manifest truth

The manifest carries what the provider reported after the sandbox
existed — CPU count and memory from `getInfo`, the sandbox identifier,
the template, and the envd version — not a guess from configuration.
Before creation, resource minima cannot be proven, so a request with
resource requirements rejects at acquisition unless the template's
quantities are configured truth.

## Credentials

The API key resolves at use time from the adapter options or
`E2B_API_KEY`. It never enters a record, manifest, event, or error
detail. Without a key, acquisition refuses with `ProviderUnavailable`
and nothing is spent or recorded.

The paid smoke test in `src/adapters/e2b-adapter.test.ts` runs only
when `E2B_API_KEY` is set; without it, it skips. The offline tests run
against an injected fake client and cover every acceptance criterion
without spending provider credits.

## Processes

Inside a held lease the adapter serves `exec.process@1`. The envd
command transport takes one shell-parsed string, so the adapter quotes
every argument itself: an argument array stays an argument array, with
no re-splitting, no interpolation, and no globbing. A NUL byte in an
argument refuses the launch.

The declared profile is the transport's honest limit, and matching
fails against any requirement that exceeds it:

| Attribute | Declared | Why |
| --- | --- | --- |
| `signals` | `SIGKILL` only | The provider kill call sends SIGKILL and nothing else |
| `descendantTermination` | `none` | The kill reaches one process, never a group |
| `binaryOutput` | `false` | Output crosses as UTF-8 text; non-UTF-8 stdin refuses |
| `processLifetime` | `attachment` | Processes die with the sandbox when its timeout ends |

Semantics worth knowing:

- A non-zero exit is a completed result, not a fault. A timeout or a
  provider kill reports `signal: "SIGKILL"` with `timedOut` and no
  invented exit code.
- Foreground runs default to a one-hour timeout. The provider default
  of sixty seconds would kill honest work silently; every request may
  tighten the bound through `timeoutMs`.
- Standard input crosses as UTF-8 text only. A run that reads stdin to
  end-of-file must end on its own terms — the transport keeps the pipe
  open until the process exits or the timeout ends it.
- Started processes live in durable records under
  `<stateDir>/processes/`. A restarted adapter still inspects and
  terminates them from the record plus the provider process table.
- Liveness is provider truth: `inspect` reads the process table, and a
  provider that cannot answer yields `unknown`, never a guess. An
  unobserved end reports state `exited` without an exit code.
- Cancellation and `terminate` state `descendantsStopped: false`
  because the transport kills exactly one process.

## Working copies

One portable root, `/home/user/portable`, bounds every transferred
byte in each sandbox.

A push validates three things before the first byte leaves, in order,
so a refused push spends nothing (SPEC.md section 11.6):

1. **Policy.** The authority must allow `remote` as a transfer
   destination.
2. **Hashes.** The staged directory must hash to the tree the caller
   presented; a copy that changed after authorization refuses with
   `IntegrityFailure` instead of crossing as trusted content.
3. **Limits.** File count, per-file bytes, and total bytes must sit
   under the authorized ceilings.

The last push is recorded in the acquisition record as provenance.

A pull walks the remote tree, reads every byte, and rebuilds the
staging root through the content-addressed store — the tree is built
from bytes that crossed, never from provider claims. A stated
`expectedRootHash` refuses a mismatch with `IntegrityFailure`. The
destination policy must allow `local`. A pull replaces the staging
root it was given and nothing else: the change returns to the
workspace as a proposal with provenance, and the source of the base
revision is never overwritten.

The executable bit does not transfer; the remote filesystem API
writes plain files. A tree entry keeps the bit for the workspace, but
remote content lands non-executable.

## Unsupported requirements

- **Signals other than SIGKILL, binary output, confirmed descendant
  termination.** The envd transport does not carry them; the declared
  profile says so and matching rejects requirements that need them.
- **Pause and resume as operations.** The adapter treats a paused
  sandbox as a held allocation and never exposes pause or resume as
  lease operations; renewal through the provider timeout is the only
  lifetime extension.
- **State beyond timeout.** The provider kills a sandbox when its
  timeout expires, and kill discards state. Persistence of a paused
  sandbox is a provider beta the adapter does not rely on.
- **Survival of adapter restart for in-flight state.** Durable
  identity covers acquisition records and started-process records.
  Nothing else about a sandbox is cached across restarts; every answer
  re-reads the provider.
- **Graphics processors and non-Linux platforms.** Not offered; the
  offer and the manifest say linux, x86_64.
