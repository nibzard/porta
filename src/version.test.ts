import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "./version.js";

test("library VERSION matches package.json", () => {
  // Compiled test lives at dist/version.test.js, so the package root is one
  // level above the compiled file.
  const packageUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(packageUrl, "utf8")) as { version?: string };
  assert.equal(VERSION, pkg.version);
});
