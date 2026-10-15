import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const STALE = new Date(Date.now() - 60 * 60_000);
type Queue = "stranded_comments" | "comment_interrupt";

describeEmbeddedPostgres("periodic deferred-wake scans skip finished issues", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-finished-deferred-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(issueStatus: string, queue: Queue) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    const wakeId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Finished Issue Co", issuePrefix: "FIN", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Legacy Agent", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "queue-owner", status: "active", membershipRole: "operator",
    });
    await db.insert(issues).values({
      id: issueId, companyId, identifier: "FIN-1", title: "Finished work", status: issueStatus,
      priority: "medium", assigneeAgentId: agentId, executionRunId: null,
    });
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId, authorType: "user", authorUserId: "queue-owner", body: "Saved message",
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId, agentId, invocationSource: "assignment",
      status: "failed",
      runtimeMode: "legacy", startedAt: STALE, finishedAt: STALE, contextSnapshot: { issueId },
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeId, companyId, agentId, source: "automation", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "queue-owner",
      payload: {
        issueId, commentId, mutation: "comment",
        _paperclipWakeContext: { commentId, wakeCommentId: commentId, wakeCommentIds: [commentId] },
        ...(queue === "comment_interrupt" ? { queuedCommentInterrupt: { actorId: "queue-owner" } } : {}),
      },
      requestedAt: STALE, updatedAt: STALE,
    });
    return { companyId, wakeId };
  }

  async function scanTouches(issueStatus: string, queue: Queue) {
    const { companyId, wakeId } = await seed(issueStatus, queue);
    await heartbeatService(db).resumeQueuedRuns();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    const wakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    return { touched: wake!.updatedAt.getTime() !== STALE.getTime(), wakeCount: wakes.length, status: wake!.status };
  }

  it.each(["stranded_comments", "comment_interrupt"] as const)(
    "precondition: a %s queue on an open issue is revisited by the scan",
    async queue => {
      expect((await scanTouches("in_progress", queue)).touched).toBe(true);
    },
  );

  it.each([
    ["done", "stranded_comments"],
    ["cancelled", "stranded_comments"],
    ["done", "comment_interrupt"],
    ["cancelled", "comment_interrupt"],
  ] as const)("leaves a %s issue's %s queue alone", async (issueStatus, queue) => {
    const result = await scanTouches(issueStatus, queue);
    expect(result).toEqual({ touched: false, wakeCount: 1, status: "deferred_issue_execution" });
  });
});
