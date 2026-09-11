import { ControlStore, StoreError } from "./control-store.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Race several node processes against one control store file.
 *
 * Each worker tries to create the same session, then appends events.
 * Exactly one worker wins the session; every worker's events must land
 * with unique, gapless sequences. Prints one JSON line on stdout.
 */
async function main(): Promise<void> {
  const [dbPath, workerId] = process.argv.slice(2);
  if (dbPath === undefined || workerId === undefined) {
    process.stderr.write("usage: node concurrency-worker.js <db-path> <worker-id>\n");
    process.exitCode = 1;
    return;
  }
  const store = ControlStore.open(dbPath);
  let won = false;
  try {
    store.createSession({
      id: "sess-race",
      schemaVersion: 1,
      status: "open",
      workspaceId: "ws-race",
      eventSequence: 0,
      policyRef: "policy://race",
      createdAt: "2026-09-11T00:00:00Z",
    });
    won = true;
  } catch (error) {
    if (!(error instanceof StoreError) || error.kind !== "unique") {
      throw error;
    }
  }
  const sequences: number[] = [];
  // The winner's session row may not be visible yet; retry briefly.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      for (let round = 0; round < 3; round += 1) {
        const event = store.appendEvent("sess-race", "operation.updated", `op-${workerId}`, {
          worker: workerId,
          round,
        });
        sequences.push(event.sequence);
      }
      break;
    } catch (error) {
      if (error instanceof StoreError && error.kind === "not-found") {
        await sleep(10);
        continue;
      }
      throw error;
    }
  }
  store.close();
  process.stdout.write(`${JSON.stringify({ worker: workerId, won, sequences })}\n`);
}

await main();
