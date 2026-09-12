import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ControlStore } from "../store/control-store.js";
import { BlobStore } from "../store/blob-store.js";
import { PolicyAuthority } from "../core/policy.js";
import { invalidRequestError } from "../core/errors.js";
import type { PortablePolicy } from "../schema/policy.js";
import type { PortableError } from "../schema/error.js";
import type { EnvironmentAdapter } from "../schema/adapter.js";

/**
 * CLI configuration (SPEC.md section 16).
 *
 * Every value is explicit: the store comes from `--store` or the
 * documented `PORTABLE_STORE` variable, the policy document from
 * `--policy-file` or `PORTABLE_POLICY`, the session from `--session`
 * or `PORTABLE_SESSION`. Nothing is discovered by scanning, and a
 * session is never guessed among several.
 *
 * Requests and secrets travel in files or on standard input. No
 * command needs shell interpolation of JSON.
 */

/** The resolved configuration of one CLI invocation. */
export interface CliConfig {
  /** The control store database file. */
  storePath: string;
  /** The policy document file, when a command needs an authority. */
  policyPath?: string;
  /** The session identifier, when a command scopes to one session. */
  sessionId?: string;
}

/** Options the caller captured from arguments and the environment. */
export interface CliConfigInput {
  storePath?: string;
  policyPath?: string;
  sessionId?: string;
}

/** Resolve one configuration from arguments over the environment. */
export function resolveConfig(input: CliConfigInput): CliConfig {
  const storePath = input.storePath ?? process.env["PORTABLE_STORE"];
  if (storePath === undefined || storePath === "") {
    throw usageError(
      "No control store named. Pass --store PATH or set PORTABLE_STORE.",
    );
  }
  const policyPath = input.policyPath ?? process.env["PORTABLE_POLICY"];
  const sessionId = input.sessionId ?? process.env["PORTABLE_SESSION"];
  return {
    storePath: resolve(storePath),
    ...(policyPath !== undefined && policyPath !== ""
      ? { policyPath: resolve(policyPath) }
      : {}),
    ...(sessionId !== undefined && sessionId !== ""
      ? { sessionId }
      : {}),
  };
}

/** One opened store and its blob store, beside the same base name. */
export interface OpenedStore {
  store: ControlStore;
  blobs: BlobStore;
}

/** Open the control store and its blob store for one invocation. */
export function openStore(config: CliConfig): OpenedStore {
  const store = ControlStore.open(config.storePath);
  return { store, blobs: BlobStore.beside(config.storePath, store) };
}

/**
 * Load the policy authority of one invocation.
 *
 * The policy document is operator-supplied configuration, read from
 * its file: model-controlled input never supplies authority.
 */
export function loadAuthority(config: CliConfig): PolicyAuthority {
  if (config.policyPath === undefined) {
    throw usageError(
      "This command needs a policy authority. Pass --policy-file PATH or set PORTABLE_POLICY.",
    );
  }
  return PolicyAuthority.fromPolicy(readJsonFile(config.policyPath) as unknown as PortablePolicy);
}

/** The session one command runs against, explicit or documented. */
export function requireSession(config: CliConfig): string {
  if (config.sessionId === undefined) {
    throw usageError(
      "No session named. Pass --session SESSION or set PORTABLE_SESSION; the CLI never guesses among sessions.",
    );
  }
  return config.sessionId;
}

/**
 * Load one adapter module.
 *
 * The module must export `adapter` as an instance implementing the
 * adapter contract. Loading a module is configuration, not input: the
 * path names operator-supplied code.
 */
export async function loadAdapter(modulePath: string): Promise<EnvironmentAdapter> {
  const url = pathToFileURL(resolve(modulePath)).href;
  let module: Record<string, unknown>;
  try {
    module = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    throw usageError(`The adapter module ${modulePath} did not load.`, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const candidate = module["adapter"];
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as { acquire?: unknown }).acquire !== "function"
  ) {
    throw usageError(
      `The adapter module ${modulePath} exports no \`adapter\` implementing the adapter contract.`,
    );
  }
  return candidate as EnvironmentAdapter;
}

/**
 * Read one structured request.
 *
 * A path names a file; `-` reads standard input. JSON never needs
 * shell interpolation.
 */
export function readRequest(source: string): Record<string, unknown> {
  if (source === "-") {
    return parseJson(readStdin(), "standard input");
  }
  return readJsonFile(source);
}

/** A usage or configuration error: the CLI exits with code 2. */
export function usageError(message: string, details?: Record<string, unknown>): PortableError {
  return invalidRequestError(message, details);
}

/** Read all of standard input synchronously. */
function readStdin(): string {
  return readFileSync(0, "utf8");
}

/** Parse JSON, reporting a usage error for invalid content. */
function parseJson(text: string, origin: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw usageError(`The request on ${origin} is not valid JSON.`, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(`The request on ${origin} must be one JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** Read and parse one JSON file. */
function readJsonFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw usageError(`The file ${path} does not exist or does not read.`);
  }
  return parseJson(text, path);
}
