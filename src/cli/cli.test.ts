import test from "node:test";
import assert from "node:assert/strict";
import { runCli, USAGE } from "./cli.js";
import { VERSION } from "../index.js";

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out(line: string): void {
        out.push(line);
      },
      err(line: string): void {
        err.push(line);
      },
    },
  };
}

test("--version prints the library version and exits 0", () => {
  const rec = recordingIo();
  const code = runCli(["--version"], rec.io);
  assert.equal(code, 0);
  assert.deepEqual(rec.out, [VERSION]);
  assert.deepEqual(rec.err, []);
});

test("-v prints the library version and exits 0", () => {
  const rec = recordingIo();
  assert.equal(runCli(["-v"], rec.io), 0);
  assert.deepEqual(rec.out, [VERSION]);
});

test("--help prints usage and exits 0", () => {
  const rec = recordingIo();
  const code = runCli(["--help"], rec.io);
  assert.equal(code, 0);
  assert.deepEqual(rec.out, [USAGE]);
  assert.deepEqual(rec.err, []);
});

test("no arguments prints usage and exits 0", () => {
  const rec = recordingIo();
  assert.equal(runCli([], rec.io), 0);
  assert.deepEqual(rec.out, [USAGE]);
});

test("unknown command writes diagnostics to stderr and exits 2", () => {
  const rec = recordingIo();
  const code = runCli(["frobnicate"], rec.io);
  assert.equal(code, 2);
  assert.deepEqual(rec.out, []);
  assert.ok(rec.err[0]?.includes("Unknown command or option: frobnicate"));
});

test("extra arguments after --version exit 2", () => {
  const rec = recordingIo();
  assert.equal(runCli(["--version", "--json"], rec.io), 2);
  assert.deepEqual(rec.out, []);
  assert.ok(rec.err[0]?.includes("Unexpected argument"));
});
