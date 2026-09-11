import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { invalidRequestError } from "../core/errors.js";
import type { CapabilityDescriptor } from "../schema/capability.js";
import type { Sha256Hex } from "../schema/defs.js";
import { validateWorkspacePath } from "../store/workspace-tree.js";
import type { ControlStore } from "../store/control-store.js";
import { requireOpenSession } from "./workspace.js";
import type { WorkingCopyRecord } from "../schema/workspace.js";

/**
 * The `fs.workspace@1` capability (SPEC.md section 14.3).
 *
 * Five operations work against one authorized working copy: `list`,
 * `read`, `write`, `delete`, and `stat`. Every call validates its
 * path against the workspace path rules, mutations land only on
 * `proposal`-mode copies, and each write is atomic per file through a
 * temporary file and a rename. Multi-file atomic writes are not
 * guaranteed.
 *
 * Binary content moves under an explicit encoding: callers state
 * `utf-8` or `base64` on every read and write, and nothing is
 * sniffed. Revision creation and head acceptance stay with the
 * workspace coordinator; this capability holds no path to them.
 */

/** Identifier of the capability this module implements. */
export const WORKSPACE_CAPABILITY_ID = "fs.workspace@1";

/** Encodings a read or write may name explicitly. */
export type WorkspaceEncoding = "utf-8" | "base64";

/** Input of the `list` operation. */
export interface WorkspaceListInput {
  copyId: string;
  /** Subtree to list, relative to the copy root. Default: the root. */
  path?: string;
}

/** Input of the `read` operation. */
export interface WorkspaceReadInput {
  copyId: string;
  path: string;
  encoding: WorkspaceEncoding;
}

/** Input of the `write` operation. */
export interface WorkspaceWriteInput {
  copyId: string;
  path: string;
  content: string;
  encoding: WorkspaceEncoding;
  executable?: boolean;
}

/** Input of the `delete` operation. */
export interface WorkspaceDeleteInput {
  copyId: string;
  path: string;
  /** Directories remove recursively only when this is `true`. */
  recursive?: boolean;
}

/** Input of the `stat` operation. */
export interface WorkspaceStatInput {
  copyId: string;
  path: string;
}

/** One entry of a `list` result. */
export interface WorkspaceListedEntry {
  path: string;
  kind: "file" | "directory";
  executable: boolean;
  sizeBytes?: number;
}

/** Result of the `read` operation. */
export interface WorkspaceReadResult {
  content: string;
  encoding: WorkspaceEncoding;
  sizeBytes: number;
  contentHash: Sha256Hex;
  executable: boolean;
}

/** Result of the `write` operation. */
export interface WorkspaceWriteResult {
  sizeBytes: number;
  contentHash: Sha256Hex;
  executable: boolean;
}

/** Result of the `delete` operation. */
export interface WorkspaceDeleteResult {
  removed: boolean;
  kind: "file" | "directory";
}

/** Result of the `stat` operation. */
export interface WorkspaceStatResult {
  path: string;
  kind: "file" | "directory";
  executable: boolean;
  sizeBytes?: number;
  contentHash?: Sha256Hex;
  modifiedAt: string;
}

/**
 * The descriptor of `fs.workspace@1`.
 *
 * The operation table is the contract an environment or harness
 * matches against; the schemas state the exact shape of every input
 * and output, including the explicit encoding of binary content.
 */
