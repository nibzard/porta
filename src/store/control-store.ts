import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { nowUtcTimestamp } from "../core/time.js";
import { assertValid } from "../schema/validate.js";
import { portableError } from "../core/errors.js";
import type { PortableError } from "../schema/error.js";
import { portableEventSchema } from "../schema/event.js";
import type { PortableEvent } from "../schema/event.js";
import { attachmentSummarySchema, sessionRecordSchema } from "../schema/session.js";
import type {
  AttachmentSummary,
  SessionRecord,
  SessionStatus,
} from "../schema/session.js";
import { acquisitionStatusSchema } from "../schema/adapter.js";
import type { AcquisitionStatus } from "../schema/adapter.js";
import { operationRecordSchema } from "../schema/operation.js";
import type { OperationRecord } from "../schema/operation.js";
import { cleanupObligationSchema } from "../schema/handoff.js";
import type { CleanupObligation } from "../schema/handoff.js";
import {
  workspaceProposalSchema,
  workspaceRevisionSchema,
} from "../schema/workspace.js";
import type { WorkspaceProposal, WorkspaceRevision } from "../schema/workspace.js";
import { CAS_TABLES, MIGRATIONS, TABLES_WITH_UPDATED_AT } from "./migrations.js";

/** Values a compare-and-swap column may carry. */
export type CasValue = string | number | null;

/** Failure kinds the control store reports. */
export type StoreErrorKind =
  | "unique"
  | "not-found"
  | "cas-failed"
  | "integrity"
  | "invalid"
  | "lease-held"
  | "lease-expired"
  | "fenced-out";

/** Typed control store failure. Runtime code maps these to Portable errors. */
export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  readonly constraint?: string | undefined;

  constructor(kind: StoreErrorKind, message: string, constraint?: string) {
    super(message);
    this.name = "StoreError";
    this.kind = kind;
    this.constraint = constraint;
  }

  toPortableError(): PortableError {
    const code =
      this.kind === "unique"
        ? "RequestConflict"
        : this.kind === "integrity"
          ? "IntegrityFailure"
          : this.kind === "cas-failed" || this.kind === "fenced-out"
            ? "StaleHandle"
            : this.kind === "lease-expired"
              ? "LeaseExpired"
              : this.kind === "lease-held"
                ? "HandoffBlocked"
                : "InvalidRequest";
    return portableError(code, this.message, {
      details: { storeErrorKind: this.kind, constraint: this.constraint },
    });
  }
}

/**
 * Durable authority to mutate one attachment (SPEC.md sections 5.2, 8.1).
 *
 * Release and replacement serialize on this lease. Each acquisition
 * increments the fencing token; a mutation commits only while the token
 * it holds is still current and unexpired.
 */
export interface MutationLease {
  sessionId: string;
  attachmentId: string;
  fencingToken: number;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string | undefined;
}

/** Durable replacement transition record. Fully shaped by later tasks. */
export interface TransitionRecord {
  id: string;
  sessionId: string;
  attachmentId: string;
  phase: string;
  data: Record<string, unknown>;
  updatedAt: string;
}

interface Row {
  [column: string]: unknown;
}

/**
 * Durable, transactional control store (SPEC.md section 5.2).
 *
 * Uses a local SQLite database in WAL mode. Multiple processes may open the
 * same file; SQLite file locking plus `BEGIN IMMEDIATE` serializes writers
 * and `busy_timeout` makes concurrent access wait instead of fail.
 *
 * Records are stored as validated JSON with mirrored key columns. The
 * compare-and-swap helpers turn `UPDATE ... WHERE <expected> RETURNING`
 * into atomic guards: a stale writer updates zero rows and gets null.
 * Every update writes the mirrored columns and the record JSON in one
 * statement, so the two never disagree.
 */
