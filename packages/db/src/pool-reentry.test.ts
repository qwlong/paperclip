import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withDedicatedDbConnection } from "./client.js";
import { setPoolReentryHandler, type PoolReentry } from "./pool-reentry.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pool re-entry detection", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const reports: PoolReentry[] = [];
  const recorded = async (work: () => Promise<unknown>) => {
    reports.length = 0;
    await work();
    return reports.length;
  };
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("pool-reentry-");
    db = createDb(temporary.connectionString);
    setPoolReentryHandler(db.$client, reentry => reports.push(reentry));
    await db.execute(sql`create table pool_reentry_test (id text primary key)`);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it("reports a root-pool query issued while a transaction is open, naming the caller", async () => {
    expect(await recorded(() => db.transaction(async () => {
      await db.execute(sql`select 1`);
    }))).toBe(1);
    expect(reports[0]!.stack).toContain("pool-reentry.test.ts");
  });

  it("names the code that opened the transaction holding the first connection", async () => {
    async function openLedgerTransaction() {
      return db.transaction(async () => { await queryFromElsewhere(); });
    }
    async function queryFromElsewhere() {
      await db.execute(sql`select 1`);
    }
    expect(await recorded(openLedgerTransaction)).toBe(1);
    expect(reports[0]!.openedAt).toContain("openLedgerTransaction");
    expect(reports[0]!.stack).toContain("queryFromElsewhere");
  });

  it("reports root-pool queries from inside a nested savepoint", async () => {
    expect(await recorded(() => db.transaction(tx => tx.transaction(async () => {
      await db.execute(sql`select 1`);
    })))).toBe(1);
  });

  it.each([
    ["queries outside any transaction", () => db.execute(sql`select 1`)],
    ["queries on the transaction itself", () => db.transaction(async tx => {
      await tx.execute(sql`select 1`);
      await tx.transaction(nested => nested.execute(sql`select 1`));
    })],
    ["work the transaction started that runs after it commits", async () => {
      let later!: Promise<unknown>;
      await db.transaction(async tx => {
        await tx.execute(sql`select 1`);
        later = new Promise(resolve => setTimeout(resolve, 20)).then(() => db.execute(sql`select 1`));
      });
      await later;
    }],
    ["a dedicated pool used from inside a transaction", () => db.transaction(() =>
      withDedicatedDbConnection(db, dedicated => {
        setPoolReentryHandler(dedicated.$client, reentry => reports.push(reentry));
        return dedicated.execute(sql`select 1`);
      }))],
  ])("does not report %s", async (_name, work) => {
    expect(await recorded(work)).toBe(0);
  });

  it("keeps transaction results and rollbacks unchanged", async () => {
    expect(await db.transaction(async tx => {
      await tx.execute(sql`insert into pool_reentry_test values ('kept')`);
      return 7;
    })).toBe(7);
    await expect(db.transaction(async tx => {
      await tx.execute(sql`insert into pool_reentry_test values ('rolled-back')`);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    const rows = await db.execute<{ id: string }>(sql`select id from pool_reentry_test order by id`);
    expect([...rows].map(row => row.id)).toEqual(["kept"]);
  });
});
