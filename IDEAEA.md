Yes. I think the sharper framing is:

A portable and composable operating system for agents.

The agent brings its model, harness, tools, filesystem, and execution environments as independently replaceable components. The OS defines the contracts that let those pieces compose, detach, migrate, and scale without changing the agent’s logical identity.

I would be careful with “operating system” only in the sense that this is an agent-level OS contract, not a kernel or VM runtime. The product value is in defining what an agent environment is, how capabilities are exposed, and what must happen when execution moves.

The core promise could be:

Any component can be replaced. Any capability can be mounted. Any compatible environment can take over the work.

And I agree with your instinct not to directly support intermediary abstraction libraries. The core should be provider-agnostic enough that an agent—or a developer using an agent—can implement an adapter against the contract with very little code.

1. The conceptual model

I would define an agent as five separable layers:

Agent
├── Intelligence       model / inference provider
├── Harness            loop / session / orchestration
├── Capabilities       browser / shell / Python / GPU / desktop / DB / APIs
├── Workspace          files + explicit durable state
└── Execution          environments in which capabilities run

The OS itself owns none of these.

It owns:

Identity
Capability discovery
Capability attachment
Workspace portability
Environment transitions
State validity
Lifecycle + leases
Events
Policy boundary

That is an unusually small core.

The important design decision is that a “computer” is not a primitive.

A computer is just one possible capability bundle:

full-computer =
  filesystem
  + native-process
  + network
  + desktop
  + browser
  + persistent-processes

Monty might expose:

monty =
  python.monty
  + virtual-filesystem
  + host-functions

Steel might expose:

steel =
  browser.cdp
  + browser.session

A GPU machine might expose:

gpu-worker =
  process.exec
  + filesystem
  + gpu.cuda

The agent can compose all three at once.

⸻

2. Capability Specification

I would make this the primary public specification.

Call it something like:

Portable Agent Capability Specification — PACS

or more simply:

Portable Capability Spec

A capability is:

A versioned semantic contract describing something an environment can do.

Not an SDK method. Not a provider name.

Capability identity

I would use hierarchical names:

exec.python.monty@1
exec.python.cpython@1
exec.process@1
fs.workspace@1
browser.cdp@1
browser.interactive@1
desktop.gui@1
network.http@1
network.tcp@1
accelerator.cuda@1
service.port@1
snapshot.memory@1
snapshot.filesystem@1

A provider advertises an environment manifest:

{
  "environment": {
    "id": "env_01J...",
    "provider": "acme-runtime",
    "architecture": "x86_64",
    "os": "linux",
    "ephemeral": true
  },
  "capabilities": {
    "exec.process@1": {
      "argv": true,
      "stdin": true,
      "signals": ["SIGTERM", "SIGKILL"]
    },
    "fs.workspace@1": {
      "read": true,
      "write": true,
      "atomic_rename": true
    },
    "network.http@1": {
      "egress": "restricted"
    }
  },
  "resources": {
    "cpu": 2,
    "memory_mb": 4096
  }
}

The manifest is both machine-readable and model-readable.

Capability requirements

The caller asks for semantics rather than providers:

{
  "requires": {
    "exec.process@1": {},
    "fs.workspace@1": {
      "write": true
    }
  },
  "resources": {
    "memory_mb": {
      "min": 2048
    }
  },
  "preferences": {
    "locality": "local-first"
  }
}

This distinction matters:

requirements = cannot be violated
preferences  = may be relaxed

Never silently downgrade a security requirement.

For example:

{
  "requires": {
    "network.http@1": {
      "egress": "none"
    }
  }
}

must never resolve to an environment with unrestricted network just because it is the only available one.

⸻

3. Capability operations

I would keep the universal capability protocol extremely small.

Every capability needs only:

interface Capability {
  describe(): CapabilityDescriptor
  invoke(
    operation: string,
    input: unknown,
    context?: InvocationContext
  ): Promise<InvocationResult>
}

Then ergonomic libraries can add typed wrappers:

