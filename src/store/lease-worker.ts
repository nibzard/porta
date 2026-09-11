import { ControlStore, StoreError } from "./control-store.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Race two controller processes on one attachment's mutation lease.
 *
 * Role `stale`: acquire a short lease, sleep past its expiry, then try to
 * commit a delayed provider response under the old token. Role `fresh`:
 * wait for the stale lease to expire, acquire the next token, and commit.
 * Prints one JSON line describing what happened.
 */
async function main(): Promise<void> {
  const [dbPath, role] = process.argv.slice(2);
  if (dbPath === undefined || (role !== "stale" && role !== "fresh")) {
    process.stderr.write("usage: node lease-worker.js <db-path> <stale|fresh>\n");
    process.exitCode = 1;
    return;
  }
  const store = ControlStore.open(dbPath);
  const result: Record<string, unknown> = { role };

  if (role === "stale") {
    const lease = store.acquireMutationLease("sess-1", "att-1", "stale-controller", 40);
    result.token = lease.fencingToken;
    // The provider answers long after the lease expired and was taken over.
    await sleep(300);
    try {
      store.mutateWithLease("sess-1", "att-1", lease.fencingToken, () =>
        store.appendEvent("sess-1", "attachment.released", "att-1", { by: "stale" }),
      );
      result.committed = true;
    } catch (error) {
      result.committed = false;
      result.reason = error instanceof StoreError ? error.kind : "unknown";
    }
  } else {
    // Let the stale controller's lease run out first.
    await sleep(150);
    const lease = store.acquireMutationLease("sess-1", "att-1", "fresh-controller", 10_000);
    result.token = lease.fencingToken;
    store.mutateWithLease("sess-1", "att-1", lease.fencingToken, () =>
      store.appendEvent("sess-1", "attachment.released", "att-1", { by: "fresh" }),
    );
    result.committed = true;
  }

  store.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