export class ControlStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Open (and create when missing) a control store database.
   *
   * `synchronous = FULL` keeps committed transactions across process
   * crashes. Migrations run before the store is returned.
   */
  static open(path: string): ControlStore {
    const db = new DatabaseSync(path);
    // The busy timeout comes first: switching the journal mode also takes
    // a lock, and it must wait for a concurrent opener, not fail.
    db.exec("PRAGMA busy_timeout = 10000");
    setJournalModeWal(db);
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    const store = new ControlStore(db);
    store.migrate();
    return store;
  }

  /** Open an in-memory store, mainly for tests. */
  static inMemory(): ControlStore {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const store = new ControlStore(db);
    store.migrate();
    return store;
  }

  close(): void {
    this.db.close();
  }

  /** Identifiers of every applied migration, in order. */
  appliedMigrations(): number[] {
    return (this.db.prepare("SELECT id FROM migrations ORDER BY id").all() as Array<{ id: number }>).map(
      (row) => row.id,
    );
  }

  // -- Infrastructure ------------------------------------------------------

  /**
   * Apply pending migrations.
   *
   * The bookkeeping table, the check, and the statements run in one write
   * transaction. Two processes that open a fresh file at the same time
   * serialize here; the second sees the first's migrations and skips them.
   */
  private migrate(): void {
    this.transaction(() => {
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
      );
      const applied = new Set(
        (this.db.prepare("SELECT id FROM migrations").all() as Array<{ id: number }>).map(
          (row) => row.id,
        ),
      );
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.id)) {
          continue;
        }
        for (const statement of migration.statements) {
          this.db.exec(statement);
        }
        this.db
          .prepare("INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.id, migration.name, nowUtcTimestamp());
      }
    });
  }

  /**
   * Run a body inside a transaction.
   *
   * `BEGIN IMMEDIATE` takes the write lock up front so writers serialize
   * across processes. Nested calls join the outer transaction. A thrown
   * error rolls the whole transaction back.
   */
  transaction<T>(body: () => T): T {
    if (this.transactionDepth > 0) {
      return this.runInTransaction(body);
    }
    this.db.exec("BEGIN IMMEDIATE");
    return this.runInTransaction(body);
  }

  private runInTransaction<T>(body: () => T): T {
    this.transactionDepth += 1;
    try {
      const result = body();
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) {
        this.db.exec("COMMIT");
      }
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    try {
      this.stmt(sql).run(...params);
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    try {
      return this.stmt(sql).get(...params) as Row | undefined;
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    try {
      return this.stmt(sql).all(...params) as Row[];
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /**
   * Atomic compare-and-swap on one row.
   *
   * Applies `patch` only when every `expect` column matches. Returns the
   * record JSON after the update, or null when the expectation failed. The
   * patch must include `record_json`, so the stored record always reflects
   * the new column values.
   */
  private casUpdate(
    table: keyof typeof CAS_TABLES,
    id: string,
    expect: Record<string, CasValue>,
    patch: Record<string, CasValue>,
  ): unknown | null {
    const columns: readonly string[] = CAS_TABLES[table];
    const checkColumn = (column: string): void => {
      if (!columns.includes(column)) {
        throw new StoreError("invalid", `Column ${column} is not cas-supported on ${table}.`);
      }
    };
    const patchEntries = Object.entries(patch);
    const expectEntries = Object.entries(expect);
    if (patchEntries.length === 0) {
      throw new StoreError("invalid", "Compare-and-swap needs a non-empty patch.");
    }
    if (patch.record_json === undefined) {
      throw new StoreError("invalid", "Compare-and-swap needs a new record JSON.");
    }
    for (const [column] of [...patchEntries, ...expectEntries]) {
      checkColumn(column);
    }
    const sets = patchEntries.map(([column]) => `${column} = ?`);
    const params: SQLInputValue[] = patchEntries.map(([, value]) => value);
    if (TABLES_WITH_UPDATED_AT.includes(table)) {
      sets.push("updated_at = ?");
      params.push(nowUtcTimestamp());
    }
    const wheres = ["id = ?", ...expectEntries.map(([column]) => `${column} = ?`)];
    params.push(id, ...expectEntries.map(([, value]) => value));
    const sql = `UPDATE ${table} SET ${sets.join(", ")} WHERE ${wheres.join(" AND ")} RETURNING record_json`;
    const row = this.get(sql, ...params);
    return row === undefined ? null : (JSON.parse(row.record_json as string) as unknown);
  }

  private static parse<T>(row: Row | undefined, schema: object, what: string): T | null {
    if (row === undefined) {
      return null;
    }
    const parsed = JSON.parse(row.record_json as string) as unknown;
    try {
      assertValid(schema, parsed);
    } catch {
      throw new StoreError(
        "integrity",
        `The stored ${what} record failed its schema. The store may be corrupt.`,
      );
    }
    return parsed as T;
  }

  // -- Sessions --------------------------------------------------------------

  createSession(record: SessionRecord): void {
    assertValid(sessionRecordSchema, record);
    this.transaction(() => {
      this.run(
        "INSERT INTO sessions (id, status, workspace_id, event_sequence, policy_ref, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        record.id,
        record.status,
        record.workspaceId,
        record.eventSequence,
        record.policyRef,
        record.createdAt,
        record.createdAt,
        JSON.stringify(record),
      );
      this.run(
        "INSERT INTO workspace_heads (workspace_id, head_revision_id) VALUES (?, NULL) ON CONFLICT(workspace_id) DO NOTHING",
        record.workspaceId,
      );
    });
  }

  getSession(id: string): SessionRecord | null {
    return ControlStore.parse<SessionRecord>(
      this.get("SELECT record_json FROM sessions WHERE id = ?", id),
      sessionRecordSchema,
      "session",
    );
  }

  /**
   * Move a session between statuses under an expectation.
   *
   * Returns the updated record, or null when the current status does not
   * match any expected value. Read, record update, and compare-and-swap run
   * in one transaction, so the stored record stays in step with its columns.
   */
  casSessionStatus(
    id: string,
    expected: readonly SessionStatus[],
    next: SessionStatus,
  ): SessionRecord | null {
    return this.transaction(() => {
      const current = ControlStore.parse<SessionRecord>(
        this.get("SELECT record_json FROM sessions WHERE id = ?", id),
        sessionRecordSchema,
        "session",
      );
      if (current === null) {
        throw new StoreError("not-found", `Session ${id} does not exist.`);
      }
      if (!expected.includes(current.status)) {
        return null;
      }
      const updated: SessionRecord = { ...current, status: next };
      const result = this.casUpdate(
        "sessions",
        id,
        { status: current.status },
        { status: next, record_json: JSON.stringify(updated) },
      );
      return result === null ? null : (result as SessionRecord);
    });
  }

  // -- Events ----------------------------------------------------------------

  /**
   * Append one event inside a transaction.
   *
   * The session sequence increments atomically with the insert, so state
   * and its event commit together (SPEC.md section 18.1). Writers serialize
   * through `BEGIN IMMEDIATE`, so the compare-and-swap is expected to win
   * on the first try; the retry loop only guards nested edge cases.
   */
  appendEvent(
    sessionId: string,
    type: PortableEvent["type"],
    subjectId: string,
    data: Record<string, unknown>,
  ): PortableEvent {
    return this.transaction(() => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const row = this.get("SELECT record_json FROM sessions WHERE id = ?", sessionId);
        if (row === undefined) {
          throw new StoreError("not-found", `Session ${sessionId} does not exist.`);
        }
        const session = JSON.parse(row.record_json as string) as SessionRecord;
        const next = session.eventSequence + 1;
        const updatedSession: SessionRecord = { ...session, eventSequence: next };
        const event: PortableEvent = {
          schemaVersion: 1,
          sessionId,
          sequence: next,
          occurredAt: nowUtcTimestamp(),
          type,
          subjectId,
          data,
        };
        assertValid(portableEventSchema, event);
        const updated = this.casUpdate(
          "sessions",
          sessionId,
          { event_sequence: session.eventSequence },
          {
            event_sequence: next,
            record_json: JSON.stringify(updatedSession),
          },
        );
        if (updated === null) {
          continue;
        }
        this.run(
          "INSERT INTO events (session_id, sequence, type, subject_id, occurred_at, record_json) VALUES (?, ?, ?, ?, ?, ?)",
          sessionId,
          next,
          event.type,
          subjectId,
          event.occurredAt,
          JSON.stringify(event),
        );
        return event;
      }
      throw new StoreError("cas-failed", "Event sequence kept moving; try again.");
    });
  }

  listEvents(sessionId: string, afterSequence: number, limit?: number): PortableEvent[] {
    const rows =
      limit === undefined
        ? this.all(
            "SELECT record_json FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence",
            sessionId,
            afterSequence,
          )
        : this.all(
            "SELECT record_json FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
            sessionId,
            afterSequence,
            limit,
          );
    return rows.map((row) => {
      const parsed = JSON.parse(row.record_json as string) as unknown;
      assertValid(portableEventSchema, parsed);
      return parsed as PortableEvent;
    });
  }

  // -- Attachments -----------------------------------------------------------

  insertAttachment(record: AttachmentSummary): void {
    assertValid(attachmentSummarySchema, record);
    this.run(
      "INSERT INTO attachments (id, session_id, name, generation, status, environment_id, provider_id, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      record.attachmentId,
      record.sessionId,
      record.name,
      record.generation,
      record.status,
      record.environmentId ?? null,
      record.providerId ?? null,
      nowUtcTimestamp(),
      JSON.stringify(record),
    );
  }

  getAttachment(attachmentId: string): AttachmentSummary | null {
    return ControlStore.parse<AttachmentSummary>(
      this.get("SELECT record_json FROM attachments WHERE id = ?", attachmentId),
      attachmentSummarySchema,
      "attachment",
    );
  }

  getAttachmentByName(sessionId: string, name: string): AttachmentSummary | null {
    return ControlStore.parse<AttachmentSummary>(
      this.get(
        "SELECT record_json FROM attachments WHERE session_id = ? AND name = ?",
        sessionId,
        name,
      ),
      attachmentSummarySchema,
      "attachment",
    );
  }

  listAttachments(sessionId: string): AttachmentSummary[] {
    return this.all(
      "SELECT record_json FROM attachments WHERE session_id = ? ORDER BY name",
      sessionId,
    ).map((row) => {
      const parsed = JSON.parse(row.record_json as string) as unknown;
      assertValid(attachmentSummarySchema, parsed);
      return parsed as AttachmentSummary;
    });
  }

  /**
   * Replace one attachment record under column expectations.
   *
   * `expect` guards the update (for example the generation or status the
   * caller observed). The new record supplies every mirrored column, so
   * columns and stored JSON move together. Returns the updated record, or
   * null when an expectation failed.
   */
  casAttachment(
    attachmentId: string,
    expect: Record<string, CasValue>,
    record: AttachmentSummary,
  ): AttachmentSummary | null {
    assertValid(attachmentSummarySchema, record);
    const result = this.casUpdate("attachments", attachmentId, expect, {
      name: record.name,
      generation: record.generation,
      status: record.status,
      environment_id: record.environmentId ?? null,
      provider_id: record.providerId ?? null,
      record_json: JSON.stringify(record),
    });
    return result === null ? null : (result as AttachmentSummary);
  }

  // -- Acquisitions ----------------------------------------------------------

  /**
   * Persist one acquisition identity.
   *
   * `requestKey` enforces the one-logical-request rule: a second insert
   * with the same key in one session fails with a unique error.
   */
  insertAcquisition(sessionId: string, requestKey: string | null, record: AcquisitionStatus): void {
    assertValid(acquisitionStatusSchema, record);
    this.run(
      "INSERT INTO acquisitions (id, session_id, attachment_id, request_key, state, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      record.acquisitionId,
      sessionId,
      null,
      requestKey,
      record.state,
      nowUtcTimestamp(),
      JSON.stringify(record),
    );
  }

  getAcquisition(acquisitionId: string): AcquisitionStatus | null {
    return ControlStore.parse<AcquisitionStatus>(
      this.get("SELECT record_json FROM acquisitions WHERE id = ?", acquisitionId),
      acquisitionStatusSchema,
      "acquisition",
    );
  }

  getAcquisitionByRequestKey(sessionId: string, requestKey: string): AcquisitionStatus | null {
    const row = this.get(
      "SELECT record_json FROM acquisitions WHERE session_id = ? AND request_key = ?",
      sessionId,
      requestKey,
    );
    if (row === undefined) {
      return null;
    }
    const parsed = JSON.parse(row.record_json as string) as unknown;
    assertValid(acquisitionStatusSchema, parsed);
    return parsed as AcquisitionStatus;
  }

  casAcquisition(
    acquisitionId: string,
    expect: Record<string, CasValue>,
    record: AcquisitionStatus,
  ): AcquisitionStatus | null {
    assertValid(acquisitionStatusSchema, record);
    const result = this.casUpdate("acquisitions", acquisitionId, expect, {
      state: record.state,
      record_json: JSON.stringify(record),
    });
    return result === null ? null : (result as AcquisitionStatus);
  }

  // -- Operations -----------------------------------------------------------

  /**
   * Persist one operation record.
   *
   * The request key enforces deduplication: reusing a key in one session
   * with a different record fails with a unique error, and the caller is
   * expected to compare input hashes instead.
   */
  insertOperation(record: OperationRecord, requestKey: string): void {
    assertValid(operationRecordSchema, record);
    this.run(
      "INSERT INTO operations (id, session_id, attachment_id, generation, request_key, input_hash, status, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      record.id,
      record.attachment.sessionId,
      record.attachment.attachmentId,
      record.attachment.generation,
      requestKey,
      record.inputHash,
      record.status,
      nowUtcTimestamp(),
      JSON.stringify(record),
    );
  }

  getOperation(operationId: string): OperationRecord | null {
    return ControlStore.parse<OperationRecord>(
      this.get("SELECT record_json FROM operations WHERE id = ?", operationId),
      operationRecordSchema,
      "operation",
    );
  }

  getOperationByRequestKey(sessionId: string, requestKey: string): OperationRecord | null {
    const row = this.get(
      "SELECT record_json FROM operations WHERE session_id = ? AND request_key = ?",
      sessionId,
      requestKey,
    );
    if (row === undefined) {
      return null;
    }
    const parsed = JSON.parse(row.record_json as string) as unknown;
    assertValid(operationRecordSchema, parsed);
    return parsed as OperationRecord;
  }

  casOperation(
    operationId: string,
    expect: Record<string, CasValue>,
    record: OperationRecord,
  ): OperationRecord | null {
    assertValid(operationRecordSchema, record);
    const result = this.casUpdate("operations", operationId, expect, {
      generation: record.attachment.generation,
      input_hash: record.inputHash,
      status: record.status,
      record_json: JSON.stringify(record),
    });
    return result === null ? null : (result as OperationRecord);
  }

  // -- Transitions ----------------------------------------------------------

  insertTransition(record: TransitionRecord): void {
    if (!record.id || !record.sessionId || !record.attachmentId || !record.phase) {
      throw new StoreError("invalid", "Transition records need id, session, attachment, and phase.");
    }
    this.run(
      "INSERT INTO transitions (id, session_id, attachment_id, phase, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?)",
      record.id,
      record.sessionId,
      record.attachmentId,
      record.phase,
      nowUtcTimestamp(),
      JSON.stringify({ ...record, updatedAt: nowUtcTimestamp() }),
    );
  }

  getTransition(transitionId: string): TransitionRecord | null {
    const row = this.get("SELECT record_json FROM transitions WHERE id = ?", transitionId);
    return row === undefined
      ? null
      : (JSON.parse(row.record_json as string) as TransitionRecord);
  }

  casTransition(
    transitionId: string,
    expect: Record<string, CasValue>,
    record: TransitionRecord,
  ): TransitionRecord | null {
    const result = this.casUpdate("transitions", transitionId, expect, {
      attachment_id: record.attachmentId,
      phase: record.phase,
      record_json: JSON.stringify({ ...record, updatedAt: nowUtcTimestamp() }),
    });
    return result === null ? null : (result as TransitionRecord);
  }

  // -- Cleanup --------------------------------------------------------------

  /**
   * Persist one cleanup obligation.
   *
   * `status` tracks retry state (`pending`, `satisfied`, `failed`) in its
   * own column; the record itself stays schema-clean.
   */
  insertCleanup(sessionId: string, record: CleanupObligation, status = "pending"): void {
    assertValid(cleanupObligationSchema, record);
    this.run(
      "INSERT INTO cleanup (id, session_id, kind, target_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      record.id,
      sessionId,
      record.kind,
      record.targetId,
      status,
      record.createdAt,
      JSON.stringify(record),
    );
  }

  getCleanup(cleanupId: string): CleanupObligation | null {
    return ControlStore.parse<CleanupObligation>(
      this.get("SELECT record_json FROM cleanup WHERE id = ?", cleanupId),
      cleanupObligationSchema,
      "cleanup",
    );
  }

  listCleanup(
    sessionId: string,
    status?: string,
  ): Array<{ record: CleanupObligation; status: string }> {
    const rows =
      status === undefined
        ? this.all("SELECT record_json, status FROM cleanup WHERE session_id = ?", sessionId)
        : this.all(
            "SELECT record_json, status FROM cleanup WHERE session_id = ? AND status = ?",
            sessionId,
            status,
          );
    return rows.map((row) => {
      const parsed = JSON.parse(row.record_json as string) as unknown;
      assertValid(cleanupObligationSchema, parsed);
      return { record: parsed as CleanupObligation, status: row.status as string };
    });
  }

  /** Move one cleanup obligation between retry states under an expectation. */
  casCleanupStatus(cleanupId: string, expected: string, next: string): string | null {
    const row = this.get("SELECT status FROM cleanup WHERE id = ?", cleanupId);
    if (row === undefined) {
      throw new StoreError("not-found", `Cleanup obligation ${cleanupId} does not exist.`);
    }
    if (row.status !== expected) {
      return null;
    }
    const changes = this.stmt("UPDATE cleanup SET status = ? WHERE id = ? AND status = ?").run(
      next,
      cleanupId,
      expected,
    ).changes;
    return changes === 0 ? null : next;
  }

  // -- Mutation leases --------------------------------------------------------

  /** Read the current mutation lease of one attachment. */
  getMutationLease(sessionId: string, attachmentId: string): MutationLease | null {
    const row = this.get(
      "SELECT record_json FROM mutation_leases WHERE session_id = ? AND attachment_id = ?",
      sessionId,
      attachmentId,
    );
    return row === undefined ? null : (JSON.parse(row.record_json as string) as MutationLease);
  }

  /**
   * Acquire the mutation lease of one attachment.
   *
   * Acquisition succeeds when no lease exists, when the previous lease was
   * released, or when it expired. Every acquisition increments the fencing
   * token, so tokens rise monotonically per attachment and an earlier
   * holder can never look current again. A still-valid lease refuses the
   * request with a `lease-held` error: release and replacement serialize
   * here (SPEC.md sections 5.2 and 8.1).
   */
  acquireMutationLease(
    sessionId: string,
    attachmentId: string,
    holder: string,
    ttlMs: number,
  ): MutationLease {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new StoreError("invalid", "The mutation lease needs a positive whole-number duration.");
    }
    return this.transaction(() => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const now = nowUtcTimestamp();
        const row = this.get(
          "SELECT record_json FROM mutation_leases WHERE session_id = ? AND attachment_id = ?",
          sessionId,
          attachmentId,
        );
        if (row === undefined) {
          const lease: MutationLease = {
            sessionId,
            attachmentId,
            fencingToken: 1,
            holder,
            acquiredAt: now,
            expiresAt: offsetTimestamp(now, ttlMs),
          };
          this.run(
            "INSERT INTO mutation_leases (session_id, attachment_id, fencing_token, holder, acquired_at, expires_at, released_at, record_json) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
            sessionId,
            attachmentId,
            lease.fencingToken,
            holder,
            lease.acquiredAt,
            lease.expiresAt,
            JSON.stringify(lease),
          );
          return lease;
        }
        const current = JSON.parse(row.record_json as string) as MutationLease;
        const active = current.releasedAt === undefined && epochMs(current.expiresAt) > epochMs(now);
        if (active) {
          throw new StoreError(
            "lease-held",
            `Attachment ${attachmentId} holds a valid mutation lease (token ${current.fencingToken}).`,
          );
        }
        const lease: MutationLease = {
          sessionId,
          attachmentId,
          fencingToken: current.fencingToken + 1,
          holder,
          acquiredAt: now,
          expiresAt: offsetTimestamp(now, ttlMs),
        };
        const changes = this.stmt(
          "UPDATE mutation_leases SET fencing_token = ?, holder = ?, acquired_at = ?, expires_at = ?, released_at = NULL, record_json = ? WHERE session_id = ? AND attachment_id = ? AND fencing_token = ? AND released_at IS ?",
        ).run(
          lease.fencingToken,
          holder,
          lease.acquiredAt,
          lease.expiresAt,
          JSON.stringify(lease),
          sessionId,
          attachmentId,
          current.fencingToken,
          current.releasedAt ?? null,
        ).changes;
        if (changes > 0) {
          return lease;
        }
        // The row moved between read and update; re-read and retry.
      }
      throw new StoreError("cas-failed", "The mutation lease kept moving; try again.");
    });
  }

  /**
   * Extend the lease the caller still holds.
   *
   * Returns the extended lease, or null when the token is no longer
   * current or the lease was released. The new expiry never moves back.
   */
  renewMutationLease(
    sessionId: string,
    attachmentId: string,
    fencingToken: number,
    extendMs: number,
  ): MutationLease | null {
    if (!Number.isSafeInteger(extendMs) || extendMs <= 0) {
      throw new StoreError("invalid", "The lease renewal needs a positive whole-number duration.");
    }
    return this.transaction(() => {
      const current = this.readLease(sessionId, attachmentId);
      if (current.fencingToken !== fencingToken || current.releasedAt !== undefined) {
        return null;
      }
      const now = nowUtcTimestamp();
      const base = Math.max(epochMs(current.expiresAt), epochMs(now));
      const lease: MutationLease = {
        ...current,
        expiresAt: new Date(base + extendMs).toISOString(),
      };
      const changes = this.stmt(
        "UPDATE mutation_leases SET expires_at = ?, record_json = ? WHERE session_id = ? AND attachment_id = ? AND fencing_token = ? AND released_at IS NULL",
      ).run(
        lease.expiresAt,
        JSON.stringify(lease),
        sessionId,
        attachmentId,
        fencingToken,
      ).changes;
      return changes > 0 ? lease : null;
    });
  }

  /**
   * Release the mutation lease.
   *
   * Releasing the same token again succeeds without effect. A token that
   * is no longer current returns false: another controller owns the lease
   * now, and the old holder must not undo it.
   */
  releaseMutationLease(
    sessionId: string,
    attachmentId: string,
    fencingToken: number,
  ): boolean {
    return this.transaction(() => {
      const current = this.readLease(sessionId, attachmentId);
      if (current.fencingToken !== fencingToken) {
        return false;
      }
      if (current.releasedAt !== undefined) {
        return true;
      }
      const releasedAt = nowUtcTimestamp();
      const released: MutationLease = { ...current, releasedAt };
      const changes = this.stmt(
        "UPDATE mutation_leases SET released_at = ?, record_json = ? WHERE session_id = ? AND attachment_id = ? AND fencing_token = ? AND released_at IS NULL",
      ).run(
        releasedAt,
        JSON.stringify(released),
        sessionId,
        attachmentId,
        fencingToken,
      ).changes;
      return changes > 0;
    });
  }

  /**
   * Confirm a fencing token still carries authority.
   *
   * Throws `fenced-out` when a newer controller acquired the lease or the
   * lease was released, and `lease-expired` when the token is current but
   * its time ran out. Expiration alone revokes authority: a delayed
   * provider response cannot be committed under a lapsed token even when
   * nobody else has taken over (SPEC.md section 5.2).
   */
  validateMutationLease(sessionId: string, attachmentId: string, fencingToken: number): void {
    const current = this.readLease(sessionId, attachmentId);
    if (current.fencingToken !== fencingToken) {
      throw new StoreError(
        "fenced-out",
        `Fencing token ${fencingToken} is stale; attachment ${attachmentId} is at token ${current.fencingToken}.`,
      );
    }
    if (current.releasedAt !== undefined) {
      throw new StoreError("fenced-out", `The mutation lease for ${attachmentId} was released.`);
    }
    if (epochMs(current.expiresAt) <= epochMs(nowUtcTimestamp())) {
      throw new StoreError(
        "lease-expired",
        `The mutation lease for ${attachmentId} expired at ${current.expiresAt}.`,
      );
    }
  }

  /**
   * Run a control mutation under a fencing check.
   *
   * The lease check and the body commit in one transaction: the mutation
   * lands only while the token is current, unexpired, and unreleased, and
   * a failure inside the body rolls everything back.
   */
  mutateWithLease<T>(
    sessionId: string,
    attachmentId: string,
    fencingToken: number,
    body: () => T,
  ): T {
    return this.transaction(() => {
      this.validateMutationLease(sessionId, attachmentId, fencingToken);
      return body();
    });
  }

  private readLease(sessionId: string, attachmentId: string): MutationLease {
    const row = this.get(
      "SELECT record_json FROM mutation_leases WHERE session_id = ? AND attachment_id = ?",
      sessionId,
      attachmentId,
    );
    if (row === undefined) {
      throw new StoreError(
        "not-found",
        `No mutation lease exists for attachment ${attachmentId}.`,
      );
    }
    return JSON.parse(row.record_json as string) as MutationLease;
  }

  // -- Blobs and revisions ----------------------------------------------------

  /** Record a blob in the registry. Registration alone does not verify it. */
  registerBlob(digest: string, sizeBytes: number): void {
    this.run(
      "INSERT INTO blobs (digest, size_bytes, verified, registered_at) VALUES (?, ?, 0, ?) ON CONFLICT(digest) DO NOTHING",
      digest,
      sizeBytes,
      nowUtcTimestamp(),
    );
  }

  /** Mark a registered blob as durably present and integrity-checked. */
  markBlobVerified(digest: string): void {
    const changes = this.stmt(
      "UPDATE blobs SET verified = 1, verified_at = ? WHERE digest = ?",
    ).run(nowUtcTimestamp(), digest).changes;
    if (changes === 0) {
      throw new StoreError("not-found", `Blob ${digest} is not registered.`);
    }
  }

  isBlobVerified(digest: string): boolean {
    const row = this.get("SELECT verified FROM blobs WHERE digest = ?", digest);
    return row !== undefined && row.verified === 1;
  }

  /**
   * Insert a workspace revision.
   *
   * Every referenced blob must be registered and verified inside this
   * store before the revision can commit. A missing or unverified blob
   * fails the whole transaction (SPEC.md section 5.2).
   */
  insertRevision(revision: WorkspaceRevision, referencedDigests: readonly string[]): void {
    assertValid(workspaceRevisionSchema, revision);
    this.transaction(() => {
      const unique = [...new Set(referencedDigests)];
      for (const digest of unique) {
        const row = this.get("SELECT verified FROM blobs WHERE digest = ?", digest);
        if (row === undefined) {
          throw new StoreError(
            "integrity",
            `Blob ${digest} is not registered; the revision cannot reference it.`,
          );
        }
        if (row.verified !== 1) {
          throw new StoreError(
            "integrity",
            `Blob ${digest} is registered but not verified; the revision cannot reference it.`,
          );
        }
      }
      this.run(
        "INSERT INTO revisions (id, workspace_id, parent_id, root_hash, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?)",
        revision.id,
        revision.workspaceId,
        revision.parentId ?? null,
        revision.rootHash,
        revision.createdAt,
        JSON.stringify(revision),
      );
    });
  }

  getRevision(revisionId: string): WorkspaceRevision | null {
    return ControlStore.parse<WorkspaceRevision>(
      this.get("SELECT record_json FROM revisions WHERE id = ?", revisionId),
      workspaceRevisionSchema,
      "revision",
    );
  }

  /** Current authoritative head of a workspace, or null when none. */
  getWorkspaceHead(workspaceId: string): string | null {
    const row = this.get(
      "SELECT head_revision_id FROM workspace_heads WHERE workspace_id = ?",
      workspaceId,
    );
    return (row?.head_revision_id as string | null) ?? null;
  }

  /**
   * Move the workspace head under an expected value.
   *
   * Returns false when the current head differs from the expectation. The
   * head never changes on a failed compare (SPEC.md section 4).
   */
  casWorkspaceHead(workspaceId: string, expected: string | null, next: string): boolean {
    return this.transaction(() => {
      const current = this.getWorkspaceHead(workspaceId);
      if (current !== expected) {
        return false;
      }
      this.run(
        "INSERT INTO workspace_heads (workspace_id, head_revision_id) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET head_revision_id = ?",
        workspaceId,
        next,
        next,
      );
      return true;
    });
  }

  // -- Proposals ------------------------------------------------------------

  insertProposal(workspaceId: string, record: WorkspaceProposal): void {
    assertValid(workspaceProposalSchema, record);
    this.run(
      "INSERT INTO proposals (id, workspace_id, base_revision_id, candidate_revision_id, source_attachment_id, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      record.id,
      workspaceId,
      record.baseRevisionId,
      record.candidateRevisionId,
      record.source.attachmentId,
      nowUtcTimestamp(),
      JSON.stringify(record),
    );
  }

  getProposal(proposalId: string): WorkspaceProposal | null {
    return ControlStore.parse<WorkspaceProposal>(
      this.get("SELECT record_json FROM proposals WHERE id = ?", proposalId),
      workspaceProposalSchema,
      "proposal",
    );
  }
}

