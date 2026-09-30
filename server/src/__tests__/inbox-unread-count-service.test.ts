import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
} from "@paperclipai/db";
import {
  countUnreadRecentTouchedIssues,
  INBOX_MINE_ISSUE_STATUS_FILTER,
  INBOX_TOUCHED_ISSUE_FETCH_LIMIT,
  RECENT_ISSUES_LIMIT,
} from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BASE_TIME = Date.parse("2026-09-01T00:00:00.000Z");
const minutes = (n: number) => new Date(BASE_TIME + n * 60_000);

const PRIORITIES = ["critical", "high", "medium", "low"] as const;
const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"] as const;
const TOUCHES = ["created", "assigned", "commented", "participated", "none"] as const;

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describeEmbeddedPostgres("issueService.countInboxUnreadIssues", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-unread-count-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueReadStates);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Unread ${companyId}`,
      issuePrefix: `US${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Replier",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function countFromList(companyId: string, userId: string) {
    const rows = await issueService(db).list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      status: INBOX_MINE_ISSUE_STATUS_FILTER,
      limit: INBOX_TOUCHED_ISSUE_FETCH_LIMIT,
    });
    return {
      count: countUnreadRecentTouchedIssues(rows),
      rows: rows.length,
      unreadAnywhere: rows.filter((row) => row.isUnreadForMe).length,
    };
  }

  /** Random issues touched in every way the Inbox recognises, with ties on the minute. */
  async function seedRandomInbox(seed: number, issueCount: number) {
    const random = seededRandom(seed);
    const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
    const at = () => Math.floor(random() * 400);
    const { companyId, agentId } = await seedCompany();
    const userId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;

    const issueRows: Array<typeof issues.$inferInsert> = [];
    const commentRows: Array<typeof issueComments.$inferInsert> = [];
    const readRows: Array<typeof issueReadStates.$inferInsert> = [];
    const archiveRows: Array<typeof issueInboxArchives.$inferInsert> = [];
    const logRows: Array<typeof activityLog.$inferInsert> = [];

    for (let i = 0; i < issueCount; i += 1) {
      const id = randomUUID();
      const touch = pick(TOUCHES);
      const createdAt = at();
      const updatedAt = createdAt + Math.floor(random() * 20);
      issueRows.push({
        id,
        companyId,
        title: `Issue ${i}`,
        status: pick(STATUSES),
        priority: pick(PRIORITIES),
        createdByUserId: touch === "created" ? userId : otherUserId,
        assigneeUserId: touch === "assigned" ? userId : null,
        createdAt: minutes(createdAt),
        updatedAt: minutes(updatedAt),
        hiddenAt: random() < 0.05 ? minutes(at()) : null,
        originKind: random() < 0.05 ? "plugin:acme:operation" : "manual",
      });
      if (random() < 0.2) {
        const otherAt = at();
        commentRows.push({ companyId, issueId: id, authorUserId: otherUserId, body: "human", createdAt: minutes(otherAt), updatedAt: minutes(otherAt) });
      }
      if (touch === "commented") {
        commentRows.push({ companyId, issueId: id, authorUserId: userId, body: "mine", createdAt: minutes(at()), updatedAt: minutes(at()) });
      }
      if (touch === "participated") {
        logRows.push({ companyId, actorType: "user", actorId: userId, action: "issue.updated", entityType: "issue", entityId: id, createdAt: minutes(at()) });
      }
      if (random() < 0.7) {
        const replyAt = at();
        commentRows.push({ companyId, issueId: id, authorAgentId: agentId, body: "reply", createdAt: minutes(replyAt), updatedAt: minutes(replyAt) });
      }
      if (random() < 0.4) {
        readRows.push({ companyId, issueId: id, userId, lastReadAt: minutes(at()) });
      }
      if (random() < 0.15) {
        archiveRows.push({ companyId, issueId: id, userId, archivedAt: minutes(at()) });
      }
      if (random() < 0.3) {
        logRows.push({ companyId, actorType: "agent", actorId: agentId, action: "issue.updated", entityType: "issue", entityId: id, createdAt: minutes(at()) });
      }
    }

    // A conversation container the user created, with an unread reply: the Inbox never lists it.
    const conversationId = randomUUID();
    issueRows.push({
      id: conversationId,
      companyId,
      title: "Conversation",
      status: "todo",
      priority: "critical",
      createdByUserId: userId,
      assigneeAgentId: agentId,
      conversationAgentId: agentId,
      conversationUserId: userId,
      conversationState: "active",
      createdAt: minutes(500),
      updatedAt: minutes(500),
    });
    commentRows.push({ companyId, issueId: conversationId, authorAgentId: agentId, body: "reply", createdAt: minutes(501), updatedAt: minutes(501) });

    await db.insert(issues).values(issueRows);
    if (commentRows.length > 0) await db.insert(issueComments).values(commentRows);
    if (readRows.length > 0) await db.insert(issueReadStates).values(readRows);
    if (archiveRows.length > 0) await db.insert(issueInboxArchives).values(archiveRows);
    if (logRows.length > 0) await db.insert(activityLog).values(logRows);
    return { companyId, userId };
  }

  it.each([1, 2, 3, 4, 5])("matches the Inbox list's unread count (seed %i)", async (seed) => {
    const { companyId, userId } = await seedRandomInbox(seed, 260);
    const expected = await countFromList(companyId, userId);
    // Precondition: the fixture is big enough that the recent window excludes unread issues.
    expect(expected.rows).toBeGreaterThan(RECENT_ISSUES_LIMIT);
    expect(expected.unreadAnywhere).toBeGreaterThan(expected.count);
    expect(expected.count).toBeGreaterThan(0);

    expect(await issueService(db).countInboxUnreadIssues(companyId, userId)).toBe(expected.count);
  });

  it("compares read and reply times at the millisecond precision the Inbox list uses", async () => {
    const { companyId, agentId } = await seedCompany();
    const userId = `user-${randomUUID()}`;
    const sameMsId = randomUUID();
    const laterMsId = randomUUID();
    await db.insert(issues).values([
      { id: sameMsId, companyId, title: "Same ms", status: "todo", priority: "medium", createdByUserId: userId, createdAt: minutes(0), updatedAt: minutes(0) },
      { id: laterMsId, companyId, title: "Later ms", status: "todo", priority: "medium", createdByUserId: userId, createdAt: minutes(1), updatedAt: minutes(1) },
    ]);
    const readAt = sql`'2026-09-01T01:00:00.000100Z'::timestamptz`;
    await db.insert(issueReadStates).values([
      { companyId, issueId: sameMsId, userId, lastReadAt: readAt },
      { companyId, issueId: laterMsId, userId, lastReadAt: readAt },
    ] as never);
    await db.insert(issueComments).values([
      { companyId, issueId: sameMsId, authorAgentId: agentId, body: "same ms", createdAt: sql`'2026-09-01T01:00:00.000900Z'::timestamptz`, updatedAt: minutes(60) },
      { companyId, issueId: laterMsId, authorAgentId: agentId, body: "later ms", createdAt: sql`'2026-09-01T01:00:00.001100Z'::timestamptz`, updatedAt: minutes(60) },
    ] as never);

    const expected = await countFromList(companyId, userId);
    // Precondition: only the reply in a later millisecond is unread for the list.
    expect(expected).toEqual({ count: 1, rows: 2, unreadAnywhere: 1 });

    expect(await issueService(db).countInboxUnreadIssues(companyId, userId)).toBe(1);
  });

  /**
   * 99 newer read issues fill the window but one slot; two issues tie on last activity
   * for the last slot. Only `unreadId` is unread, so the count says which one got the slot.
   */
  type TiedIssue = { id: string; priority: string; updatedAt: number; replyAt?: string };
  async function seedTieAtWindowEdge(tie: { unread: TiedIssue; read: TiedIssue }) {
    const { companyId, agentId } = await seedCompany();
    const userId = `user-${randomUUID()}`;
    const issueRows: Array<typeof issues.$inferInsert> = [];
    const readRows: Array<typeof issueReadStates.$inferInsert> = [];
    for (let i = 0; i < RECENT_ISSUES_LIMIT - 1; i += 1) {
      const id = randomUUID();
      issueRows.push({ id, companyId, title: `Newer ${i}`, status: "todo", priority: "medium", createdByUserId: userId, createdAt: minutes(1_000 + i), updatedAt: minutes(1_000 + i) });
      readRows.push({ companyId, issueId: id, userId, lastReadAt: minutes(5_000) });
    }
    for (const [name, row] of Object.entries(tie)) {
      issueRows.push({ id: row.id, companyId, title: name, status: "todo", priority: row.priority, createdByUserId: userId, createdAt: minutes(0), updatedAt: minutes(row.updatedAt) });
    }
    readRows.push({ companyId, issueId: tie.read.id, userId, lastReadAt: minutes(5_000) });
    await db.insert(issues).values(issueRows);
    await db.insert(issueReadStates).values(readRows);
    // Both tied issues' last activity is this reply.
    await db.insert(issueComments).values(
      [tie.unread, tie.read].map((row) => ({
        companyId,
        issueId: row.id,
        authorAgentId: agentId,
        body: "reply",
        createdAt: row.replyAt ? sql`${row.replyAt}::timestamptz` : minutes(500),
        updatedAt: minutes(500),
      })) as never,
    );
    return { companyId, userId };
  }

  it.each([
    {
      name: "the later update wins a tie on last activity",
      unread: { id: randomUUID(), priority: "low", updatedAt: 200 },
      read: { id: randomUUID(), priority: "critical", updatedAt: 100 },
      expected: 1,
    },
    {
      name: "the list's own order wins a tie on last activity and update",
      unread: { id: "ffffffff-ffff-4fff-bfff-ffffffffffff", priority: "low", updatedAt: 100 },
      read: { id: "00000000-0000-4000-8000-000000000000", priority: "critical", updatedAt: 100 },
      expected: 0,
    },
    {
      name: "the list's own order wins a tie within the same millisecond",
      unread: { id: "ffffffff-ffff-4fff-bfff-ffffffffffff", priority: "medium", updatedAt: 100, replyAt: "2026-09-01T08:20:00.000100Z" },
      read: { id: "00000000-0000-4000-8000-000000000000", priority: "medium", updatedAt: 100, replyAt: "2026-09-01T08:20:00.000900Z" },
      expected: 0,
    },
  ])("breaks ties at the window edge like the Inbox list: $name", async ({ unread, read, expected }) => {
    const { companyId, userId } = await seedTieAtWindowEdge({ unread, read });
    const fromList = await countFromList(companyId, userId);
    // Precondition: both tied issues are fetched and only one fits in the window.
    expect(fromList.rows).toBe(RECENT_ISSUES_LIMIT + 1);
    expect(fromList.count).toBe(expected);

    expect(await issueService(db).countInboxUnreadIssues(companyId, userId)).toBe(expected);
  });

  it("windows the same prefetch the Inbox list does when more issues are touched than it fetches", async () => {
    const { companyId, agentId } = await seedCompany();
    const userId = `user-${randomUUID()}`;
    const issueRows: Array<typeof issues.$inferInsert> = [];
    const readRows: Array<typeof issueReadStates.$inferInsert> = [];
    for (let i = 0; i < INBOX_TOUCHED_ISSUE_FETCH_LIMIT; i += 1) {
      const id = randomUUID();
      issueRows.push({ id, companyId, title: `Old ${i}`, status: "todo", priority: "high", createdByUserId: userId, createdAt: minutes(i), updatedAt: minutes(i) });
      readRows.push({ companyId, issueId: id, userId, lastReadAt: minutes(10_000) });
    }
    const lowPriorityId = randomUUID();
    issueRows.push({ id: lowPriorityId, companyId, title: "Newest", status: "todo", priority: "low", createdByUserId: userId, createdAt: minutes(20_000), updatedAt: minutes(20_000) });
    await db.insert(issues).values(issueRows);
    await db.insert(issueReadStates).values(readRows);
    await db.insert(issueComments).values({ companyId, issueId: lowPriorityId, authorAgentId: agentId, body: "reply", createdAt: minutes(20_001), updatedAt: minutes(20_001) });

    const expected = await countFromList(companyId, userId);
    // Precondition: the prefetch is full, so the newest low-priority issue is left out of it.
    expect(expected.rows).toBe(INBOX_TOUCHED_ISSUE_FETCH_LIMIT);
    expect(expected.count).toBe(0);

    expect(await issueService(db).countInboxUnreadIssues(companyId, userId)).toBe(0);
  });
});
