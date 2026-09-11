import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../index.js";

const execFileAsync = promisify(execFile);

test("compiled bin entry prints the library version", async () => {
  // Compiled test lives at dist/cli/main.e2e.test.js, next to main.js.
  const mainUrl = new URL("./main.js", import.meta.url);
  const { stdout, stderr } = await execFileAsync(process.execPath, [mainUrl.pathname, "--version"]);
  assert.equal(stdout.trim(), VERSION);
  assert.equal(stderr, "");
});
