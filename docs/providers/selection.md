# Provider selection: remote compute and browser

Record of the provider evaluation for SPEC.md sections 8, 14.4, 14.6,
and 22 (task T033). The selected providers back T034 (remote Linux
allocation and leases) and T043 (the independent browser adapter).

## Decision

| Role | Selected provider | Identity |
| --- | --- | --- |
| Remote Linux compute | E2B | Firecracker microVM sandboxes, JS SDK, public REST API |
| Independent browser | Browserbase | One session equals one cloud browser, driven over CDP |

Both providers are reachable through plain REST and SDK calls. Neither
requires a Model Context Protocol (MCP) server anywhere in the
acceptance workflow. MCP front ends exist for both; Portable does not
use them.

## Why the acceptance workflow fits (SPEC.md section 22.1)

| Workflow step | What it needs | How the selection answers |
| --- | --- | --- |
| 1. Inspect repository data through lightweight Python | Local Monty engine | No remote provider involved |
| 2. Attach local native execution | Local process adapter | No remote provider involved |
| 3. Checkpoint and attach an independent browser | Browser session the runtime does not own | Browserbase session, attached through its own adapter |
| 4. Replace local compute with remote Linux | Remote processes and workspace transfer | E2B commands and files API; the workspace store ships the revision |
| 4. Reconstruct dependencies and the server | Durable remote allocation | E2B sandbox with a stable ID; reconciliation by that ID |
| 5. Connect the browser to the new server | The browser reaches the new compute | E2B public URL of the exposed port; the browser navigates to it |
| 5. Record verification artifacts | Screenshots tied to a revision | CDP screenshots; artifacts land in the workspace store |
| 6. Inject a replacement failure and recover | Honest unresolved state | E2B reconciliation by sandbox ID; obligations record the rest |
| 7. Release compute, reopen, keep the browser | Independent lifetimes | Browserbase session outlives the E2B release; its lease status is queried, not assumed |

## Remote Linux: E2B

### Acquisition reconciliation

- Every sandbox has a stable identifier. A controller that lost a
  response re-attaches by that identifier and reads current state.
- Requests against a paused sandbox auto-resume it. Each resume gets
  a fresh timeout, and a later timeout pauses it again.
- The SDK exposes lifecycle inspection (`getInfo` by identifier), so
  `reconcile` can answer `allocated`, `released`, or `unknown` from
  provider truth instead of guessing.

### Persistence

- A running sandbox is bounded: one hour on the Hobby tier, up to 24
  hours on Pro. The adapter must renew leases inside that window.
- A paused sandbox is kept indefinitely. There is no time-to-live and
  no automatic deletion of a paused sandbox.
- Timeout behavior is configurable: pause (default) preserves full
  state; explicit kill discards it. Pausing costs seconds per GiB of
  memory; resuming about one second. Persistence is a public beta
  feature, so the adapter treats pause and resume as best effort and
  reports what happened.

### Enforcement

- Each sandbox is one Firecracker microVM. The host is not shared
  with the caller's account.
- Outbound internet is on by default, with an allow and deny list per
  sandbox. Private and link-local ranges are blocked by default.
- Inbound reach is a per-sandbox public URL; a port inside the
  sandbox becomes reachable through it. This is the transport
  `service.port@1` exposes.

### Service connectivity

- A process listening inside the sandbox is reachable at the
  sandbox's public URL for that port. The acceptance demo's
  application server binds a port; the browser attachment navigates
  to the URL. No tunnel process and no MCP relay take part.

### Credentials and test authority

- One API key per account, created in the dashboard, passed as
  `E2B_API_KEY`. The adapter resolves it at use time from the
  authorized context and never writes it into a record, bundle, or
  journal entry.
- The Hobby tier carries a one-time credit allowance, 20 concurrent
  sandboxes, and 10 GiB of storage. Conformance tests that create and
  delete one sandbox per run stay well inside it. Tests skip, rather
  than fail, when the environment names no key.

### Cleanup

- A sandbox that times out pauses (default) or dies, per request.
  Billing stops when a sandbox pauses, times out, or is killed.
- A paused sandbox stays until it is deleted, so release must be
  explicit. When the provider does not confirm a release, the runtime
  keeps the cleanup obligation — a paused sandbox left behind stays
  visible until a cleanup pass confirms deletion.

### Unsupported requirements

- Persistence pause and resume is a public beta with measured pauses
  of seconds per GiB. The adapter declares renewal and reconciliation
  support, and it never claims a pause succeeded without the
  provider's answer.
