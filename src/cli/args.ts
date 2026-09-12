/**
 * Command-line grammar of the Portable CLI (SPEC.md section 16).
 *
 * One command is a word path (`session create`, `operation inspect`)
 * plus valued options and two boolean options, `--json` everywhere
 * and `--plan` on `replace`. Nothing here interprets values; the
 * command implementations own the contracts.
 */

/** Options every command accepts: configuration, not command input. */
const CONFIG_FLAGS = ["--store", "--policy-file", "--session"];

/** One command's option requirements. */
export interface CommandSpec {
  /** Options the command refuses to run without. */
  requires: readonly string[];
  /** Optional command-specific options. */
  extras: readonly string[];
  /** Boolean options the command accepts; `--json` applies everywhere. */
  booleans: readonly string[];
}

/** The boolean options every command accepts. */
const ANY_BOOLEAN = ["--json"];

/** The full command table. */
const COMMANDS: ReadonlyMap<string, CommandSpec> = new Map([
  ["session create", { requires: ["--policy-ref"], extras: ["--workspace"], booleans: ANY_BOOLEAN }],
  ["describe", { requires: [], extras: [], booleans: ANY_BOOLEAN }],
  [
    "checkpoint",
    { requires: ["--request", "--stability"], extras: ["--stability-detail"], booleans: ANY_BOOLEAN },
  ],
  [
    "materialize",
    { requires: ["--revision", "--destination", "--mode", "--policy-file"], extras: [], booleans: ANY_BOOLEAN },
  ],
  [
    "attach",
    {
      requires: ["--request", "--request-key", "--adapter", "--principal", "--policy-file"],
      extras: [],
      booleans: ANY_BOOLEAN,
    },
  ],
  ["invoke", { requires: ["--request", "--policy-file"], extras: [], booleans: ANY_BOOLEAN }],
  ["operation inspect", { requires: ["--operation"], extras: [], booleans: ANY_BOOLEAN }],
  ["operation cancel", { requires: ["--operation", "--adapter"], extras: [], booleans: ANY_BOOLEAN }],
  [
    "workspace propose",
    {
      requires: ["--attachment", "--generation", "--copy", "--request-key", "--stability"],
      extras: ["--stability-detail"],
      booleans: ANY_BOOLEAN,
    },
  ],
  ["workspace accept", { requires: ["--proposal", "--expected-head"], extras: [], booleans: ANY_BOOLEAN }],
  [
    "replace",
    { requires: ["--request"], extras: [], booleans: ["--json", "--plan"] },
  ],
  [
    "release",
    {
      requires: ["--attachment", "--generation", "--request-key", "--adapter", "--principal"],
      extras: [],
      booleans: ANY_BOOLEAN,
    },
  ],
  ["events", { requires: [], extras: ["--after"], booleans: ANY_BOOLEAN }],
  ["recover", { requires: [], extras: [], booleans: ANY_BOOLEAN }],
  [
    "conformance",
    {
      requires: ["--adapter", "--adapter-version"],
      extras: ["--profile", "--principal", "--policy-ref", "--case-timeout-ms"],
      booleans: ["--json", "--external-effects", "--paid-allocation"],
    },
  ],
]);

/** Boolean options: they take no value. */
const BOOLEAN_FLAGS = new Set([
  "--json",
  "--plan",
  "--external-effects",
  "--paid-allocation",
]);

/** One parsed invocation. */
export interface ParsedArguments {
  /** The command words, longest known match first. */
  words: string[];
  /** Valued options that are not configuration. */
  values: Map<string, string>;
  /** Configuration options. */
  config: Map<string, string>;
  /** Boolean options that appeared. */
  booleans: Set<string>;
}

/** The longest known command the leading words name, or null. */
function matchCommand(words: readonly string[]): { spec: CommandSpec; words: string[] } | null {
  for (let take = Math.min(words.length, 3); take >= 1; take -= 1) {
    const spec = COMMANDS.get(words.slice(0, take).join(" "));
    if (spec !== undefined) {
      return { spec, words: words.slice(0, take) };
    }
  }
  return null;
}