export function workspaceCapabilityDescriptor(): CapabilityDescriptor {
  const pathProperty = { type: "string", minLength: 1, maxLength: 4096 };
  const encodingProperty = { enum: ["utf-8", "base64"] };
  return {
    id: WORKSPACE_CAPABILITY_ID,
    operations: {
      list: {
        inputSchema: {
          type: "object",
          required: ["copyId"],
          additionalProperties: false,
          properties: {
            copyId: { type: "string", minLength: 1, maxLength: 128 },
            path: pathProperty,
          },
        },
        outputSchema: {
          type: "object",
          required: ["entries"],
          additionalProperties: false,
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                required: ["path", "kind", "executable"],
                additionalProperties: false,
                properties: {
                  path: { type: "string", minLength: 1 },
                  kind: { enum: ["file", "directory"] },
                  executable: { type: "boolean" },
                  sizeBytes: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        },
        stateful: false,
        effects: "none",
        retry: "safe",
        cancellation: "unsupported",
        streaming: false,
      },
      read: {
        inputSchema: {
          type: "object",
          required: ["copyId", "path", "encoding"],
          additionalProperties: false,
          properties: {
            copyId: { type: "string", minLength: 1, maxLength: 128 },
            path: pathProperty,
            encoding: encodingProperty,
          },
        },
        outputSchema: {
          type: "object",
          required: ["content", "encoding", "sizeBytes", "contentHash", "executable"],
          additionalProperties: false,
          properties: {
            content: { type: "string" },
            encoding: encodingProperty,
            sizeBytes: { type: "integer", minimum: 0 },
            contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
            executable: { type: "boolean" },
          },
        },
        stateful: false,
        effects: "none",
        retry: "safe",
        cancellation: "unsupported",
        streaming: false,
      },
      write: {
        inputSchema: {
          type: "object",
          required: ["copyId", "path", "content", "encoding"],
          additionalProperties: false,
          properties: {
            copyId: { type: "string", minLength: 1, maxLength: 128 },
            path: pathProperty,
            content: { type: "string" },
            encoding: encodingProperty,
            executable: { type: "boolean" },
          },
        },
        outputSchema: {
          type: "object",
          required: ["sizeBytes", "contentHash", "executable"],
          additionalProperties: false,
          properties: {
            sizeBytes: { type: "integer", minimum: 0 },
            contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
            executable: { type: "boolean" },
          },
        },
        stateful: true,
        effects: "workspace",
        retry: "unsafe",
        cancellation: "unsupported",
        streaming: false,
      },
      delete: {
        inputSchema: {
          type: "object",
          required: ["copyId", "path"],
          additionalProperties: false,
          properties: {
            copyId: { type: "string", minLength: 1, maxLength: 128 },
            path: pathProperty,
            recursive: { type: "boolean" },
          },
        },
        outputSchema: {
          type: "object",
          required: ["removed", "kind"],
          additionalProperties: false,
          properties: {
            removed: { type: "boolean" },
            kind: { enum: ["file", "directory"] },
          },
        },
        stateful: true,
        effects: "workspace",
        retry: "unsafe",
        cancellation: "unsupported",
        streaming: false,
      },
      stat: {
        inputSchema: {
          type: "object",
          required: ["copyId", "path"],
          additionalProperties: false,
          properties: {
            copyId: { type: "string", minLength: 1, maxLength: 128 },
            path: pathProperty,
          },
        },
        outputSchema: {
          type: "object",
          required: ["path", "kind", "executable", "modifiedAt"],
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1 },
            kind: { enum: ["file", "directory"] },
            executable: { type: "boolean" },
            sizeBytes: { type: "integer", minimum: 0 },
            contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
            modifiedAt: { type: "string" },
          },
        },
        stateful: false,
        effects: "none",
        retry: "safe",
        cancellation: "unsupported",
        streaming: false,
      },
    },
    attributes: {
      binaryTransfer: "explicit-encoding",
      atomicWrites: "per-file",
      mutations: "proposal-copies-only",
    },
  };
}

/**
 * The `fs.workspace@1` operations bound to one session's copies.
 *
 * The session authorizes every call: the copy must be registered for
 * it, and the session must be open. The instance holds no authority
 * of its own — it cannot create revisions or move the workspace head.
 */
export class WorkspaceFiles {
  private readonly store: ControlStore;
  private readonly sessionId: string;

  constructor(store: ControlStore, sessionId: string) {
    this.store = store;
    this.sessionId = sessionId;
  }

  /** List one subtree of a copy, depth first, paths relative to the root. */
  list(input: WorkspaceListInput): { entries: WorkspaceListedEntry[] } {
    const copy = this.authorize(input.copyId, false);
    // An absent path names the whole copy; only a present path validates.
    const relative = input.path === undefined ? "" : this.checkedPath(input.path);
    const root = join(copy.rootPath, relative);
    if (!existsSync(root)) {
      throw missingPath(copy.id, relative);
    }
    const entries: WorkspaceListedEntry[] = [];
    const visit = (directory: string, prefix: string): void => {
      for (const dirent of readdirSync(directory, { withFileTypes: true })) {
        const path = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
        if (dirent.isDirectory()) {
          entries.push({ path, kind: "directory", executable: false });
          visit(join(directory, dirent.name), path);
          continue;
        }
        const info = statSync(join(directory, dirent.name));
        entries.push({
          path,
          kind: "file",
          executable: (info.mode & 0o111) !== 0,
          sizeBytes: info.size,
        });
      }
    };
    visit(root, relative);
    return { entries };
  }

  /** Read one file under the encoding the caller names explicitly. */
  read(input: WorkspaceReadInput): WorkspaceReadResult {
    const copy = this.authorize(input.copyId, false);
    const relative = this.checkedPath(input.path);
    const absolute = join(copy.rootPath, relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw missingPath(copy.id, relative);
    }
    const data = readFileSync(absolute);
    const info = statSync(absolute);
    return {
      content: encodeContent(data, input.encoding),
      encoding: input.encoding,
      sizeBytes: data.byteLength,
      contentHash: hashOf(data),
      executable: (info.mode & 0o111) !== 0,
    };
  }

