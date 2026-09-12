import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../store/control-store.js";
import { BlobStore } from "../../store/blob-store.js";
import { PolicyAuthority } from "../../core/policy.js";
import type { PolicyAuthority as Authority } from "../../core/policy.js";
import { checkpointWorkspace } from "../../runtime/workspace.js";
import type { ConformanceCase } from "../runner.js";
import type { ConformanceCaseAnswer } from "../runner.js";

/**
 * Event conformance cases (SPEC.md section 21, Events row).
 *
 * The pack proves the journal's three delivery guarantees: consumers
 * resume by sequence without gaps or repeats; a controller restart
 * replays every committed event with its state; and duplicate delivery
 * of an immutable record is always detectable, never a mutation.
 *
 * Every case drives a durable on-disk store, because restart is the
 * behavior under test. No case touches the loaded adapter or anything
 * outside its own temporary directory.
 */

/** One durable bench: an on-disk store, its blobs, and scratch space. */
interface Bench {
  store: ControlStore;
  blobs: BlobStore;
  /** The database path, for reopening after a simulated restart. */
  storePath: string;
  sessionId: string;
  workspaceId: string;
  source(): string;
  done(): void;
}

/** The authority every transfer in this pack runs under. */
const LOCAL_AUTHORITY: Authority = PolicyAuthority.fromPolicy({
  schemaVersion: 1,
  transferDestinations: ["local"],
});

