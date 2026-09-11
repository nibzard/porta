import { VERSION } from "../index.js";

/** Output sinks for the CLI. Tests install recording sinks. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = [
  "Usage: portable <command> [options]",
  "",
  "The version-one commands are specified in SPEC.md section 16 and arrive",
  "with the library milestones. The bootstrap CLI supports:",
  "",
  "  -h, --help     Show this help.",
  "  -v, --version  Print the Portable library version.",
  "",
  "Exit codes: 0 success, 1 known failure, 2 invalid input, 3 unknown outcome.",
].join("\n");

/**
 * Run the CLI with the given arguments and return the process exit code.
 *
 * The exit code convention follows SPEC.md section 16: code 2 marks invalid
 * input such as an unknown command or unexpected extra arguments.
 */
export function runCli(args: readonly string[], io: CliIo): number {
  const first = args[0];

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    if (args.length > 1) {
      io.err(`Unexpected argument after ${first ?? "help"}: ${args[1]}`);
      return 2;
    }
    io.out(USAGE);
    return 0;
  }

  if (first === "--version" || first === "-v") {
    if (args.length > 1) {
      io.err(`Unexpected argument after ${first}: ${args[1]}`);
      return 2;
    }
    io.out(VERSION);
    return 0;
  }

  io.err(`Unknown command or option: ${first}`);
  io.err(USAGE);
  return 2;
}
