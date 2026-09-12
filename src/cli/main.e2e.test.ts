import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../index.js";

const execFileAsync = promisify(execFile);

test("compiled bin entry prints the library version", async () => {
  // Compiled test lives at dist/cli/main.e2e.test.js, next to main.js.
  const mainUrl = new URL("./main.js", import.meta.url);
  const { stdout, stderr } = await execFileAsync(process.execPath, [mainUrl.pathname, "--version"]);
  assert.equal(stdout.trim(), VERSION);
  assert.equal(stderr, "");
});

test("extra command words exit 2 and create no database", async () => {
  const mainUrl = new URL("./main.js", import.meta.url);
  const root = mkdtempSync(join(tmpdir(), "porta-e2e-"));
  try {
    const db = join(root, "control.db");
    const run = spawnSync(process.execPath, [
      mainUrl.pathname,
      "session",
      "create",
      "accidental-extra-word",
      "--policy-ref",
      "policy://review",
      "--store",
      db,
    ]);
    assert.equal(run.status, 2);
    assert.ok(run.stderr.toString().includes("Unknown command"));
    assert.equal(existsSync(db), false, "no database file may appear");
    assert.equal(existsSync(join(root, "blobs")), false, "no blob store may appear");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