process.exec(...)
browser.goto(...)
python.eval(...)
fs.read(...)

But the wire contract remains generic.

This is useful because new capabilities do not require modifying the core library.

Someone can publish:

com.example.blender@1
postgres.query@1
ios.simulator@1
robot.arm@1

without a change to Portable itself.

That is where the “ultimate extensibility” claim becomes credible.

⸻

4. Capability descriptors

Each capability should describe more than methods.

Something like:

{
  "id": "exec.process@1",
  "operations": {
    "run": {
      "input_schema": "...",
      "output_schema": "..."
    }
  },
  "properties": {
    "stateful": false,
    "side_effects": true,
    "retry": "unsafe",
    "cancel": "supported"
  }
}

Those semantic fields are important.

I would standardize at least:

stateful
side_effects
idempotency
cancellation
streaming
persistence
migration
security_boundary

For example:

{
  "id": "browser.session@1",
  "properties": {
    "stateful": true,
    "side_effects": true,
    "retry": "operation-dependent",
    "persistence": "external-resource",
    "migration": "reattach"
  }
}

versus:

{
  "id": "exec.python.monty@1",
  "properties": {
    "stateful": true,
    "persistence": "snapshot-compatible",
    "migration": "runtime-version-dependent"
  }
}

This helps a harness reason correctly about what can survive.

⸻

5. Resources should be first-class references

This is probably the most important piece beyond capabilities.

A capability can produce a resource:

browser session
database connection
running process
GPU allocation
HTTP server
desktop
volume

Do not serialize provider-native objects into agent state.

Use a portable reference:

{
  "resource": {
    "id": "res_01J...",
    "type": "browser.session@1",
    "environment": "env_123",
    "lifetime": "lease",
    "reattachable": true
  }
}

Then:

const browser = await runtime.resolve(resourceRef)

The provider adapter knows how to map that reference back to the underlying implementation.

Crucially:

resource ID ≠ authorization token.

Authorization comes from the current runtime context.

Otherwise checkpoints become credential-bearing artifacts.

⸻

6. Execution environments should be mountable

I would formalize your mounting metaphor.

Conceptually:

const agent = portable.agent()
agent.mount("python", monty)
agent.mount("browser", steel)
agent.mount("compute", cloudMachine)
agent.mount("workspace", workspace)

But I might avoid making the public primitive literally mount, because it risks implying POSIX filesystem semantics.

Maybe:

agent.attach(...)
agent.detach(...)
agent.replace(...)

with:

agent.mount(...)

as friendly syntactic sugar.

An environment attachment looks like:

{
  "name": "analysis",
  "environment_id": "env_123",
  "capabilities": [
    "exec.process@1",
    "fs.workspace@1"
  ],
  "workspace_revision": "ws_48"
}

Multiple environments can coexist.

That is more powerful than escalation.

⸻

7. Workspace Specification

I would make the workspace contract intentionally boring.

The workspace is:

The portable durable state of the agent’s work.

Not the entire operating system filesystem.

Not /proc.

Not a VM image.

Not interpreter memory.

Version one should support:

files
directories
metadata
content hashes
revisions

Something like:

interface Workspace {
  head(): Promise<WorkspaceRevision>
  checkpoint(): Promise<WorkspaceRevision>
  materialize(
    revision: WorkspaceRevision,
    target: Environment
  ): Promise<WorkspaceMount>
  commit(
    mount: WorkspaceMount
  ): Promise<WorkspaceRevision>
}

The important abstraction is the revision:

{
  "id": "ws_01J...",
  "parent": "ws_01H...",
  "created_at": "...",
  "root_hash": "sha256:..."
}

That gives you explicit handoff points.

⸻

8. Don’t require one physical filesystem implementation

The workspace could be backed by:

local directory
SQLite
Git-like CAS
S3
AgentFS
NFS
provider volume
memory

Portable does not care.

An adapter only needs to satisfy the contract.

That aligns nicely with your philosophy:

bring any component.

⸻

9. Handoff Specification

