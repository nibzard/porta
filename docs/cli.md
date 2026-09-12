# Portable CLI

The CLI is a thin layer over the Portable library (SPEC.md section 16).
Every command calls the same contracts an embedding application calls.
The CLI implements no lifecycle rules of its own.

Standard output carries machine records only. Streaming commands print
one JSON object per line. Diagnostics go to standard error.

| Exit code | Meaning |
| --- | --- |
| 0 | The command completed successfully |
| 1 | Known command failure |
| 2 | Invalid input or configuration |
| 3 | Unresolved or unknown outcome |

## Configuration

Every command names its targets explicitly:

- `--store PATH` or the `PORTABLE_STORE` variable names the control
  store database.
- `--policy-file PATH` or the `PORTABLE_POLICY` variable names the
  policy document a command needs as its authority.
- `--session SESSION` or the `PORTABLE_SESSION` variable names the
  session a command runs against.

A command that needs a session and does not get one refuses. The CLI
never guesses among several sessions, and it never scans for stores.

Structured requests travel in files or on standard input (`-`). No
command needs shell interpolation of JSON or secrets.

## Worked example

This walkthrough runs against a temporary local workspace. Each step
prints one JSON record; the next step reads its identifier from that
record.

### 1. Prepare the workspace and the policy

1. Create an empty directory for the example, with a workspace folder
   inside it.
2. Write one file into the workspace folder.
3. Write a policy file that allows the local process provider and
   local workspace transfers:

```json
{
  "schemaVersion": 1,
  "providers": ["local-process"],
  "transferDestinations": ["local"]
}
```

### 2. Create the session

```text
portable session create --policy-ref policy://example \
  --workspace ./workspace --store ./control.db
```

The record contains the session identifier, which the later steps
pass as `--session`.

### 3. Checkpoint the workspace

Write the checkpoint request to a file. The request names the source
directory. The `--stability` option declares how the source's writers
were made quiescent; the CLI refuses an undeclared source.

```json
{
  "requestKey": "checkpoint-1",
  "source": { "kind": "bridge", "rootPath": "./workspace" }
}
```

```text
portable checkpoint --request checkpoint.json --stability locked \
  --store ./control.db --session SESSION
```

The outcome contains the first revision identifier. A later
checkpoint also names the head it expects in `expectedHead`; a head
that moved refuses the checkpoint.

### 4. Inspect the session

```text
portable describe --store ./control.db --session SESSION
```

The description reports the persisted state: the session record, its
attachments, the workspace head, unresolved allocations, and pending
cleanup.

### 5. Attach one environment

An adapter module names operator-supplied code. This example uses the
local process adapter, with its supervisor state inside the example
directory, so the attachment survives CLI process exits:

```js
// worker-adapter.mjs
import { LocalProcessAdapter } from "portable";
export const adapter = new LocalProcessAdapter({ supervisorDir: "./supervisor" });
```

Write the environment request to a file:

```json
{
  "name": "worker",
  "providerId": "local-process",
  "requires": {}
}
```

```text
portable attach --request attach.json --request-key worker-1 \
  --adapter ./worker-adapter.mjs --principal user://example \
  --policy-file policy.json --store ./control.db --session SESSION
```

The `--request-key` value names the logical request. A retry under
the same key recovers the same attachment; the key is never
regenerated.

### 6. Materialize a proposal copy

```text
portable materialize --revision REVISION --destination ./copy \
  --mode proposal --policy-file policy.json \
  --store ./control.db --session SESSION
```

The copy is private. Edit its files freely; nothing reaches the
authoritative head until a proposal is accepted.

### 7. Propose the change

Edit a file inside `./copy`, stop its writers, then offer the copy's
content. The `--stability` option declares how you made the copy
quiescent; an undeclared copy refuses the proposal:

```text
portable workspace propose --attachment ATTACHMENT --generation 1 \
  --copy COPY --request-key propose-1 --stability locked \
  --store ./control.db --session SESSION
```

