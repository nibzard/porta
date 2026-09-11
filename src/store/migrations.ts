/**
 * Control store schema migrations (SPEC.md section 5.2).
 *
 * Each migration runs once, inside a transaction, in ascending order. The
 * `migrations` table records what ran; the store creates it before the
 * first migration runs, so the initial migration only creates data tables.
 * Never edit an applied migration; append a new one.
 *
 * `CAS_TABLES` whitelists the columns the compare-and-swap helper may
 * read or write. It exists so dynamic SQL can never inject a column name.
 */

export interface Migration {
  id: number;
  name: string;
  statements: readonly string[];
}

export const INITIAL_SCHEMA: Migration = {
  id: 1,
  name: "initial-schema",
  statements: [
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('open', 'closing', 'closed')),
      workspace_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL DEFAULT 0,
      policy_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    )`,
    `CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      name TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      status TEXT NOT NULL,
      environment_id TEXT,
      provider_id TEXT,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      UNIQUE (session_id, name)
    )`,
    `CREATE TABLE acquisitions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      attachment_id TEXT,
      request_key TEXT,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      UNIQUE (session_id, request_key)
    )`,
    `CREATE TABLE operations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      attachment_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      request_key TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      UNIQUE (session_id, request_key)
    )`,
    `CREATE TABLE events (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence)
    )`,
    `CREATE TABLE transitions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      attachment_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    )`,
    `CREATE TABLE cleanup (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    )`,
    `CREATE TABLE blobs (
      digest TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
      registered_at TEXT NOT NULL,
      verified_at TEXT
    )`,
    `CREATE TABLE revisions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_id TEXT,
      root_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    )`,
    `CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      base_revision_id TEXT NOT NULL,
      candidate_revision_id TEXT NOT NULL,
      source_attachment_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    )`,
    `CREATE TABLE workspace_heads (
      workspace_id TEXT PRIMARY KEY,
      head_revision_id TEXT
    )`,
    `CREATE INDEX idx_attachments_session ON attachments(session_id)`,
    `CREATE INDEX idx_operations_session ON operations(session_id, request_key)`,
    `CREATE INDEX idx_events_session ON events(session_id, sequence)`,
    `CREATE INDEX idx_cleanup_session ON cleanup(session_id, status)`,
    `CREATE INDEX idx_revisions_workspace ON revisions(workspace_id)`,
  ],
};

/** Bridge import deduplication (SPEC.md sections 11.4 and 5.2). */
export const BRIDGE_IMPORTS: Migration = {
  id: 3,
  name: "bridge-imports",
  statements: [
    `CREATE TABLE bridge_imports (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      request_key TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_key)
    )`,
  ],
};

/** Revision manifests and working-copy registry (SPEC.md sections 11.1 and 11.3). */
export const REVISION_TREES: Migration = {
  id: 4,
  name: "revision-trees",
  statements: [
    `CREATE TABLE revision_trees (
      revision_id TEXT PRIMARY KEY,
      root_hash TEXT NOT NULL,
      entries_json TEXT NOT NULL
    )`,
    `CREATE TABLE working_copies (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      base_revision_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('read-only', 'proposal')),
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_working_copies_session ON working_copies(session_id)`,
  ],
};

/** Durable mutation leases with fencing tokens (SPEC.md sections 5.2, 8.1). */
export const MUTATION_LEASES: Migration = {
  id: 2,
  name: "mutation-leases",
  statements: [
    `CREATE TABLE mutation_leases (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      attachment_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
      holder TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, attachment_id)
    )`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [
  INITIAL_SCHEMA,
  MUTATION_LEASES,
  BRIDGE_IMPORTS,
  REVISION_TREES,
];

/** Tables with compare-and-swap support and their writable columns. */
export const CAS_TABLES = {
  sessions: ["status", "workspace_id", "event_sequence", "policy_ref", "record_json"],
  attachments: ["name", "generation", "status", "environment_id", "provider_id", "record_json"],
  acquisitions: ["attachment_id", "request_key", "state", "record_json"],
  operations: ["generation", "request_key", "input_hash", "status", "record_json"],
  transitions: ["attachment_id", "phase", "record_json"],
  cleanup: ["kind", "target_id", "status", "record_json"],
} as const satisfies Record<string, readonly string[]>;

/** Tables whose CAS helper also refreshes `updated_at`. */
export const TABLES_WITH_UPDATED_AT: readonly string[] = [
  "sessions",
  "attachments",
  "acquisitions",
  "operations",
  "transitions",
];