/**
 * Parse one argument list.
 *
 * Command words come first; options follow. The matched command must
 * consume every command word, and a boolean option must belong to the
 * matched command. Returns a diagnostic string on invalid grammar; the
 * caller turns it into exit code 2 before any store opens.
 */
export function parseArguments(args: readonly string[]): string | ParsedArguments {
  const words: string[] = [];
  const values = new Map<string, string>();
  const config = new Map<string, string>();
  const booleans = new Set<string>();
  let sawFlag = false;
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if (token.startsWith("--")) {
      sawFlag = true;
      if (BOOLEAN_FLAGS.has(token)) {
        booleans.add(token);
        index += 1;
        continue;
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return `Option ${token} needs a value.`;
      }
      if (CONFIG_FLAGS.includes(token)) {
        config.set(token, value);
      } else {
        values.set(token, value);
      }
      index += 2;
      continue;
    }
    if (sawFlag) {
      return `Unexpected argument ${token}.`;
    }
    words.push(token);
    index += 1;
  }
  const matched = matchCommand(words);
  if (matched === null || matched.words.length !== words.length) {
    return `Unknown command or option: ${words.join(" ") || args[0]}`;
  }
  const command = matched.words.join(" ");
  for (const flag of booleans) {
    if (!matched.spec.booleans.includes(flag)) {
      return `Option ${flag} does not apply to ${command}.`;
    }
  }
  return { words: matched.words, values, config, booleans };
}

/** The command spec of one word path, or undefined when unknown. */
export function usageFor(words: readonly string[]): CommandSpec | undefined {
  const matched = matchCommand(words);
  return matched === null ? undefined : matched.spec;
}

/** The usage text (SPEC.md section 16). */
export function commandUsage(): string {
  return [
    "Usage: portable <command> [options]",
    "",
    "Configuration: --store PATH or PORTABLE_STORE; --policy-file PATH or",
    "PORTABLE_POLICY; --session SESSION or PORTABLE_SESSION. A session is",
    "never guessed among several. Requests travel in files or on standard",
    "input (-); no command needs shell interpolation of JSON or secrets.",
    "",
    "Standard output carries machine records, one JSON object per line for",
    "streams. Diagnostics go to standard error. Records are the only",
    "output format; --json is accepted everywhere.",
    "",
    "Exit codes: 0 success, 1 known failure, 2 invalid input, 3 unknown outcome.",
    "",
    "Commands:",
    "  session create --policy-ref REF [--workspace DIR]",
    "  describe",
    "  checkpoint --request FILE|- --stability locked|snapshot",
    "             [--stability-detail TEXT]",
    "  materialize --revision ID --destination DIR --mode read-only|proposal",
    "             --policy-file PATH",
    "  attach --request FILE|- --request-key KEY --adapter MODULE",
    "           --principal NAME --policy-file PATH",
    "  invoke --request FILE|- --policy-file PATH",
    "  operation inspect --operation ID",
    "  operation cancel --operation ID --adapter MODULE",
    "  workspace propose --attachment ID --generation N --copy ID --request-key KEY",
    "             --stability locked|snapshot [--stability-detail TEXT]",
    "  workspace accept --proposal ID --expected-head REVISION",
    "  replace --request FILE|- [--plan]",
    "  release --attachment ID --generation N --request-key KEY",
    "           --adapter MODULE --principal NAME",
    "  events [--after SEQUENCE]",
    "  recover",
    "  conformance --adapter MODULE --adapter-version VERSION",
    "             [--profile NAME[,NAME ...]] [--principal NAME]",
    "             [--policy-ref REF] [--case-timeout-ms N]",
    "             [--external-effects] [--paid-allocation]",
    "",
    "The checkpoint, attach, invoke, and replace request files hold one",
    "JSON object each. The replace file wraps a replacement request in",
    "`request` and its destination flow in `destination` (adapterModule,",
    "copyRoot, principal). Adapter modules export `adapter`. The",
    "conformance command runs the case packs against the loaded adapter;",
    "effect and payment grants default refused, and a run with skips",
    "exits 3 exactly as an unestablished outcome should.",
    "  -h, --help     Show this help.",
    "  -v, --version  Print the Portable library version.",
  ].join("\n");
}
