# Monty Python adapter

The `monty-python` adapter executes the `exec.python@1` capability
(SPEC.md section 14.2) on the Monty engine. Monty is a sandboxed
Python-subset interpreter written in Rust and driven through
crash-isolated worker subprocesses by the `@pydantic/monty` Node
binding.

## Selected engine

| Field | Value |
| --- | --- |
| Engine | Monty (`@pydantic/monty`) |
| Version | 0.0.23 |
| Capability | `exec.python@1`, operation `evaluate` |
| Subset | `lite` |
| Persistent state | `call-isolated` |
| Isolation | Sandboxed interpreter worker, no host access outside mounts |

The adapter reports the installed engine version in every offer and
manifest under `enforcement.engineVersion`.

## Enforcement facts and acquisition limits

Every offer and manifest carries the typed enforcement facts of
SPEC.md section 7:

| Fact | Value | Why |
| --- | --- | --- |
| `executionLocation` | `local` | The worker subprocesses run on the host. |
| `networkEgress` | `none` | The interpreter has no network reachability. |
| `hostFilesystemAccess` | `false` | Workers see only the authorized copy mounts, never the host filesystem. |

The acquire call reads the effective limits. A policy that allows no
`local` execution refuses before any worker exists, and the lease span
never exceeds the lifetime ceiling. Stricter egress and host access
policies are satisfied, because the engine enforces them by
construction.

## Verified subset

Monty interprets a Python-subset language. The adapter declares the
imports it has verified by importing and using them:

`base64`, `collections`, `datetime`, `functools`, `itertools`, `json`,
`math`, `re`

Any other module raises `ModuleNotFoundError` inside the call and the
result carries it as a structured exception. A requirement that names
an import the declaration does not list fails acquisition, because the
offer and the manifest carry the same list.

## Limits

| Limit | Default | Enforcement |
| --- | --- | --- |
| `maxSourceBytes` | 262144 | Checked before a session starts |
| `maxDurationMs` | 30000 | Engine kills the worker at the cap |
| `maxOutputBytes` | 262144 | Host capture drops the rest and sets `truncated` |

A call may only narrow the declared limits, never widen them. The
duration limit ends the call with a `TimeoutError` exception and
`timedOut: true`; a wedged interpreter is killed by the engine, not by
a host-side race. Worker memory is bounded at 256 MiB per session and
is configurable through `workerMemoryBytes`.

## Bindings

- **Host functions.** The embedding application registers functions by
  name when it constructs the adapter. A call binds one with
  `{ "name": "...", "kind": "host-function" }`; the program calls it by
  that name. Keyword arguments arrive as a trailing object. A thrown
  error crosses into the program as a Python exception.
- **Workspace bindings.** `{ "name": "...", "kind": "workspace",
  "path": "data", "mode": "read" }` mounts one directory of the
  authorized working copy at `/mnt/<name>`. `read` mounts read-only;
  writes raise `PermissionError`. `read-write` writes through to the
  copy. Paths resolve inside the copy only; an absolute path or a
  `..` escape refuses the call before the program runs.

## Serialization

Values cross both directions through JSON compatibility:

- Numbers, strings, booleans, `None`, lists, and tuples cross
  directly. A dict with string keys crosses as a JSON object.
- A dict keyed by non-strings, a set, bytes, or a class instance
  cannot ride in a result. The call answers with a `TypeError`
  exception that names the fix: convert with `json.dumps`.

## Unsupported requirements

- **Full Python semantics.** Monty is a subset interpreter. The
  declaration says `subset: "lite"`, and a requirement for full Python
  never matches. Selecting this engine by name says nothing about
  compatibility with every Python program.
- **Persistent interpreter state.** Each `evaluate` call runs in one
  fresh session; no name, global, or import survives a call. The
  declaration says `persistentState: "call-isolated"`, and the only
  accepted value is that one.
- **Cancellation.** An evaluation ends at its duration limit or its
  end, never between; `cancel` answers `unsupported`, and the
  descriptor declares it.
- **Networking.** The engine has no network reachability; the
  enforcement declaration says so.
- **Durability across restart.** Environments are in-memory workers.
  After a process restart, `reconcile` reports `unknown`, never a
  guess.
- **Consumer binding.** The adapter offers no provider-side resource
  for another attachment to consume; `bind` answers `unsupported`.

## Conformance

`src/adapters/monty-python-adapter.test.ts` covers the conformance
cases: unsupported imports, serialization both ways, limits (duration,
source size, output truncation), and state isolation across calls.
