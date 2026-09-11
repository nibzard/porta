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
| Capability operations | None yet — `exec.process@1` lands with T035 |

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

## Unsupported requirements

- **Capability operations.** This adapter provides allocation and
  lease lifecycle only. `describe()` offers nothing and `invoke`
  refuses everything until `exec.process@1` support lands (T035).
  Cancellation and consumer binding answer `unsupported` explicitly.
- **Pause and resume as operations.** The adapter treats a paused
  sandbox as a held allocation and never exposes pause or resume as
  lease operations; renewal through the provider timeout is the only
  lifetime extension.
- **State beyond timeout.** The provider kills a sandbox when its
  timeout expires, and kill discards state. Persistence of a paused
  sandbox is a provider beta the adapter does not rely on.
- **Survival of adapter restart for in-flight state.** Durable
  identity covers acquisition records. Nothing else about a sandbox is
  cached across restarts; every answer re-reads the provider.
- **Graphics processors and non-Linux platforms.** Not offered; the
  offer and the manifest say linux, x86_64.