The copy identifier comes from the materialization record. The
generation reaches the library exactly as passed; retries under the
same request key reuse the recorded proposal.

### 8. Accept under an expected head

```text
portable workspace accept --proposal PROPOSAL --expected-head REVISION \
  --store ./control.db --session SESSION
```

The acceptance names the head it expects. A moved head exits 1 and
changes nothing: the workspace head, the proposal, and the copy files
all stay as they were.

### 9. Read the journal

```text
portable events --after 0 --store ./control.db --session SESSION
```

The journal prints as one JSON object per line, in sequence order.
`--after` resumes from a sequence, so a consumer that stops and starts
again never misses an event or repeats one.

## Operations

`invoke` admits one invocation and returns its durable operation
record. The identifier exists the moment the command returns;
completion is a later, separate step. Run the operation through the
adapter lease, record its result, and settle it:

1. `invoke` prints the operation record with status `accepted`.
2. The executor marks the operation dispatched and runs it through
   the adapter lease.
3. The executor records the result and settles the operation.
4. `operation inspect` prints the record exactly as stored.

A retry of `invoke` under the same request key returns the same
operation; the key and the attachment generation are never
regenerated.

A completed process operation with a nonzero process exit code is a
successful Portable invocation: `operation inspect` exits 0, reports
status `completed`, and the process exit code stays in the recorded
result. A lost response settles as `unknown`, and `operation
inspect` exits 3 while it prints the record.

`operation cancel` stops one operation at its provider through the
adapter lease. Only a confirmed stop settles the record as
`cancelled`; a best-effort stop leaves the outcome `unknown` with
the attempt on the cancellation trail.

`release` releases one attachment. The provider must confirm. A
retry under the same request key reports the recorded release and
never reaches the provider again. A provider that does not confirm
leaves the outcome `unresolved`: the command prints the record,
records a cleanup obligation, and exits 3.

## Replacement and recovery

`replace --plan` plans one replacement without side effects. The
plan reports every class of state — preserved workspace content,
reconstructed, reattached, and invalidated resources — and names
what blocks the transition. Planning allocates nothing: no
destination environment exists and the attachment generation does
not move.

A full `replace` runs the transition to its switch. The request
file wraps the replacement request in `request` and the destination
flow in `destination` (the adapter module, the copy root, and the
principal). The result reports both generations and the new
environment; the source environment's release stands as a cleanup
obligation until a cleanup pass confirms it.

`recover` reopens the session and prints the recovery report:
durable in-flight operations exactly as stored, and the lease state
of every attachment. The report says `conversationRestored: false`
because reopening restores records, never a model conversation.

## Conformance

`conformance` runs the SPEC.md section 21 case packs against one
loaded adapter module and prints the machine report:

```text
portable conformance --adapter ./worker-adapter.mjs \
  --adapter-version 1.2.3 --profile events,bundle
```

The report identifies the specification version, the adapter version
you stated, the adapter's own offers as the provider configuration,
the tested profiles, and every case outcome. `--profile` accepts a
comma-separated list; omit it to run every pack.

Cases that cause external effects or allocate paid resources run
only under the matching grant, `--external-effects` or
`--paid-allocation`. Both default refused. Without a grant the case
skips and the skip names the missing grant.

Failures and skips stay distinct in the record and the exit status:

- Every case passes: exit 0.
- Any case fails: exit 1, a known failure.
- No failure but any skip: exit 3, because skipped support is not
  established support.

## Conflicts change nothing

Every refusal path leaves durable state and files untouched:

- A checkpoint whose `expectedHead` names a moved head refuses before
  any blob is written.
- An acceptance under a wrong expected head refuses before the head
  moves.
- A proposal from a read-only snapshot refuses before any revision is
  recorded.

## Adapter modules

An adapter module exports `adapter`, an instance implementing the
adapter contract. Loading a module is configuration: the path names
operator-supplied code, and model-controlled input never supplies it.
