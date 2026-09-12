import { VERSION } from "../version.js";
import { ValidationError } from "../schema/validate.js";
import type { CliIo } from "./io.js";
import { openRuntimeCommand, configInputOf } from "./commands.js";
import { commandUsage, parseArguments, usageFor } from "./args.js";
import { resolvePolicyPath } from "./config.js";

/**
 * The Portable CLI (SPEC.md section 16).
 *
 * The CLI is thin: every command calls the same library contracts
 * the embedding application calls, and it implements no lifecycle
 * rules of its own. Standard output carries machine records, one
 * JSON object per line for streams; diagnostics go to standard
 * error. Exit codes: 0 success, 1 known failure, 2 invalid input or
 * configuration, 3 unresolved or unknown outcome.
 */

/** The usage text, printed by `--help` and by no arguments. */
export const USAGE = commandUsage();

/** Run the CLI with the given arguments and return the exit code. */
export async function runCli(args: readonly string[], io: CliIo): Promise<number> {
  if (args.length === 0) {
    io.out(USAGE);
    return 0;
  }
  const first = args[0]!;
  if (first === "--help" || first === "-h" || first === "help") {
    return alone(args, io, () => {
      io.out(USAGE);
      return 0;
    });
  }
  if (first === "--version" || first === "-v") {
    return alone(args, io, () => {
      io.out(VERSION);
      return 0;
    });
  }

  const parsed = parseArguments(args);
  if (typeof parsed === "string") {
    io.err(parsed);
    return 2;
  }
  const command = parsed.words.join(" ");
  const spec = usageFor(parsed.words);
  if (spec === undefined) {
    io.err(`Unknown command or option: ${command}`);
    return 2;
  }
  const allowed = new Set([...spec.requires, ...spec.extras]);
  for (const flag of parsed.values.keys()) {
    if (!allowed.has(flag)) {
      io.err(`Unknown option ${flag} for ${command}.`);
      return 2;
    }
  }
  const missing = spec.requires.filter((flag) => !parsed.values.has(flag));
  if (missing.length > 0) {
    io.err(`Missing required option ${missing.join(", ")} for ${command}.`);
    return 2;
  }
  // Required configuration resolves here, after grammar and before any
  // store opens: a policy command accepts its document from the flag or
  // from `PORTABLE_POLICY`, whichever names one (SPEC.md section 16).
  if (spec.requiresPolicy && resolvePolicyPath(configInputOf(parsed)) === undefined) {
    io.err("This command needs a policy authority. Pass --policy-file PATH or set PORTABLE_POLICY.");
    return 2;
  }

  try {
    return await openRuntimeCommand(parsed, io);
  } catch (error) {
    io.err(`portable: ${describe(error)}`);
    return exitCodeOf(error);
  }
}

/** Run one standalone option, refusing anything behind it. */
function alone(args: readonly string[], io: CliIo, body: () => number): number {
  if (args.length > 1) {
    io.err(`Unexpected argument ${args[1]}.`);
    return 2;
  }
  return body();
}

/** Map one thrown error onto the SPEC section 16 exit codes. */
export function exitCodeOf(error: unknown): number {
  if (error instanceof ValidationError) {
    return 2;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "OperationUnknown") {
    return 3;
  }
  if (code === "InvalidRequest") {
    return 2;
  }
  return 1;
}

/** One diagnostic line for one thrown error. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") {
    return message;
  }
  return String(error);
}
