#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCli } from "./cli.js";

/** True when this module is the process entry point, not an import. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const io = {
    out(line: string): void {
      process.stdout.write(`${line}\n`);
    },
    err(line: string): void {
      process.stderr.write(`${line}\n`);
    },
  };
  process.exitCode = runCli(process.argv.slice(2), io);
}
