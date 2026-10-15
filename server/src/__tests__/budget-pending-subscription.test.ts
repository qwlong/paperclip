import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetPolicies, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { computeObservedSpend, policyBlocks } from "../services/budgets.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// A pending run whose usage is included in a subscription can only settle at
// $0, so it must not hard-stop a budget. Every other pending run still must.
describe("budget hard-stop for runs awaiting accounting", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-budget-pending-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function scope() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Budget", issuePrefix: `B${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claudia", role: "engineer", adapterType: "claude_local" });
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agentId, windowKind: "lifetime", amount: 8000 }).returning();
    return { companyId, agentId, policy };
  }
  async function pendingRun(owner: { companyId: string; agentId: string }, usage: Record<string, unknown>, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: owner.companyId, agentId: owner.agentId, status: "failed", costAccountingPending: true,
      finishedAt: new Date(), usageJson: { accountingReceiptReady: false, ...usage }, ...overrides,
    }).returning();
    return row;
  }

  it("blocks nothing when the scope has no pending runs (fixture sanity)", async () => {
    const { policy } = await scope();
    expect(policy.hardStopEnabled).toBe(true);
    expect(await policyBlocks(db, policy)).toBe(false);
  });

  it("does not hard-stop on a pending run billed as included subscription usage", async () => {
    const owner = await scope();
    await pendingRun(owner, { billingType: "subscription_included" });
    expect(await computeObservedSpend(db, owner.policy)).toMatchObject({ pendingRunCount: 0, recoveringRunCount: 0 });
    expect(await policyBlocks(db, owner.policy)).toBe(false);
  });

  it.each([
    ["no billing type yet", {}],
    ["metered API usage", { billingType: "metered_api" }],
    ["subscription overage", { billingType: "subscription_overage" }],
    ["unknown billing", { billingType: "unknown" }],
    ["credits", { billingType: "credits" }],
  ])("still hard-stops on a pending run with %s", async (_label, usage) => {
    const owner = await scope();
    await pendingRun(owner, usage);
    expect((await computeObservedSpend(db, owner.policy)).pendingRunCount).toBe(1);
    expect(await policyBlocks(db, owner.policy)).toBe(true);
  });

  it("still hard-stops when a metered pending run sits beside a subscription one", async () => {
    const owner = await scope();
    await pendingRun(owner, { billingType: "subscription_included" });
    await pendingRun(owner, { billingType: "metered_api" });
    expect((await computeObservedSpend(db, owner.policy)).pendingRunCount).toBe(1);
    expect(await policyBlocks(db, owner.policy)).toBe(true);
  });

  it("does not let a recovering subscription run offset a metered pending run", async () => {
    const owner = await scope();
    const [issue] = await db.insert(issues).values({ companyId: owner.companyId, title: "Native task" }).returning();
    const recovering = await pendingRun(owner, { billingType: "subscription_included" }, { runtimeMode: "native", nativeIssueId: issue.id });
    await db.insert(nativeRunFinalizations).values({ companyId: owner.companyId, runId: recovering.id, issueId: issue.id, phase: "recovering" });
    await pendingRun(owner, { billingType: "metered_api" });
    expect(await policyBlocks(db, owner.policy)).toBe(true);
  });
});
