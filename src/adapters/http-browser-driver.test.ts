import test from "node:test";
import assert from "node:assert/strict";
import type { RequestListener, Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { HttpBrowserDriver } from "./http-browser-driver.js";
import { BrowserNetworkBlockedError } from "./browser-adapter.js";
import type { BrowserDriverSession, BrowserNetworkRules } from "./browser-adapter.js";
import { filterResolvedAddresses } from "./http-browser-driver.js";

/** One counting loopback server. */
interface Loopback {
  origin: string;
  hits: () => number;
  close: () => Promise<void>;
}

async function loopback(handler: RequestListener): Promise<Loopback> {
  let count = 0;
  const server: Server = createServer((request, response) => {
    count += 1;
    handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits: () => count,
    close: async () => {
      server.close();
      await once(server, "close").catch(() => undefined);
    },
  };
}

/** Capture the denial of one navigation instead of throwing it. */
async function denial(
  run: () => Promise<unknown>,
): Promise<{ url: string; reason: string } | null> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BrowserNetworkBlockedError) {
      return { url: error.url, reason: error.reason };
    }
    throw error;
  }
  return null;
}

/** One session under one rule set. */
async function sessionUnder(
  rules: BrowserNetworkRules,
): Promise<{ driver: HttpBrowserDriver; session: BrowserDriverSession }> {
  const driver = new HttpBrowserDriver();
  const session = await driver.createSession({ network: rules });
  return { driver, session };
}

test("an allowed origin redirecting to a forbidden origin never reaches it", async () => {
  const forbidden = await loopback((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><title>forbidden</title></html>");
  });
  const allowed = await loopback((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `${forbidden.origin}/landing` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><title>allowed</title></html>");
  });
  try {
    const { session } = await sessionUnder({
      allowedOrigins: [allowed.origin],
      blockPrivateRanges: false,
    });
    const before = await session.navigate(`${allowed.origin}/page`, "load");
    assert.equal(before.finalUrl, `${allowed.origin}/page`);

    const blocked = await denial(() => session.navigate(`${allowed.origin}/redirect`, "load"));
    assert.deepEqual(blocked, {
      url: `${forbidden.origin}/landing`,
      reason: "origin-not-allowed",
    });
    assert.equal(forbidden.hits(), 0, "the forbidden server saw no request");

    // The blocked navigation left the session where it was.
    const observed = await session.observe();
    assert.equal(observed.state, "active");
    assert.equal(observed.url, `${allowed.origin}/page`);
  } finally {
    await allowed.close();
    await forbidden.close();
  }
});