I would make this the second major spec.

Call it:

Portable Agent Handoff Specification — PAHS

A handoff means:

The logical work session changes environment while preserving an explicitly declared subset of state.

Not “migration” by default.

Migration tends to imply transparent continuation.

Handoff makes the boundary explicit.

Handoff has four pieces

source environment
destination environment
portable state
validity transition

The minimal handoff record might be:

{
  "handoff_id": "ho_01J...",
  "from": "env_local",
  "to": "env_cloud",
  "workspace": {
    "revision": "ws_42"
  },
  "preserved": [
    "workspace",
    "conversation",
    "resource:browser_7"
  ],
  "invalidated": [
    "process:1234",
    "python-locals",
    "open-file-handles"
  ],
  "reconstructed": [
    "python-environment"
  ]
}

The agent should never have to guess.

⸻

10. Define state classes

I would standardize state into four classes.

Portable state

Can be transferred between environments.

Examples:

workspace files
task metadata
conversation log
operation journal
explicit JSON state

Reconstructable state

Cannot directly move but can be recreated.

Examples:

Python dependencies
Git checkout
virtualenv
running service
database client

Reattachable state

Lives outside the execution environment and can be rebound.

Examples:

Steel browser
remote DB session
cloud storage bucket
MCP server

Native state

Requires provider/runtime-specific restoration.

Examples:

process memory
interpreter heap
VM snapshot
open TCP sockets
GPU context

This taxonomy alone could be valuable to the ecosystem.

⸻

11. Handoff lifecycle

I would define a very explicit protocol:

1. PREPARE
2. CHECKPOINT
3. PROVISION
4. MATERIALIZE
5. VALIDATE
6. SWITCH
7. RELEASE

Something like:

await runtime.handoff({
  from: current,
  requirements: {
    "exec.process@1": {}
  }
})

Internally:

PREPARE
  resolve outstanding operations
  freeze new writes if necessary
CHECKPOINT
  workspace -> ws_49
  state bundle -> state_49
PROVISION
  acquire destination
MATERIALIZE
  restore workspace
  recreate reconstructable state
  rebind external resources
VALIDATE
  ensure required capabilities are available
SWITCH
  increment environment epoch
  publish environment.changed
RELEASE
  dispose source when policy permits

If anything before SWITCH fails, the source stays authoritative.

That is the transaction boundary.

⸻

12. Environment epochs

I would introduce this from day one.

Each logical agent session has:

{
  "session": "agent_abc",
  "environment_epoch": 7
}

Every environment transition increments the epoch.

Handles can optionally carry the epoch:

{
  "resource": "proc_123",
  "epoch": 6
}

Trying to use it after the handoff gives:

StaleHandleError

This prevents a huge class of confusing agent behavior.

⸻

13. Operation journal

This is probably necessary for reliable handoffs.

The journal should be append-only:

{
  "id": "op_123",
  "capability": "browser.cdp@1",
  "operation": "click",
  "status": "started",
  "timestamp": "..."
}

followed by:

{
  "id": "op_123",
  "status": "completed",
  "result_ref": "artifact_789"
}

Or:

{
  "id": "op_123",
  "status": "unknown"
}

The four outcomes I’d standardize are:

completed
failed
cancelled
unknown

The last one is critical.

If the underlying system clicked “Pay” but the transport died before the response returned, Portable cannot call that “failed.”

That would be semantically wrong.

⸻

14. Portable State Bundle

I would make this the serialization format for handoff.

Maybe:

Portable Agent Bundle

.pab perhaps.

Conceptually:

bundle/
├── manifest.json
├── workspace.ref
├── context.json
├── journal.jsonl
├── resources.json
└── extensions/

Example manifest:

{
  "spec": "portable-agent/1",
  "session": "agent_123",
  "epoch": 4,
  "workspace": {
    "revision": "ws_abc"
  },
  "context": {
    "conversation_ref": "conversation_789",
    "resume_summary": "Collected pricing data. Analysis remains."
  },
  "resources": [
    {
      "id": "browser_1",
      "type": "browser.session@1",
      "reattachable": true
    }
  ],
  "extensions": {}
}

