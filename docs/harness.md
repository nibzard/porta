# Harness integration: OpenAI Agents SDK

This document implements one harness integration for Portable
(SPEC.md section 17). The harness is the OpenAI Agents SDK for
JavaScript. Portable treats it as a consumer: the SDK owns the agent
loop and the conversation, and Portable owns the managed environments
the loop calls into.

The integration ships as `AgentsToolkit` from the library entry:

```js
import { AgentsToolkit, authorityForApproval } from "portable";
```

## What the toolkit gives the SDK

`toolkit.tools()` returns three tool definitions whose shape the SDK
adopts directly:

```js
import { tool, jsonSchema } from "@openai/agents";

const portable = toolkit.tools().map((definition) =>
  tool({
    name: definition.name,
    description: definition.description,
    parameters: jsonSchema(definition.parameters),
    execute: definition.execute,
  }),
);
```

The tools:

- `portable_environment` reports the managed environments: the
  capabilities of every attachment, the validity of every resource
  binding, the workspace revision, and the built-in tool route.
- `portable_checkpoint` synchronizes the local bridge directory's
  edits into a workspace revision.
- `portable_run` runs one command on the attached environment. The
  run passes the harness approval flow first.

Run the agent with serial tool calls. The Agents SDK does this by
default; do not enable parallel tool calls, because the bridge
checkpoint declares that no bridge writer is active during a tool
call.

## The local bridge and file authority

The SDK's built-in shell and file tools are not managed work.
Portable never redirects them silently. The integration defines their
route at construction:

```js
const toolkit = new AgentsToolkit({
  // ...
  route: { decision: "local-bridge", bridgeRootPath: "./bridge" },
});
```

Under `local-bridge`:

- The harness's own permission system governs the built-in tools.
  Configure the SDK's sandbox or approval settings so those tools may
  touch only the bridge directory. That is the file authority: the
  harness grants it, Portable never mediates it, and no Portable
  policy applies to built-in tool calls.
- The bridge directory is the single source of local edits. The
  `portable_checkpoint` tool synchronizes it into the workspace
  revision tree, and every verification run synchronizes it again
  first (see below).

Under `excluded`, the embedding application disables the built-in
tools. Shell and file work then happens only through attached
environments, and all of it is managed work under Portable policy.
The toolkit offers no checkpoint tool in that mode and refuses
verification runs, because it cannot prove which local edits a
verification would test.

## Approvals become bounded authority

A harness approval must be translated into bounded runtime authority,
and Portable never infers approval from generated text that requests
a capability. The toolkit's approval source is the SDK's
human-in-the-loop callback, not the model:

```js
const toolkit = new AgentsToolkit({
  // ...
  authority: operatorAuthority,           // trusted, from configuration
  approvals: {
    approve: async (requested) => {
      const decision = await myApprovalUi(requested); // human action
      return decision === null
        ? null
        : { approvedBy: "user://ada", operations: requested.operations };
    },
  },
});
```

Every `portable_run` call asks the source once. `null` means the run
refuses before anything is admitted, and the refusal is data in the
tool result. A granted approval flows through
`authorityForApproval`, which narrows the operator's base authority:

- The derived authority can only lose grants. An approval that names
  a capability the base withholds grants nothing.
- An approval without an authenticated approver (`user://`,
  `approval://`, or `operator://` scheme) refuses. Model-generated
  text has no path into this record.
- An expired `expiresAt` grants nothing.

## Remote verification synchronizes local edits first

Before any remote verification, the integration synchronizes local
edits through the workspace checkpoint contract. A `portable_run`
with `verify: true`:

1. Checkpoints the local bridge, so local edits become the revision
   the run tests.
2. Materializes a proposal copy of that revision and prepares the
   verification run, which records the tested revision.
3. Runs the command inside a private verification copy materialized
   from the tested revision. Unrelated writers stay outside both
   hashes.
4. Settles the run and measures every tracked path that changed.

Point the environment adapter's working-copy root at the same
directory you pass as `runsRoot`. The local process adapter does this
with its `workingCopyRoot` option, so a relative working directory
resolves inside the verification copy.

## Environment changes reach the agent

Every `portable_run` result carries an environment context update,
and the `portable_environment` tool reports the same record on
demand. The update includes the capabilities of every attachment,
resource validity, and the workspace revision, plus the built-in tool
route and the opaque harness conversation reference. The agent never
has to guess what its environments can do.

## Session reopening and its limits

A harness process can die between turns. After a restart, the
embedding application reopens the store, opens the session, and calls
`toolkit.reopen()`:

```js
const outcome = await toolkit.reopen();
console.log(outcome.conversationRestored); // always false
console.log(outcome.harnessNotice);
```

What reopens: attachment states, the workspace head, pending cleanup
obligations, and in-flight operations exactly as stored.

What does not reopen: the harness conversation, and the agent loop.
Portable restores records; it does not restore a model conversation
and does not resume a loop. The Agents SDK keeps its own thread. When
you export a portable state bundle, the opaque `harnessContextRef`
you configured here travels inside it, uninterpreted — Portable never
reads it, and the harness that receives the bundle decides what to do
with it.