test("multi-hop and relative redirects cannot bypass the allowlist", async () => {
  const forbidden = await loopback((_request, response) => {
    response.writeHead(200);
    response.end("secret");
  });
  const allowed = await loopback((request, response) => {
    if (request.url === "/hop1") {
      response.writeHead(302, { location: "hop2" });
      response.end();
      return;
    }
    if (request.url === "/hop2") {
      // Protocol-relative: it resolves against the forbidden origin.
      response.writeHead(302, {
        location: `//127.0.0.1:${new URL(forbidden.origin).port}/x`,
      });
      response.end();
      return;
    }
    if (request.url === "/chain1") {
      response.writeHead(302, { location: "/chain2" });
      response.end();
      return;
    }
    if (request.url === "/chain2") {
      response.writeHead(302, { location: `${forbidden.origin}/abs` });
      response.end();
      return;
    }
    if (request.url === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><title>hops</title></html>");
  });
  const friend = await loopback((request, response) => {
    if (request.url === "/landed") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><title>friend</title></html>");
      return;
    }
    if (request.url === "/hop") {
      response.writeHead(302, { location: `${friend.origin}/landed` });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  try {
    const { session } = await sessionUnder({
      allowedOrigins: [allowed.origin, friend.origin],
      blockPrivateRanges: false,
    });

    // A relative first hop stays allowed; the protocol-relative second
    // hop resolves to the forbidden origin and is denied before any
    // request leaves the driver.
    const relative = await denial(() => session.navigate(`${allowed.origin}/hop1`, "load"));
    assert.equal(relative?.reason, "origin-not-allowed");
    assert.equal(relative?.url.startsWith(forbidden.origin), true);
    assert.equal(forbidden.hits(), 0);

    // A three-hop chain is denied at the hop that leaves the list.
    const chained = await denial(() => session.navigate(`${allowed.origin}/chain1`, "load"));
    assert.equal(chained?.reason, "origin-not-allowed");
    assert.equal(chained?.url, `${forbidden.origin}/abs`);
    assert.equal(forbidden.hits(), 0);

    // A redirect chain that stays on the allowlist lands on its final
    // origin: enforcement does not over-block allowed work.
    const landed = await session.navigate(`${friend.origin}/hop`, "load");
    assert.equal(landed.finalUrl, `${friend.origin}/landed`);
    assert.equal(landed.status, 200);

    // A chain that never ends is refused, not followed forever.
    const loops = await denial(() => session.navigate(`${allowed.origin}/loop`, "load"));
    assert.equal(loops?.reason, "too-many-redirects");
  } finally {
    await allowed.close();
    await forbidden.close();
    await friend.close();
  }
});

test("forbidden dependencies never reach their destination", async () => {
  const forbidden = await loopback((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const allowed = await loopback((request, response) => {
    if (request.url === "/clean") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<html><title>clean</title><script>const d = await fetch("/local");</script></html>');
      return;
    }
    if (request.url === "/local") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === "/dirty") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<html><title>dirty</title><script>const d = await fetch("${forbidden.origin}/data");</script></html>`,
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  try {
    const { session } = await sessionUnder({
      allowedOrigins: [allowed.origin],
      blockPrivateRanges: false,
    });

    // A dependency on the allowed origin still binds its data.
    const clean = await session.navigate(`${allowed.origin}/clean`, "load");
    assert.equal(clean.finalUrl, `${allowed.origin}/clean`);

    // A dependency that leaves the list denies the navigation before
    // the request leaves the driver.
    const blocked = await denial(() => session.navigate(`${allowed.origin}/dirty`, "load"));
    assert.deepEqual(blocked, {
      url: `${forbidden.origin}/data`,
      reason: "origin-not-allowed",
    });
    assert.equal(forbidden.hits(), 0, "the forbidden server saw no request");
  } finally {
    await allowed.close();
    await forbidden.close();
  }
});

test("private addresses are refused at the URL and at the connection", async () => {
  const server = await loopback((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><title>loop</title></html>");
  });
  try {
    const { session } = await sessionUnder({
      // The origin list admits the loopback names; blocking private
      // ranges must still refuse them.
      allowedOrigins: [
        `http://localhost:${new URL(server.origin).port}`,
        `http://[::ffff:127.0.0.1]:${new URL(server.origin).port}`,
      ],
      blockPrivateRanges: true,
    });

    // A loopback name is refused before any connection opens.
    const name = await denial(() =>
      session.navigate(`http://localhost:${new URL(server.origin).port}/`, "load"),
    );
    assert.equal(name?.reason, "private-range");

    // An IPv4-mapped loopback address passes the plain hostname
    // spelling check and is refused by the address check at the
    // connection, before the request leaves.
    const mapped = await denial(() =>
      session.navigate(`http://[::ffff:127.0.0.1]:${new URL(server.origin).port}/`, "load"),
    );
    assert.equal(mapped?.reason, "address-rejected");
    assert.equal(server.hits(), 0, "no blocked address reached the server");
  } finally {
    await server.close();
  }
});

test("resolved addresses are filtered before any socket dials them", () => {
  // Public answers survive; every private answer is dropped even when
  // it arrives beside a public one, so the socket can dial only
  // validated addresses. A list with nothing public denies the
  // connection at resolution time.
  const all = [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
    { address: "fd00::1", family: 6 },
    { address: "::ffff:169.254.1.1", family: 6 },
  ];
  assert.deepEqual(filterResolvedAddresses(all, true), [{ address: "8.8.8.8", family: 4 }]);

  assert.equal(filterResolvedAddresses([
    { address: "10.1.2.3", family: 4 },
    { address: "fe80::1", family: 6 },
    { address: "::1", family: 6 },
  ], true), null);

  // Without the private-range block, nothing is filtered here.
  assert.deepEqual(filterResolvedAddresses(all, false), all);

  // Mapped public addresses are public; mapped private ones are not.
  assert.deepEqual(
    filterResolvedAddresses([
      { address: "::ffff:8.8.8.8", family: 6 },
      { address: "::ffff:10.0.0.1", family: 6 },
    ], true),
    [{ address: "::ffff:8.8.8.8", family: 6 }],
  );
});