/** Map a SQLite failure onto a typed store error. */
function mapSqliteError(error: unknown): unknown {
  if (error instanceof Error) {
    const message = error.message;
    const unique = message.match(/UNIQUE constraint failed: (.+)/);
    if (unique) {
      return new StoreError("unique", `Uniqueness conflict on ${unique[1]}.`, unique[1]);
    }
    if (message.includes("FOREIGN KEY constraint failed")) {
      return new StoreError("invalid", "The record references a missing parent row.");
    }
    if (message.includes("CHECK constraint failed")) {
      return new StoreError("invalid", `A stored value violated a check constraint: ${message}`);
    }
  }
  return error;
}

/** Sleep without yielding the event loop, for brief cross-process setup. */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Epoch milliseconds of a UTC timestamp. */
function epochMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    throw new StoreError("invalid", `The stored timestamp ${timestamp} is malformed.`);
  }
  return ms;
}

/** A new UTC timestamp offset from a base one. */
function offsetTimestamp(base: string, deltaMs: number): string {
  return new Date(epochMs(base) + deltaMs).toISOString();
}

/**
 * Switch the database to WAL mode, tolerating a concurrent opener.
 *
 * The journal mode is a durable property of the file. When several
 * processes open a fresh file at once, the switch may report a lock; once
 * the winner settles, the mode is already WAL and the losers can continue.
 */
function setJournalModeWal(db: DatabaseSync): void {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch {
      // Another opener holds the conversion lock; check and retry below.
    }
    try {
      const current = db.prepare("PRAGMA journal_mode").get() as
        | { journal_mode?: string }
        | undefined;
      if (current?.journal_mode === "wal") {
        return;
      }
    } catch {
      // The read itself is blocked; wait and try again.
    }
    sleepSyncMs(20);
  }
  // A last try that reports the failure when the mode never settled.
  db.exec("PRAGMA journal_mode = WAL");
}
