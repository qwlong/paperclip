import { AsyncLocalStorage } from "node:async_hooks";

// A transaction holds one pool connection for its whole lifetime. If its work
// then queries the root client, it waits for a second connection while still
// holding the first, plus any locks it took. Once enough transactions do this
// at the same time, every connection belongs to a transaction waiting for a
// connection, and the pool stops making progress until something times out.
// This module notices root-client queries issued from inside an open
// transaction so they can be moved onto that transaction.

type RootClient = { unsafe: (...args: any[]) => any };
type Transactional = { transaction: (...args: any[]) => Promise<any> };
type OpenTransaction = { client: RootClient; open: boolean };
export type PoolReentry = { stack: string };
export type PoolReentryHandler = (reentry: PoolReentry) => void;

const openTransactions = new AsyncLocalStorage<OpenTransaction>();
const handlers = new WeakMap<RootClient, PoolReentryHandler>();
const reportedStacks = new Set<string>();

/** Each distinct call site is reported once per process. */
export function warnPoolReentryOnce(reentry: PoolReentry) {
  if (reportedStacks.has(reentry.stack)) return;
  reportedStacks.add(reentry.stack);
  process.emitWarning(`Query used a second pool connection inside an open transaction\n${reentry.stack}`, {
    code: "PAPERCLIP_DB_POOL_REENTRY",
  });
}

function callSite(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const frames = stack.split("\n").slice(1);
  return frames.filter(frame => !frame.includes("node_modules") && !frame.includes("node:")
    && !frame.includes("pool-reentry.ts")).slice(0, 8).join("\n");
}

export function setPoolReentryHandler(client: RootClient, handler: PoolReentryHandler) {
  handlers.set(client, handler);
}

/** Installed once per root pool by createDb. Changes no query behavior. */
export function detectPoolReentry<T extends Transactional>(db: T, client: RootClient, handler: PoolReentryHandler = warnPoolReentryOnce): T {
  handlers.set(client, handler);
  const unsafe = client.unsafe;
  client.unsafe = function (...args: any[]) {
    const current = openTransactions.getStore();
    if (current?.open && current.client === client) handlers.get(client)?.({ stack: callSite() });
    return unsafe.apply(this, args);
  };
  const transaction = db.transaction;
  db.transaction = function (callback: (tx: unknown) => Promise<unknown>, ...options: any[]) {
    // The driver acquires the connection by sending BEGIN through the root
    // client, so the transaction counts as open only once its work starts.
    const state: OpenTransaction = { client, open: false };
    return openTransactions.run(state, async () => {
      try {
        return await transaction.call(this, (tx: unknown) => {
          state.open = true;
          return callback(tx);
        }, ...options);
      } finally { state.open = false; }
    });
  };
  return db;
}
