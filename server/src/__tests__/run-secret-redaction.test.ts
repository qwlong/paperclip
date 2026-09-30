import { randomUUID } from "node:crypto";
import { sql, type SQLWrapper } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createRunSecretRedactionRegistry, redactRegisteredSecretValues } from "../services/run-secret-redaction.js";

const secret = "q2a-exact-secret-value";

describe("registered run secret redaction", () => {
  it("redacts exact values across comment and heartbeat/wake projections", () => {
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${secret}` },
        wakeComment: { body: secret },
      },
      wakePayload: {
        comments: [{ body: `prefix-${secret}-suffix` }],
        continuationSummary: { body: secret },
      },
    }, [secret]);

    expect(result).toEqual({
      comment: { body: `agent pasted ${REDACTED_EVENT_VALUE} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${REDACTED_EVENT_VALUE}` },
        wakeComment: { body: REDACTED_EVENT_VALUE },
      },
      wakePayload: {
        comments: [{ body: `prefix-${REDACTED_EVENT_VALUE}-suffix` }],
        continuationSummary: { body: REDACTED_EVENT_VALUE },
      },
    });
  });

  it("redacts run detail, event, and transcript fields and strips registry material", () => {
    const result = redactRegisteredSecretValues({
      contextSnapshot: {
        issueId: "issue-1",
        paperclipSecretRedactions: [{ material: { ciphertext: "encrypted" } }],
      },
      stdoutExcerpt: `stdout ${secret}`,
      events: [{ message: secret, payload: { output: secret } }],
      log: { content: `tool returned ${secret}` },
    }, [secret]);

    expect(result).toEqual({
      contextSnapshot: { issueId: "issue-1" },
      stdoutExcerpt: `stdout ${REDACTED_EVENT_VALUE}`,
      events: [{ message: REDACTED_EVENT_VALUE, payload: { output: REDACTED_EVENT_VALUE } }],
      log: { content: `tool returned ${REDACTED_EVENT_VALUE}` },
    });
  });

  it("replaces longer registered values before overlapping shorter values", () => {
    expect(redactRegisteredSecretValues("token-extended token", ["token-extended", "token"]))
      .toBe(`${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances instead of collapsing them to empty objects (PAP-16607)", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret}`, createdAt, updatedAt: createdAt },
      nested: [{ finishedAt: createdAt }],
    }, [secret]);

    expect(result.comment.createdAt).toBeInstanceOf(Date);
    expect(result.comment.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
    expect(result.comment.updatedAt).toBeInstanceOf(Date);
    expect(result.nested[0]?.finishedAt).toBeInstanceOf(Date);
    expect(result.comment.body).toBe(`agent pasted ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances when no secret values are registered", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({ createdAt }, []);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });
});

const { resolveVersion } = vi.hoisted(() => ({ resolveVersion: vi.fn(async ({ material }) => material.value as string) }));
vi.mock("../secrets/provider-registry.js", () => ({ getSecretProvider: () => ({ resolveVersion }) }));

describe("batched run secret redaction", () => {
  beforeEach(() => { resolveVersion.mockClear(); });

  function fixture(rows: unknown[]) {
    const where = vi.fn(async (_predicate: import("drizzle-orm").SQL | undefined) => rows);
    const select = vi.fn((_columns: { contextSnapshot: import("drizzle-orm").SQL }) => ({ from: () => ({ where }) }));
    return { registry: createRunSecretRedactionRegistry({ select } as unknown as Db), select, where };
  }

  it("reads only registry JSON once for 200 runs and resolves shared secrets once", async () => {
    const contextSnapshot = { paperclipSecretRedactions: [{ fingerprintSha256: "shared", material: { value: secret } }] };
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `run-${i}`, contextSnapshot }));
    const { registry, select, where } = fixture(rows);
    const result = await registry.redactForRuns("company-1", rows.map(row => ({ ...row, stdoutExcerpt: secret })));
    expect(select).toHaveBeenCalledTimes(1);
    expect(resolveVersion).toHaveBeenCalledTimes(1);
    expect(result.every(run => run.stdoutExcerpt === REDACTED_EVENT_VALUE)).toBe(true);
    expect(result[0].contextSnapshot).toEqual({});
    const dialect = new PgDialect();
    const predicate = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(predicate.params).toContain("company-1");
    expect(predicate.sql).toContain('"company_id"');
    expect(dialect.sqlToQuery(select.mock.calls[0][0].contextSnapshot).sql).toContain("-> 'paperclipSecretRedactions'");
  });

  it("keeps each run's registry separate and observes new registrations on the next request", async () => {
    const rows = [{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: { value: secret } }] } }];
    const { registry } = fixture(rows);
    expect(await registry.redactForRuns("company", [{ id: "a", text: secret }, { id: "b", text: secret }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }, { id: "b", text: secret }]);
    rows[0].contextSnapshot.paperclipSecretRedactions.push({ fingerprintSha256: "two", material: { value: "new-secret" } });
    expect(await registry.redactForRuns("company", [{ id: "a", text: "new-secret" }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }]);
  });

  it("does not query for an empty list and fails closed on decryption failure", async () => {
    const { registry, select } = fixture([{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: {} }] } }]);
    expect(await registry.redactForRuns("company", [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    resolveVersion.mockRejectedValueOnce(new Error("unavailable"));
    await expect(registry.redactForRuns("company", [{ id: "a", text: secret }])).rejects.toThrow("unavailable");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue run secret redaction lookup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-secret-redaction-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RedactionRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const insertRun = (contextSnapshot: Record<string, unknown>) =>
      db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", contextSnapshot });
    return { companyId, insertRun };
  }

  const registered = (value: string) => ({
    paperclipSecretRedactions: [{ fingerprintSha256: value, material: { value } }],
  });

  it("applies the registries of runs linked to the issue by either context key, and no others", async () => {
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const { companyId, insertRun } = await seedCompany();
    const other = await seedCompany();
    await insertRun({ issueId, ...registered("by-issue-id") });
    await insertRun({ issueId: otherIssueId, paperclipIssue: { id: issueId }, ...registered("by-paperclip-issue") });
    await insertRun({ issueId, paperclipIssue: { id: issueId } });
    await insertRun({ issueId: otherIssueId, ...registered("other-issue") });
    await other.insertRun({ issueId, ...registered("other-company") });

    const registry = createRunSecretRedactionRegistry(db);
    const text = "by-issue-id by-paperclip-issue other-issue other-company";
    expect(await registry.redactForIssue(companyId, issueId, text))
      .toBe(`${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE} other-issue other-company`);
    expect(await registry.redactForIssue(companyId, randomUUID(), text)).toBe(text);
  });

  it("finds an issue's registries through an index instead of reading every run's context", async () => {
    const { companyId, insertRun } = await seedCompany();
    await insertRun({ issueId: randomUUID(), ...registered("secret") });
    let lookup: SQLWrapper | null = null;
    const capturingDb = {
      select: (fields: never) => ({
        from: (table: never) => {
          const query = db.select(fields).from(table);
          lookup = query;
          return query;
        },
      }),
    } as unknown as Db;
    await createRunSecretRedactionRegistry(capturingDb).redactForIssue(companyId, randomUUID(), "text");
    expect(lookup).not.toBeNull();

    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(sql`EXPLAIN (COSTS OFF) ${lookup}`);
    });
    const planText = [...plan].map((row) => Object.values(row)[0]).join("\n");
    expect(planText).not.toMatch(/Seq Scan on heartbeat_runs/);
    const scannedIndexes = [...planText.matchAll(/(?:Index Scan using|Index Scan on) (\S+)/g)].map((m) => m[1]);
    expect(scannedIndexes.length).toBeGreaterThan(0);
    const indexDefs = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'heartbeat_runs'
    `);
    const defByName = new Map([...indexDefs].map((row) => [row.indexname as string, row.indexdef as string]));
    // Every index the lookup reads must hold only runs that carry a registry;
    // any other index reaches runs whose multi-megabyte contexts get detoasted.
    for (const name of scannedIndexes) {
      expect(defByName.get(name)).toContain("? 'paperclipSecretRedactions'");
    }
  });
});