  /**
   * Write one file atomically.
   *
   * The content lands in a temporary file beside the target, which a
   * rename then moves into place. A reader sees either the old or the
   * new content, never a partial write.
   */
  write(input: WorkspaceWriteInput): WorkspaceWriteResult {
    const copy = this.authorize(input.copyId, true);
    const relative = this.checkedPath(input.path);
    const absolute = join(copy.rootPath, relative);
    const data = decodeContent(input.content, input.encoding);
    const executable = input.executable ?? existingExecutable(absolute);
    mkdirSync(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${randomUUID()}`;
    writeFileSync(temporary, data);
    chmodSync(temporary, executable ? 0o755 : 0o644);
    renameSync(temporary, absolute);
    return { sizeBytes: data.byteLength, contentHash: hashOf(data), executable };
  }

  /** Delete one file, or one directory when `recursive` is set. */
  delete(input: WorkspaceDeleteInput): WorkspaceDeleteResult {
    const copy = this.authorize(input.copyId, true);
    const relative = this.checkedPath(input.path);
    const absolute = join(copy.rootPath, relative);
    if (!existsSync(absolute)) {
      throw missingPath(copy.id, relative);
    }
    const info = statSync(absolute);
    if (info.isDirectory() && input.recursive !== true && readdirSync(absolute).length > 0) {
      throw invalidRequestError(
        `The directory ${relative} is not empty; delete needs recursive: true.`,
        { copyId: copy.id, path: relative, reason: "directory-needs-recursive" },
      );
    }
    rmSync(absolute, { recursive: input.recursive === true, force: false });
    return {
      removed: true,
      kind: info.isDirectory() ? "directory" : "file",
    };
  }

  /** Describe one path without reading its content. */
  stat(input: WorkspaceStatInput): WorkspaceStatResult {
    const copy = this.authorize(input.copyId, false);
    const relative = this.checkedPath(input.path);
    const absolute = join(copy.rootPath, relative);
    if (!existsSync(absolute)) {
      throw missingPath(copy.id, relative);
    }
    const info = statSync(absolute);
    if (info.isDirectory()) {
      return {
        path: relative,
        kind: "directory",
        executable: false,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      };
    }
    return {
      path: relative,
      kind: "file",
      executable: (info.mode & 0o111) !== 0,
      sizeBytes: info.size,
      contentHash: hashOf(readFileSync(absolute)),
      modifiedAt: new Date(info.mtimeMs).toISOString(),
    };
  }

  /**
   * Authorize one call against one copy of this session.
   *
   * Every operation passes through here: the session must be open, the
   * copy must belong to it, and mutations must name a `proposal` copy.
   * A read-only copy rejects every mutation (SPEC.md section 14.3).
   */
  private authorize(copyId: string, mutating: boolean): WorkingCopyRecord {
    requireOpenSession(this.store, this.sessionId);
    const copy = this.store.getWorkingCopy(copyId);
    if (copy === null) {
      throw invalidRequestError(`Working copy ${copyId} does not exist.`, { copyId });
    }
    if (copy.sessionId !== this.sessionId) {
      throw invalidRequestError(`Working copy ${copyId} belongs to another session.`, {
        copyId,
        sessionId: this.sessionId,
      });
    }
    if (mutating && copy.mode !== "proposal") {
      throw invalidRequestError(
        `Working copy ${copyId} is a read-only snapshot; it rejects all mutations.`,
        { copyId, mode: copy.mode, reason: "read-only-copy" },
      );
    }
    return copy;
  }

  /** Validate one operation path and return it unchanged. */
  private checkedPath(path: string): string {
    const problem = validateWorkspacePath(path);
    if (problem !== null) {
      throw problem;
    }
    return path;
  }
}

// -- Internals ----------------------------------------------------------------

/** The refusal for a path that does not exist in one copy. */
function missingPath(copyId: string, path: string) {
  return invalidRequestError(`The path ${path} does not exist in copy ${copyId}.`, {
    copyId,
    path,
    reason: "missing-path",
  });
}

/** Encode one buffer under the encoding the caller named. */
function encodeContent(data: Buffer, encoding: WorkspaceEncoding): string {
  return encoding === "base64" ? data.toString("base64") : data.toString("utf8");
}

/** Decode one written string under the encoding the caller named. */
function decodeContent(content: string, encoding: WorkspaceEncoding): Buffer {
  if (encoding === "base64") {
    const data = Buffer.from(content, "base64");
    if (content.length > 0 && data.toString("base64").replace(/=+$/, "") !== content.replace(/=+$/, "")) {
      throw invalidRequestError("The base64 content is not valid.", {
        reason: "invalid-encoding",
        encoding,
      });
    }
    return data;
  }
  return Buffer.from(content, "utf8");
}

/** The executable bit of an existing file, or `false` for a new one. */
function existingExecutable(absolute: string): boolean {
  try {
    return (statSync(absolute).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The SHA-256 digest of one buffer. */
function hashOf(data: Buffer): Sha256Hex {
  return createHash("sha256").update(data).digest("hex") as Sha256Hex;
}
