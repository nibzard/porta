import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import {
  BrowserNetworkBlockedError,
  browserUrlDenial,
  isPrivateAddress,
} from "./browser-adapter.js";
import type {
  BrowserDriver,
  BrowserDriverCapture,
  BrowserDriverCreate,
  BrowserDriverNavigation,
  BrowserDriverObservation,
  BrowserDriverSession,
  BrowserNetworkRules,
} from "./browser-adapter.js";
import type { BrowserWaitUntil } from "../runtime/browser-capability.js";

/**
 * The reference HTTP browser driver (SPEC.md sections 14.4 and 17).
 *
 * This driver loads documents over HTTP and follows the data endpoint
 * each page declares through a literal `fetch("...")` call. It
 * executes no page script, so its observation of a page is the
 * document plus the data the page's script would bind, never a
 * rendered view. A real integration supplies a driver backed by a
 * browser engine; the adapter and the flows above it do not change.
 *
 * Every network channel it opens runs the session's rules *before*
 * the request leaves: the navigation itself, every redirect hop, and
 * every declared dependency. Redirects are followed manually with a
 * finite limit, because a transport that follows redirects itself
 * checks nothing between hops. Private ranges are refused twice — by
 * name and literal address before the dial, and by every DNS answer
 * the dial would use — so a resolution that returns only private
 * addresses connects nowhere.
 */

/** Redirect hops one navigation follows before it refuses the chain. */
const MAX_REDIRECTS = 10;

/** One page this driver loaded, with the data endpoint it declared. */
export interface StandinPageRecord {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  title: string;
  /** What each `fetch("...")` in the page returned, keyed by path. */
  dataEndpoints: Record<string, unknown>;
}

/** The browser driver of the automated demonstration. */
export class HttpBrowserDriver implements BrowserDriver {
  readonly networkEnforcement = "origin-allowlist" as const;
  private counter = 0;
  private readonly byProviderSession = new Map<string, StandinSession>();

  /** Every page every session of this driver loaded, in order. */
  pages(): StandinPageRecord[] {
    const records: StandinPageRecord[] = [];
    for (const session of this.byProviderSession.values()) {
      records.push(...session.pages);
    }
    return records;
  }

  async createSession(input: BrowserDriverCreate): Promise<BrowserDriverSession> {
    const session = new StandinSession(
      `standin-${(this.counter += 1)}`,
      input.network,
    );
    this.byProviderSession.set(session.providerSessionId, session);
    return session;
  }
}

/** One request this driver made, with the response it got. */
interface DriverResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * One DNS answer this driver refused to dial. Marked so the request
 * layer can report it as a structured denial, not a transport fault.
 */
class AddressRejectedError extends Error {
  constructor(readonly hostname: string) {
    super(`Every resolved address of ${hostname} is a blocked range.`);
    this.name = "AddressRejectedError";
  }
}

/** One session of the reference driver. */
class StandinSession implements BrowserDriverSession {
  readonly pages: StandinPageRecord[] = [];
  private closed = false;

  constructor(
    readonly providerSessionId: string,
    private readonly network: BrowserNetworkRules,
  ) {}

  async navigate(url: string, waitUntil: BrowserWaitUntil): Promise<BrowserDriverNavigation> {
    void waitUntil;
    const document = await this.load(this.target(url), MAX_REDIRECTS);
    const dataEndpoints: Record<string, unknown> = {};
    for (const path of declaredFetchPaths(document.body)) {
      // A dependency resolves against the FINAL document URL; a page
      // moved by redirect binds its data where it landed.
      const target = this.target(path, document.finalUrl);
      const data = await this.fetch(target);
      dataEndpoints[path] =
        data.status === 200 ? safeJson(data.body) : { status: data.status };
    }
    this.pages.push({
      requestedUrl: url,
      finalUrl: document.finalUrl.href,
      status: document.status,
      title: titleOf(document.body),
      dataEndpoints,
    });
    return { finalUrl: document.finalUrl.href, status: document.status };
  }

