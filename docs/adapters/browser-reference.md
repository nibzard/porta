# Reference browser adapter

The `browser-reference` adapter operates `browser.session@1` sessions
that live in a provider driver, not in any compute allocation
(SPEC.md sections 8 and 14.4). Sessions survive the release of the
environment that created them when the driver declares external
persistence, and a later attachment reaches them again only through a
binding.

| Field | Value |
| --- | --- |
| Provider | `browser-reference` |
| Driver | Operator-supplied; the demonstration ships `HttpBrowserDriver` |
| Capability operations | `browser.session@1`: create, navigate, screenshot, inspect, close |
| Session store | Adapter memory; a restarted adapter answers `unknown` |

## The driver contract

The adapter never touches the network itself. Every request a session
makes crosses through its driver, and the driver carries the contract:

- `networkEnforcement` states whether the driver applies the rules it
  is given. `origin-allowlist` means it checks every request — the
  navigation, each redirect hop, and every dependency the page
  declares — before the request leaves the driver. `unsupported`
  means it checks nothing, and the adapter refuses a restrictive
  acquisition rather than trusting it.
- `createSession` receives the session's `network` rules and enforces
  them for the session's lifetime.

Checking a final URL after the fact enforces nothing: a redirect that
crosses to a forbidden origin must produce zero requests at that
origin. A driver that cannot promise that declares `unsupported`.

## Network rules

| Field | Meaning |
| --- | --- |
| `allowedOrigins` | Explicit list: only those origins. `["*"]`: no origin restriction. `[]`: no origin is admitted. |
| `blockPrivateRanges` | Loopback, private, link-local, shared, and unspecified ranges are refused. |

Rules resolve at acquisition and are recorded with it. Policy narrows
the operator's list; neither widens the other. A policy allowlist
keeps only origins whose host the policy admits — the intersection
may close the list to empty, and every navigation then refuses. A
policy of `none` refuses the acquisition: a browser that may navigate
nowhere is not an environment this provider can honestly provide.

The manifest reports the recorded rules of its environment, so a
reopened adapter with different operator defaults never relabels an
existing acquisition.

## Private-address enforcement

Blocking private ranges refuses an address twice:

1. By name and by literal address before any dial. `localhost` and
   its subdomains refuse as a private name; a literal address —
   including IPv4-mapped IPv6 spellings such as
   `::ffff:127.0.0.1` — refuses as an address.
2. At the connection, through a validating lookup: the name resolves,
   every answer is filtered, and only public addresses survive. The
   filtered list is the one list the socket may dial, so a name
   cannot resolve clean at check time and private at connect time.

## Denials

A refused request never leaves the driver. The driver reports a
structured denial — `origin-not-allowed`, `private-range`,
`address-rejected`, or `too-many-redirects` — with the URL it
refused. The adapter surfaces it as `PolicyDenied` with the same
detail, and the session keeps the state its last successful
navigation left: a blocked navigation moves nothing.

## The demonstration driver

`HttpBrowserDriver` (`src/adapters/http-browser-driver.ts`) is the
reference implementation. It loads documents over HTTP, follows
redirects manually under a limit of ten hops, resolves each page's
declared `fetch("...")` endpoints against the final document URL, and
runs every dial through the validating lookup. It executes no page
script and its screenshot is a one-pixel marker; it is an HTTP
stand-in, not a rendered browser. A real integration supplies a
driver backed by a browser engine that enforces the same contract
inside its own engine — the adapter and the flows above it do not
change.

Redirect and dependency enforcement is covered by loopback tests with
counting servers: a forbidden origin sees zero requests, multi-hop
and relative redirects cannot bypass the list, and the address filter
is tested against crafted IPv4, IPv6, and mapped answers.