- Auto-resumed sandboxes restart with a five-minute minimum timeout;
  shorter renewals cannot go below it.
- No graphics processors and no non-Linux platforms in scope.

## Independent browser: Browserbase

### Acquisition reconciliation

- Every session has an identifier and a status queryable through the
  REST API. `reconcile` reads session state by that identifier.
- A new session must be connected within five minutes or it
  terminates. The adapter connects at acquire time, so the window
  cannot pass silently.

### Persistence

- A session terminates when it disconnects or when it reaches its
  timeout. Keep-alives extend a session past disconnects; the timeout
  is set per session over a project default.
- Long sessions extend the model for the acceptance demo's
  browser-lives-longer-than-compute step.
- Contexts persist cookies, tokens, and authentication state across
  sessions on the provider side. Portable keeps that state
  provider-owned (SPEC.md section 14.4): it never exports cookies
  into the workspace, and a context reference crosses a handoff as an
  opaque provider identity.

### Enforcement

- One session is one cloud browser isolated per account.
- Proxies and stealth fingerprinting are per-project and per-session
  settings. The offer declares the project's configuration; a
  requirement the project cannot satisfy fails matching.

### Service connectivity

- The browser is a consumer, not a server. `service.port@1` connects
  it by giving the session a navigation target: the E2B public URL.
  The runtime validates the exposure and the consumer policy; the
  provider only sees a navigation.

### Credentials and test authority

- An API key and secret from the dashboard, resolved at use time.
  They never enter portable records or bundles.
- A free tier with usage credits covers session-based conformance
  tests. Check the current allowance on the pricing page. Tests skip
  when the environment names no key.

### Cleanup

- Sessions end on disconnect or timeout, and explicitly through the
  API. Release asks the provider, and only a provider-confirmed end
  commits `released`; anything else leaves an obligation.

### Unsupported requirements

- Each connection attaches to the session's browser; a reported
  caveat says state can reset between separate connections. The
  adapter holds one connection per lease and re-attaches through
  `reconnect` semantics rather than assuming page state survived.
- The surface is CDP. `browser.cdp@1` consumers accept the
  compatibility limits the descriptor advertises (SPEC.md 14.5).
- Cookies and authenticated state stay provider-owned in version one;
  Portable never exports them into the workspace automatically.

## Rejected alternatives

| Candidate | Role | Why not selected |
| --- | --- | --- |
| Daytona | Remote Linux | Viable: snapshots, per-sandbox firewall, TypeScript SDK. Snapshots are template-shaped rather than full-state pause and resume, and linked sandboxes stay ephemeral by design. E2B's pause and resume and public URLs map more directly onto the acceptance workflow. Revisit if E2B persistence leaves beta unsuitable. |
| Fly.io Machines, Modal | Remote Linux | API-driven VMs and containers, but lifecycle semantics (placement, machine images, serverless scheduling) fit long-running services more than agent sandboxes with handoffs. |
| Browserless, Steel | Browser | Both offer session APIs over CDP. Browserbase's long sessions, contexts, and keep-alives match the browser-outlives-compute step most directly. |
| Cloudflare Browser Rendering | Browser | CDP access exists, but binding and scale limits sit inside another platform's account model. |

## Sources

- E2B: sandbox persistence, auto-resume, lifecycle, internet access,
  public URL, billing, API key, pricing —
  <https://docs.e2b.dev/sandbox/persistence>,
  <https://docs.e2b.dev/sandbox/auto-resume>,
  <https://docs.e2b.dev/sandbox>,
  <https://docs.e2b.dev/network/internet-access>,
  <https://docs.e2b.dev/network/public-url>,
  <https://docs.e2b.dev/billing>,
  <https://docs.e2b.dev/api-key>,
  <https://e2b.dev/pricing>
- Browserbase: long sessions, session management, connection timeout,
  contexts, sessions API —
  <https://docs.browserbase.com/platform/browser/long-sessions/overview>,
  <https://docs.browserbase.com/platform/browser/getting-started/manage-browser-session>,
  <https://docs.browserbase.com/platform/browser/getting-started/using-browser-session>,
  <https://docs.browserbase.com/platform/browser/core-features/contexts>,
  <https://docs.browserbase.com/reference/api/create-a-session>
- Daytona for the comparison record —
  <https://www.daytona.io/docs/en/sandboxes/>,
  <https://www.daytona.io/docs/en/snapshots/>,
  <https://www.daytona.io/docs/en/api-keys/>

Verified 2026-09-11.