function bench(): Bench {
  const root = mkdtempSync(join(tmpdir(), "porta-conf-events-"));
  const storePath = join(root, "control.db");
  const store = ControlStore.open(storePath);
  const blobs = new BlobStore(join(root, "blobs"), store);
  const sessionId = `sess-${randomUUID()}`;
  const workspaceId = `ws-${randomUUID()}`;
  store.createSession({
    id: sessionId,
    schemaVersion: 1,
    status: "open",
    workspaceId,
    eventSequence: 0,
    policyRef: "policy://conformance",
    createdAt: new Date().toISOString(),
  });
  return {
    store,
    blobs,
    storePath,
    sessionId,
    workspaceId,
    source: () => {
      const dir = join(root, `src-${randomUUID()}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One committed checkpoint under a locked source. */
function commit(state: Bench, requestKey: string) {
  const dir = state.source();
  writeFileSync(join(dir, "file.txt"), requestKey);
  const current = state.store.getWorkspaceHead(state.workspaceId);
  return checkpointWorkspace(
    state.store,
    state.sessionId,
    state.blobs,
    {
      requestKey,
      source: { kind: "bridge", rootPath: dir },
      // A workspace that already holds a head only accepts an import
      // that names it (SPEC.md section 11).
      ...(current !== null ? { expectedHead: current } : {}),
    },
    { stability: { kind: "locked" } },
  );
}

/** Every event of one session, in one pass. */
function allEvents(state: Bench) {
  const out = [];
  for (;;) {
    const batch = state.store.listEvents(state.sessionId, out.length, 500);
    out.push(...batch);
    if (batch.length < 500) {
      return out;
    }
  }
}

/** The portable error record of one thrown value, or null. */
function errorOf(thrown: unknown): { code?: unknown; message?: unknown } | null {
  return thrown !== null && typeof thrown === "object"
    ? (thrown as { code?: unknown; message?: unknown })
    : null;
}

/** The events case pack. */
export function eventsCases(): ConformanceCase[] {
  return [
    {
      id: "events.resume-by-sequence",
      area: "events",
      summary: "A consumer that stops and resumes by sequence misses nothing and repeats nothing.",
      async run() {
        const state = bench();
        try {
          for (let index = 0; index < 5; index += 1) {
            commit(state, `resume-${index}`);
          }
          const whole = allEvents(state);
          if (whole.length < 5) {
            return {
              outcome: "fail",
              reason: "the journal recorded fewer events than committed checkpoints",
              detail: `${whole.length} events for 5 checkpoints`,
            };
          }

          // Read in windows of two, resuming from the last sequence each
          // window reported. The concatenation must equal one pass.
          const collected: typeof whole = [];
          let cursor = 0;
          for (;;) {
            const window = state.store.listEvents(state.sessionId, cursor, 2);
            if (window.length === 0) {
              break;
            }
            collected.push(...window);
            cursor = window[window.length - 1]!.sequence;
          }
          if (collected.length !== whole.length) {
            return {
              outcome: "fail",
              reason: "windowed resume changed the event count",
              detail: `${collected.length} resumed != ${whole.length} whole`,
            };
          }
          for (let index = 0; index < whole.length; index += 1) {
            if (collected[index]!.sequence !== whole[index]!.sequence) {
              return {
                outcome: "fail",
                reason: "windowed resume reordered or skipped events",
                detail: `position ${index}: ${collected[index]!.sequence} != ${whole[index]!.sequence}`,
              };
            }
          }

          // Resuming from the last delivered sequence yields exactly the
          // remainder, never a repeat of the boundary event.
          const boundary = whole[whole.length - 3]!.sequence;
          const tail = state.store.listEvents(state.sessionId, boundary, 500);
          if (tail.length !== 2 || tail[0]!.sequence !== boundary + 1) {
            return {
              outcome: "fail",
              reason: "resume from a delivered sequence repeated or skipped the boundary",
              detail: `after ${boundary}: ${tail.map((event) => event.sequence).join(",")}`,
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "events.restart-replay",
      area: "events",
      summary: "A restarted controller replays every committed event without missing state.",
      async run() {
        const state = bench();
        try {
          for (let index = 0; index < 3; index += 1) {
            commit(state, `restart-${index}`);
          }
          const before = allEvents(state);
          const headBefore = state.store.getWorkspaceHead(state.workspaceId);
          state.store.close();

          // A new process opens the same durable store.
          const reopened = ControlStore.open(state.storePath);
          try {
            const after: typeof before = [];
            for (;;) {
              const batch = reopened.listEvents(state.sessionId, after.length, 500);
              after.push(...batch);
              if (batch.length < 500) {
                break;
              }
            }
            if (after.length !== before.length) {
              return {
                outcome: "fail",
                reason: "the restart lost or invented events",
                detail: `${after.length} after != ${before.length} before`,
              };
            }
            for (let index = 0; index < before.length; index += 1) {
              if (
                after[index]!.sequence !== before[index]!.sequence ||
                after[index]!.type !== before[index]!.type
              ) {
                return {
                  outcome: "fail",
                  reason: "replayed events differ from the committed ones",
                  detail: `position ${index} changed`,
                };
              }
            }

            // Committed state survived with its events: the sequence
            // counter admits no gap, and each checkpointed revision the
            // journal names is still readable.
            const session = reopened.getSession(state.sessionId);
            if (session === null || session.eventSequence !== after.length) {
              return {
                outcome: "fail",
                reason: "the session counter disagrees with the replayed journal",
                detail: `counter ${session?.eventSequence} != ${after.length} events`,
              };
            }
            for (let index = 0; index < after.length; index += 1) {
              if (after[index]!.sequence !== index + 1) {
                return {
                  outcome: "fail",
                  reason: "replayed sequences have a gap",
                  detail: `position ${index} carries sequence ${after[index]!.sequence}`,
                };
              }
            }
            for (const event of after) {
              if (event.type === "workspace.checkpointed") {
                const revisionId = event.data["revisionId"];
                if (typeof revisionId !== "string" || reopened.getRevision(revisionId) === null) {
                  return {
                    outcome: "fail",
                    reason: "a replayed checkpoint event names state the restart lost",
                    detail: String(revisionId),
                  };
                }
              }
            }
            if (reopened.getWorkspaceHead(state.workspaceId) !== headBefore) {
              return {
                outcome: "fail",
                reason: "the workspace head moved across the restart",
              };
            }
            return undefined;
          } finally {
            reopened.close();
          }
        } finally {
          state.done();
        }
      },
    },
    {
      id: "events.duplicate-delivery",
      area: "events",
      summary: "Delivering the same window twice changes nothing and stays detectable.",
      async run() {
        const state = bench();
        try {
          for (let index = 0; index < 3; index += 1) {
            commit(state, `duplicate-${index}`);
          }
          const whole = allEvents(state);

          // Two independent passes deliver the same immutable records:
          // duplicate delivery is detectable by (session, sequence).
          const second = allEvents(state);
          const keyOf = (event: (typeof whole)[number]) => `${event.sessionId}:${event.sequence}`;
          const firstKeys = whole.map(keyOf);
          const secondKeys = second.map(keyOf);
          if (JSON.stringify(firstKeys) !== JSON.stringify(secondKeys)) {
            return {
              outcome: "fail",
              reason: "two passes over the journal disagree",
            };
          }
          const asText = whole.map((event) => JSON.stringify(event));
          const secondText = second.map((event) => JSON.stringify(event));
          if (JSON.stringify(asText) !== JSON.stringify(secondText)) {
            return {
              outcome: "fail",
              reason: "event content changed between deliveries",
            };
          }

          // A consumer that reconnects and re-reads one window gets the
          // identical bytes; a duplicate never overwrites the record.
          const mid = whole[Math.floor(whole.length / 2)]!.sequence;
          const windowOne = state.store.listEvents(state.sessionId, mid - 1, 2);
          const windowTwo = state.store.listEvents(state.sessionId, mid - 1, 2);
          if (
            JSON.stringify(windowOne.map((event) => JSON.stringify(event))) !==
            JSON.stringify(windowTwo.map((event) => JSON.stringify(event)))
          ) {
            return {
              outcome: "fail",
              reason: "re-reading one window returned different events",
            };
          }
          if (state.store.getSession(state.sessionId)?.eventSequence !== whole.length) {
            return {
              outcome: "fail",
              reason: "duplicate delivery moved the session sequence counter",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
    {
      id: "events.state-transaction-consistency",
      area: "events",
      summary: "State changes and their events commit together or not at all.",
      async run(): Promise<ConformanceCaseAnswer | void> {
        const state = bench();
        try {
          const first = commit(state, "consistent-1");
          const second = commit(state, "consistent-2");

          // Every committed checkpoint event names readable state, and
          // the head matches the newest one.
          const events = allEvents(state);
          const checkpoints = events.filter((event) => event.type === "workspace.checkpointed");
          if (checkpoints.length !== 2) {
            return {
              outcome: "fail",
              reason: "two committed checkpoints did not record two events",
              detail: `${checkpoints.length} events`,
            };
          }
          for (const event of checkpoints) {
            const revisionId = event.data["revisionId"];
            if (typeof revisionId !== "string" || state.store.getRevision(revisionId) === null) {
              return {
                outcome: "fail",
                reason: "an event claims a revision the store does not hold",
              };
            }
          }
          if (state.store.getWorkspaceHead(state.workspaceId) !== second.revision.id) {
            return {
              outcome: "fail",
              reason: "the head does not match the newest committed event",
            };
          }

          // A refused state change appends nothing: a checkpoint under a
          // head that moved refuses, and the journal stands still.
          const countBefore = allEvents(state).length;
          let refused: unknown = null;
          try {
            checkpointWorkspace(
              state.store,
              state.sessionId,
              state.blobs,
              {
                requestKey: `stale-${randomUUID()}`,
                source: { kind: "bridge", rootPath: state.source() },
                expectedHead: first.revision.id,
              },
              { stability: { kind: "locked" } },
            );
          } catch (error) {
            refused = error;
          }
          const conflict = errorOf(refused);
          if (conflict?.code !== "WorkspaceConflict") {
            return {
              outcome: "fail",
              reason: "the stale checkpoint did not refuse with a conflict",
              detail: String(conflict?.code ?? refused),
            };
          }
          if (allEvents(state).length !== countBefore) {
            return {
              outcome: "fail",
              reason: "a refused state change still appended an event",
            };
          }
          if (state.store.getSession(state.sessionId)?.eventSequence !== countBefore) {
            return {
              outcome: "fail",
              reason: "a refused state change still moved the sequence counter",
            };
          }
          return undefined;
        } finally {
          state.done();
        }
      },
    },
  ];
}