I would deliberately not standardize the complete harness transcript initially.

Allow:

{
  "conversation_ref": "...",
  "format": "opaque",
  "provider": "..."
}

or:

{
  "format": "openai-responses-vX",
  "artifact": "..."
}

Later, if a natural common format emerges, you can add it.

⸻

15. EnvironmentChanged event

This should be part of the core spec.

{
  "type": "portable.environment.changed",
  "epoch": 5,
  "previous": {
    "environment": "monty-local"
  },
  "current": {
    "environment": "linux-cloud"
  },
  "capabilities_added": [
    "exec.process@1"
  ],
  "capabilities_removed": [
    "exec.python.monty@1"
  ],
  "preserved": [
    "workspace",
    "browser.session"
  ],
  "invalidated": [
    "interpreter.locals"
  ]
}

Harnesses can surface that event however they want:

system message
tool-state update
MCP tool list update
internal runtime event

No RL required.

⸻

16. Tiny reference library

I would make the reference library shockingly small.

Potential package:

portable-agent

or:

portable

Core directory:

src/
├── runtime.ts
├── capabilities.ts
├── environment.ts
├── resources.ts
├── workspace.ts
├── handoff.ts
├── journal.ts
├── events.ts
├── policy.ts
└── adapter.ts

I would aim for maybe 1,500–3,000 lines for the entire core, excluding tests and adapters.

⸻

17. Adapter contract

This is where ultimate extensibility lives.

An adapter should look roughly like:

export interface EnvironmentAdapter {
  readonly id: string
  describe(): Promise<EnvironmentOffer[]>
  acquire(
    request: EnvironmentRequest
  ): Promise<EnvironmentLease>
  restore?(
    checkpoint: NativeCheckpoint
  ): Promise<EnvironmentLease>
}

And:

export interface EnvironmentLease {
  readonly id: string
  manifest(): Promise<EnvironmentManifest>
  invoke(
    capability: CapabilityId,
    operation: string,
    input: unknown
  ): Promise<InvocationResult>
  bind?(
    resource: ResourceRef
  ): Promise<BoundResource>
  release(): Promise<void>
}

That is close to all you need.

Providers can implement:

MontyAdapter
DockerAdapter
E2BAdapter
ModalAdapter
LocalShellAdapter
KubernetesAdapter
SteelAdapter
BrowserbaseAdapter
MyCompanyInternalVMAdapter

Portable itself doesn’t know any of them.

⸻

18. Ideally adapters can be agent-written

This part of your idea is especially compelling.

You could make adapter creation sufficiently declarative that an agent can write one from provider docs.

For example:

defineAdapter({
  id: "acme",
  capabilities: {
    "exec.process@1": processCapability({
      run: async ({ argv, cwd, env }) => {
        ...
      }
    })
  },
  acquire: async request => {
    ...
  }
})

Then offer:

portable conformance ./acme-adapter.ts

And get:

✓ environment acquisition
✓ argv preservation
✓ stdout/stderr separation
✓ exit codes
✓ binary workspace roundtrip
✓ cancellation
✗ signal termination semantics
✓ release

That is likely more valuable than shipping fifty official integrations.

⸻

19. Conformance tests are essential

The project becomes trustworthy if an adapter can prove what it implements.

Every capability specification should ship with conformance tests.

For exec.process@1:

argv semantics
cwd
environment variables
stdout
stderr
exit codes
timeout behavior
cancellation
binary output
maximum output behavior

For fs.workspace@1:

binary files
Unicode paths
nested directories
overwrite
delete
atomic writes
path traversal
metadata
large files

For handoff:

failed destination provisioning
failed materialization
source preserved before switch
epoch increments
stale handle rejected
workspace revision consistent
external resource rebound

Then the ecosystem doesn’t need your approval.

Anyone can say:

“This provider is Portable-compatible.”

and publish the conformance output.

⸻

