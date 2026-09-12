// The native data integrity test (acceptance fixture).
//
// Runs under real process execution: it hashes the dataset, checks
// its shape, and renders the anomaly row through the dependency the
// recipes install. Any failure exits nonzero.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReading, parseReading, summarize } from "acme-format";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const EXPECTED_SHA256 = "7c61960f56c5d5114594fbc0b83283fe21ed298420ed0452a271251c5825bdab";
const EXPECTED_COUNT = 10;

const raw = await readFile(join(root, "data", "readings.csv"), "utf8");
const digest = createHash("sha256").update(raw, "utf8").digest("hex");
if (digest !== EXPECTED_SHA256) {
  throw new Error(`readings.csv digest moved: ${digest}`);
}

const lines = raw.trim().split("\n");
if (lines[0] !== "sensor,timestamp,value") {
  throw new Error(`unexpected header: ${lines[0]}`);
}
const readings = lines.slice(1).map((line) => parseReading(line));
const summary = summarize(readings.map((reading) => reading.value));
if (summary.count !== EXPECTED_COUNT) {
  throw new Error(`expected ${EXPECTED_COUNT} rows, saw ${summary.count}`);
}
if (summary.anomalies !== 1) {
  throw new Error(`expected one anomaly, saw ${summary.anomalies}`);
}

const anomaly = readings.find((reading) => reading.value > 10);
const rendered = formatReading(anomaly);
if (rendered !== "sensor bravo read 47.5 at 2026-09-01T00:02:00Z") {
  throw new Error(`unexpected anomaly rendering: ${rendered}`);
}

console.log("data ok");
