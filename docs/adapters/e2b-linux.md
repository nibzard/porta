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
| Working copies | Exact-tree publication under `/home/user/portable` |

## Enforcement facts and limits

Every offer and manifest carries the typed enforcement facts of
SPEC.md section 7. Authorization reads these values, never the
adapter-specific descriptions:

| Fact | Value | Why |
| --- | --- | --- |
| `executionLocation` | `remote` | Sandboxes run in the provider cloud. |
| `networkEgress` | `unrestricted` or `none` | Per acquisition: the recorded setting (see below). |
| `hostFilesystemAccess` | `false` | A Firecracker microVM sees its own filesystem, never the host's. |

The acquire call reads the effective limits and refuses before any
spend exists when it cannot enforce them: a policy that allows no
`remote` execution, an egress `allowlist` (see below), or a lifetime
ceiling of zero. The lease span it grants never exceeds the lifetime
ceiling.

## Network setting

The provider exposes one network control at creation: the SDK's
`allowInternetAccess` boolean. The whole sandbox reaches the internet,
or nothing does — there is no origin allowlist. The setting resolves
before any spend exists:

| Effective policy | Operator default `allowInternetAccess` | Sandbox setting |
| --- | --- | --- |
| `unrestricted` | `true` or `false` | Follows the operator default |
| `none` | `true` or `false` | `blocked` — policy narrows, never widens |
| `allowlist` | either | Refused with `PolicyDenied` |

The setting crosses to `Sandbox.create` at creation only. Provider
inspection cannot read it back, so the acquisition record's `network`
field is the only evidence of what was enforced. Consequences:

- The manifest is built from the recorded setting, never from the
  current adapter configuration. Reopening the adapter with a
  different `allowInternetAccess` default cannot relabel an existing
  allocation.
- Records written before the field existed were created with the
  provider default — internet allowed — and read as
  `internet-allowed`. No later adapter default relabels them.
- A blocked sandbox is the enforcement, not a promise: the typed fact
  reports `networkEgress: "none"` because the sandbox was created that
  way, and `example.com` stays unreachable from its subprocesses.

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
The one exception is the network setting: the provider cannot report
it, so the manifest reads it from the acquisition record (see
"Network setting"). Before creation, resource minima cannot be
proven, so a request with resource requirements rejects at acquisition
unless the template's quantities are configured truth.

## Credentials

The API key resolves at use time from the adapter options or
`E2B_API_KEY`. It never enters a record, manifest, event, or error
detail. Without a key, acquisition refuses with `ProviderUnavailable`
and nothing is spent or recorded.

The paid smoke test in `src/adapters/e2b-adapter.test.ts` runs only
when `E2B_API_KEY` is set; without it, it skips. It checks outbound
access from a subprocess in both configurations — the internet-allowed
sandbox connects, the blocked one does not — and releases every
sandbox it allocates. An account that refuses the blocked-sandbox
allocation marks that check skipped, which is unverified, never
passed. The offline tests run against an injected fake client and
cover every acceptance criterion without spending provider credits.

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
byte in each sandbox. The adapter also owns the reserved control
family beside it, `/home/user/portable__*`: the staging directory, the
backup, and the publication journal. Nothing else may live there.

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

### Publication

A push never writes into the published tree. It uploads into a unique
staging directory, verifies it, and swaps it in with one rename:

1. The adapter writes a journal beside the root, at
   `/home/user/portable__journal.json`. The journal names the staging
   directory and the target root hash. It is the commit intent, and
   it lands before the first staged byte.
2. The whole tree uploads into `/home/user/portable__staging_<id>`
   with its canonical permission bits.
3. The staged tree is hashed from the provider's own listing and
   bytes: kinds, executable bits, and content together. It must equal
   the revision the caller presented.
4. The published root moves to `/home/user/portable__backup`, and the
   staging directory takes its place. The first rename is the commit
   point.
5. The backup and the journal leave. The published tree is hashed
   again, and only then do the report and the recorded `lastPush`
   answer for it.

Obsolete entries vanish because the swap replaces the whole tree.
Deletions and file/directory type changes need no case list. An empty
revision publishes an empty tree. Paths outside the reserved family
never move: a removal touches only paths the adapter derived from its
own constants.

An interrupted publication resolves on the next transfer, push or
pull, from the state the three reserved paths show. It never resolves
from an assumed success:

- The staged tree verifies and the root is gone. The swap was
  committed, so the recovery finishes it.
- The root is gone and the staged tree is unusable. The backup is the
  only whole tree, so the recovery restores it.
- The root still stands. Nothing was committed, so the attempt is
  cancelled and the previous copy keeps serving.

Two publishers cannot mix their trees. One journal names one attempt;
a publisher whose attempt is gone refuses before the swap, and every
rename carries one whole tree. A lookup in the instant between the
two renames sees no root at all; it never sees a mixed tree. The same
holds for running commands: the published root is always absent or
whole, never partial.

A pull walks the remote tree, reads every byte, and rebuilds the
staging root through the content-addressed store — the tree is built
from bytes that crossed, never from provider claims. A stated
`expectedRootHash` refuses a mismatch with `IntegrityFailure`. The
destination policy must allow `local`. A pull replaces the staging
root it was given and nothing else: the change returns to the
workspace as a proposal with provenance, and the source of the base
revision is never overwritten.

The executable bit transfers with the bytes. The remote files API has
no permission operation, so a push sets the canonical modes through
one `chmod` command per entry after the write: `0o755` for an
executable file or a directory, `0o644` for a plain file. The
provider's creation mask never decides the bits. A pull reads the
listed bits back, marks each file executable when any execute bit is
set, and applies the same canonical modes after writing. The local
creation mask never decides them either. A round trip keeps the root
hash, whatever either mask did.

Links and special entries refuse by name, on both sides of the walk.
A pull that meets a symbolic link fails with `UnsupportedOperation`
and reason `remote-link`; a device, socket, or FIFO fails with reason
`remote-special-file`. The transfer never reads through such an entry.
This mirrors the local importer, which refuses links and special files
the same way (SPEC.md section 11.2).

One platform limit stays: a provider listing that carries no mode bits
reports its files as non-executable. The adapter assumes no support
from silence.

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