20. The Runtime API

From the user perspective, I’d aim for something this simple:

const portable = createPortable({
  workspace,
  adapters: [
    localMonty,
    cloudLinux,
    steelBrowser
  ]
})
const agent = await portable.session()
const python = await agent.attach({
  requires: ["exec.python.monty@1"]
})
const browser = await agent.attach({
  requires: ["browser.cdp@1"]
})

Later:

const compute = await agent.attach({
  requires: ["exec.process@1"],
  resources: {
    memoryMb: { min: 8192 }
  }
})

Or hand off:

await agent.handoff({
  replace: python,
  requires: ["exec.python.cpython@1"]
})

And the agent can inspect itself:

await agent.describe()

returning:

{
  "workspace": "ws_42",
  "epoch": 8,
  "environments": {
    "python": ["exec.python.cpython@1"],
    "browser": ["browser.cdp@1"]
  }
}

⸻

21. One particularly elegant concept: capability namespaces

Instead of forcing one environment to look like a computer, expose mounted capabilities under namespaces.

For example:

/python
/browser
/compute
/workspace

Not necessarily literal filesystem paths, but logically:

agent.capabilities.python
agent.capabilities.browser
agent.capabilities.compute

Then the same agent program can operate against:

browser -> Steel
compute -> Modal
python -> Monty
workspace -> local CAS

and tomorrow:

browser -> local Chrome
compute -> Kubernetes
python -> CPython sandbox
workspace -> AgentFS

without changing logical structure.

That is a genuinely OS-like property.

⸻

22. What I would explicitly NOT put in v1

This will matter a lot.

I would explicitly state that Portable does not initially provide:

* a sandbox implementation,
* a cloud control plane,
* a scheduler,
* a distributed filesystem,
* a universal conversation format,
* transparent process migration,
* exactly-once side effects,
* secrets management,
* container orchestration,
* provider billing abstraction,
* model routing,
* an agent framework.

That makes the project much easier to understand.

Portable is the composition and continuity layer.

⸻

23. The spec hierarchy I would publish

I’d structure the repository like this:

spec/
├── core.md
├── capabilities.md
├── environments.md
├── workspace.md
├── resources.md
├── handoff.md
├── journal.md
├── events.md
└── capabilities/
    ├── exec.process.md
    ├── exec.python.md
    ├── fs.workspace.md
    ├── browser.session.md
    └── network.http.md

The normative core could remain very small.

Then capability specs can evolve independently.

Third parties can publish their own:

acme.capabilities/
└── gpu.h100-cluster@1

No central registry is technically required.

⸻

24. Extensions

I’d explicitly design extension points into every object.

For example:

{
  "spec": "portable/1",
  "extensions": {
    "com.modal.snapshot": {...},
    "com.steel.browser": {...}
  }
}

The core ignores unknown extension namespaces.

This is how you avoid repeating the classic universal-abstraction failure mode where the lowest common denominator eventually blocks every interesting provider feature.

Portable should give you:

common semantics when available
native escape hatch always

Maybe every lease offers:

lease.extension("com.provider.foo")

or:

lease.native()

I prefer extensions because native() makes portability easy to abandon accidentally.

⸻

25. The strongest positioning

I wouldn’t lead with:

universal sandbox interface.

Too narrow and too crowded.

I would lead with something like:

Portable is an open operating contract for agent environments.

Compose models, harnesses, filesystems, browsers, sandboxes, machines, and specialized compute as replaceable components. Attach capabilities when needed, hand work between environments, and preserve explicit state across transitions.

And the one-line technical explanation:

Capabilities describe what an environment can do; workspaces describe what moves; handoffs describe what survives.

That is the architecture in one sentence.

The smallest credible first release, in my view, is the spec + ~2k-line reference runtime + conformance suite + three deliberately very different example adapters: Monty, a local native process environment, and Steel browser. If those compose cleanly—and you can swap Monty for native compute mid-task while retaining the browser and workspace—you’ve demonstrated essentially the whole thesis.
