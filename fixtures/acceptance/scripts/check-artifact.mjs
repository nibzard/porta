// The artifact checker (acceptance fixture).
//
// Usage: node scripts/check-artifact.mjs REPORT.json [REPORT.json ...]
//
// Validates each report against verification/artifact.schema.json by
// the rules below (kept inline so the checker runs anywhere node
// runs) and fails any report whose checks are not all passed. Exit 0
// means every report is a valid, fully passed verification artifact.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = JSON.parse(
  await readFile(join(root, "verification", "artifact.schema.json"), "utf8"),
);
const revisions = schema.properties.workspaceRevisionId.pattern;

const allowedTop = new Set(Object.keys(schema.properties));
const allowedProducer = new Set(Object.keys(schema.properties.producedBy.properties));
const allowedCheck = new Set(Object.keys(schema.properties.checks.items.properties));

function problemsOf(report, file) {
  const problems = [];
  const at = (rule) => `${file}: ${rule}`;
  if (report.schemaVersion !== 1) {
    problems.push(at("schemaVersion must be 1"));
  }
  if (report.kind !== "verification") {
    problems.push(at("kind must be verification"));
  }
  if (
    typeof report.workspaceRevisionId !== "string" ||
    !new RegExp(revisions).test(report.workspaceRevisionId)
  ) {
    problems.push(at(`workspaceRevisionId must match ${revisions}`));
  }
  for (const key of Object.keys(report)) {
    if (!allowedTop.has(key)) {
      problems.push(at(`unexpected field ${key}`));
    }
  }
  if (report.recordedAt !== undefined && typeof report.recordedAt !== "string") {
    problems.push(at("recordedAt must be a string"));
  }
  if (report.producedBy !== undefined) {
    const producer = report.producedBy;
    if (producer === null || typeof producer !== "object" || Array.isArray(producer)) {
      problems.push(at("producedBy must be an object"));
    } else {
      if (typeof producer.attachmentId !== "string" || producer.attachmentId.length < 1) {
        problems.push(at("producedBy.attachmentId must be a nonempty string"));
      }
      for (const key of Object.keys(producer)) {
        if (!allowedProducer.has(key)) {
          problems.push(at(`producedBy has unexpected field ${key}`));
        }
      }
    }
  }
  if (!Array.isArray(report.checks) || report.checks.length < 1) {
    problems.push(at("checks must be a nonempty array"));
    return problems;
  }
  for (const [index, check] of report.checks.entries()) {
    if (check === null || typeof check !== "object" || Array.isArray(check)) {
      problems.push(at(`checks[${index}] must be an object`));
      continue;
    }
    if (typeof check.name !== "string" || check.name.length < 1) {
      problems.push(at(`checks[${index}].name must be a nonempty string`));
    }
    if (typeof check.passed !== "boolean") {
      problems.push(at(`checks[${index}].passed must be a boolean`));
    }
    if (check.passed !== true) {
      problems.push(at(`checks[${index}] (${check.name ?? "?"}) did not pass`));
    }
    for (const key of Object.keys(check)) {
      if (!allowedCheck.has(key)) {
        problems.push(at(`checks[${index}] has unexpected field ${key}`));
      }
    }
  }
  return problems;
}

const files = process.argv.slice(2);
if (files.length < 1) {
  console.error("usage: node scripts/check-artifact.mjs REPORT.json [REPORT.json ...]");
  process.exit(2);
}

let failures = 0;
for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    console.error(`${file}: not readable JSON (${error.message})`);
    failures += 1;
    continue;
  }
  const problems = problemsOf(parsed, file);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    failures += 1;
  } else {
    console.log(`${file}: verified ${parsed.workspaceRevisionId}`);
  }
}
process.exit(failures > 0 ? 1 : 0);