  async screenshot(): Promise<BrowserDriverCapture> {
    // A one-pixel marker, not a rendering: this driver draws nothing.
    return {
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
      truncated: false,
    };
  }

  async observe(): Promise<BrowserDriverObservation> {
    const last = this.pages.at(-1);
    return this.closed
      ? { state: "closed" }
      : {
          state: "active",
          ...(last === undefined ? {} : { url: last.finalUrl, title: last.title }),
        };
  }

  async close(): Promise<boolean> {
    const wasLive = !this.closed;
    this.closed = true;
    return wasLive;
  }

  /** Parse and admit one URL, resolving it against a base when given. */
  private target(url: string, base?: URL): URL {
    const resolved = base === undefined ? new URL(url) : new URL(url, base.href);
    const denial = browserUrlDenial(resolved, this.network);
    if (denial !== null) {
      throw new BrowserNetworkBlockedError(resolved.href, denial);
    }
    return resolved;
  }

  /** Follow redirects manually, admitting every hop before it dials. */
  private async load(
    target: URL,
    hopsLeft: number,
  ): Promise<{ finalUrl: URL; status: number; body: string }> {
    const response = await this.fetch(target);
    const location = redirectLocation(response.status, response.headers.location);
    if (location === null) {
      return { finalUrl: target, status: response.status, body: response.body };
    }
    if (hopsLeft <= 0) {
      throw new BrowserNetworkBlockedError(target.href, "too-many-redirects");
    }
    return this.load(this.target(location, target), hopsLeft - 1);
  }

  /**
   * One request through the controlled transport. When the rules
   * block private ranges, the dial resolves through the validating
   * lookup below: the addresses a socket may dial and the addresses
   * the rules admitted are the same list, so a name cannot resolve
   * clean at check time and private at connect time.
   */
  private async fetch(target: URL): Promise<DriverResponse> {
    return await new Promise<DriverResponse>((resolve, reject) => {
      const transport = target.protocol === "https:" ? httpsGet : httpGet;
      const request = transport(
        target.href,
        { lookup: this.network.blockPrivateRanges ? enforcedLookup : undefined },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.on("error", (error) => {
        reject(
          error instanceof AddressRejectedError
            ? new BrowserNetworkBlockedError(target.href, "address-rejected")
            : error,
        );
      });
      request.end();
    });
  }
}

/** Redirect destination of one response, or null when it is final. */
function redirectLocation(
  status: number,
  location: string | string[] | undefined,
): string | null {
  if (
    (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) ||
    location === undefined
  ) {
    return null;
  }
  return Array.isArray(location) ? (location[0] ?? null) : location;
}

/**
 * The validating lookup every dial runs under private-range blocking.
 *
 * Resolution and connection share this one callback: the filtered
 * list it returns is exactly the list the socket may dial, so a DNS
 * answer that turns private between the check and the connection has
 * nowhere to land.
 */
function enforcedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  void options;
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, []);
      return;
    }
    const admitted = filterResolvedAddresses(addresses, true);
    if (admitted === null) {
      callback(new AddressRejectedError(hostname), []);
      return;
    }
    callback(null, admitted);
  });
}

/**
 * Filter one resolution's answers under the rules. Public addresses
 * survive; private answers are dropped even beside a public one. A
 * list with nothing public denies the connection — exported so the
 * filter itself is testable against crafted answers.
 */
export function filterResolvedAddresses(
  addresses: LookupAddress[],
  blockPrivateRanges: boolean,
): LookupAddress[] | null {
  if (!blockPrivateRanges) {
    return addresses;
  }
  const admitted = addresses.filter((entry) => !isPrivateAddress(entry.address));
  return admitted.length > 0 ? admitted : null;
}

/** The title element of one page, when the page carries one. */
function titleOf(html: string): string {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
}

/** Every literal `fetch("...")` path one page declares. */
function declaredFetchPaths(html: string): string[] {
  const paths: string[] = [];
  for (const match of html.matchAll(/fetch\("([^"]+)"\)/g)) {
    const path = match[1];
    if (path !== undefined && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/** Parse JSON, keeping a malformed body as text instead of throwing. */
function safeJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { body };
  }
}
