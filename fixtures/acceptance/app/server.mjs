// The dashboard application server (acceptance fixture).
//
// Started by recipes/server.json. Binds 127.0.0.1 on --port (0 asks
// the platform for a free port) and prints one "dashboard-ready" line
// carrying the bound port as JSON; the recipe's readySignal matches
// that line. Serves the dashboard page, the summary API, and a
// health probe.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReading, summarize } from "acme-format";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function argumentsOf(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    parsed[argv[index]] = argv[index + 1];
  }
  return parsed;
}

const asked = argumentsOf(process.argv.slice(2));
const port = Number.parseInt(asked["--port"] ?? "4700", 10);

const lines = (await readFile(join(root, "data", "readings.csv"), "utf8"))
  .trim()
  .split("\n");
const values = lines.slice(1).map((line) => parseReading(line).value);
const summary = summarize(values);

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    if (request.url === "/api/summary") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(summary));
      return;
    }
    if (request.url === "/") {
      const page = await readFile(join(root, "app", "dashboard.html"), "utf8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  const bound = server.address();
  console.log(`dashboard-ready ${JSON.stringify({ port: bound.port })}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}
