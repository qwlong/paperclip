import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
} from "@paperclipai/db";
import { INBOX_MINE_ISSUE_STATUS_FILTER } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BASE_TIME = Date.parse("2026-09-01T00:00:00.000Z");
const minutes = (n: number) => new Date(BASE_TIME + n * 60_000);

describeEmbeddedPostgres("GET /companies/:companyId/issues/inbox-unread-issue-ids", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-unread-issue-ids-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueReadStates);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function boardApp(userId: string, companyIds: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "session",
        userId,
        companyIds,
        memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "operator", status: "active" })),
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function seedUser() {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Board",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    return userId;
  }

  async function addMember(companyId: string, userId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Unread ${companyId}`,
      issuePrefix: `UC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
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

  /**
   * An issue the user created at `at` minutes; an agent replies one minute later,
   * which makes it unread unless `readAt` (minutes) is after that reply.
   */
  async function touchedIssue(input: {
    companyId: string;
    agentId: string;
    userId: string;
    at: number;
    status?: string;
    readAt?: number;
    archivedAt?: number;
    createdByUserId?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Issue at ${input.at}`,
      status: input.status ?? "todo",
      priority: "medium",
      createdByUserId: input.createdByUserId ?? input.userId,
      createdAt: minutes(input.at),
      updatedAt: minutes(input.at),
    });
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId,
      authorAgentId: input.agentId,
      body: "agent reply",
      createdAt: minutes(input.at + 1),
      updatedAt: minutes(input.at + 1),
    });
    if (input.readAt !== undefined) {
      await db.insert(issueReadStates).values({
        companyId: input.companyId,
        issueId,
        userId: input.userId,
        lastReadAt: minutes(input.readAt),
      });
    }
    if (input.archivedAt !== undefined) {
      await db.insert(issueInboxArchives).values({
        companyId: input.companyId,
        issueId,
        userId: input.userId,
        archivedAt: minutes(input.archivedAt),
      });
    }
    return issueId;
  }

  async function fetchUnreadIds(app: express.Express, companyId: string) {
    const res = await request(app).get(`/api/companies/${companyId}/issues/inbox-unread-issue-ids`).expect(200);
    return [...(res.body as { issueIds: string[] }).issueIds].sort();
  }

  it("lists only unread issues the user touched and has not archived", async () => {
    const { companyId, agentId } = await seedCompany();
    const other = await seedCompany();
    const userId = await seedUser();
    await addMember(companyId, userId);
    await addMember(other.companyId, userId);
    const base = { companyId, agentId, userId };

    const unreadTodo = await touchedIssue({ ...base, at: 10 });
    const unreadInReview = await touchedIssue({ ...base, at: 20, status: "in_review" });
    await touchedIssue({ ...base, at: 30, readAt: 40 });
    await touchedIssue({ ...base, at: 50, archivedAt: 60 });
    await touchedIssue({ ...base, at: 70, status: "cancelled" });
    await touchedIssue({ ...base, at: 80, createdByUserId: `user-${randomUUID()}` });
    await touchedIssue({ ...other, userId, at: 90 });

    const app = boardApp(userId, [companyId, other.companyId]);
    expect(await fetchUnreadIds(app, companyId)).toEqual([unreadTodo, unreadInReview].sort());
  });

  it("lists within the same most-recent window the Inbox list shows", async () => {
    const { companyId, agentId } = await seedCompany();
    const userId = await seedUser();
    await addMember(companyId, userId);
    const base = { companyId, agentId, userId };

    // Oldest activity, unread: pushed out of the window by 100 newer issues.
    await touchedIssue({ ...base, at: 0 });
    for (let i = 1; i <= 99; i += 1) {
      await touchedIssue({ ...base, at: 10 * i, readAt: 10 * i + 5 });
    }
    // Newest activity, unread: inside the window.
    const newest = await touchedIssue({ ...base, at: 5_000 });

    const app = boardApp(userId, [companyId]);
    const list = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        status: INBOX_MINE_ISSUE_STATUS_FILTER,
        limit: 500,
      })
      .expect(200);
    // Precondition: both unread issues exist, so only the window can exclude one.
    expect(list.body).toHaveLength(101);
    expect(list.body.filter((issue: { isUnreadForMe?: boolean }) => issue.isUnreadForMe)).toHaveLength(2);

    expect(await fetchUnreadIds(app, companyId)).toEqual([newest]);
  });

  it("rejects actors that are not a board user", async () => {
    const { companyId, agentId } = await seedCompany();
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_jwt", agentId, companyId, runId: randomUUID() } as never;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);

    await request(app).get(`/api/companies/${companyId}/issues/inbox-unread-issue-ids`).expect(403);
  });
});
