import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, getTableName, inArray, isTable, or, sql } from "drizzle-orm";
import { createDb, executionWorkspaces, heartbeatRuns, issues, projects, type Db, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { assertExecutionWorkspaceRootReadAccess, executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { assertTaskWorkspaceAccess, assertTaskWorkspaceSourceProjectAccess, assertTaskWorkspacesAccess } from "../services/task-workspace-source-access.js";
import { accessService } from "../services/access.js";
import { authorizationService, executionWorkspaceReadSqlCondition, type AuthorizationActor } from "../services/authorization.js";
import { forbidden } from "../errors.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { createRepositoryTrustFixture } from "./helpers/repository-trust-fixture.js";

const acquisition = vi.hoisted(() => ({ managedAuth: vi.fn(), materialize: vi.fn(), catalog: vi.fn() }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => ({ listProjectRepositories: acquisition.catalog }) }));

// Counts every statement a service issues through the handle it was given, including
// statements issued inside transactions it opens on that handle.
const STATEMENT_METHODS = new Set(["select", "selectDistinct", "selectDistinctOn", "execute", "insert", "update", "delete"]);
function countingDb<T extends object>(target: T): { db: T; statements: () => number } {
  let count = 0;
  const wrap = (handle: any): any => new Proxy(handle, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      if (STATEMENT_METHODS.has(String(property))) return (...args: unknown[]) => { count += 1; return value.apply(object, args); };
      if (property === "transaction") return (run: (tx: unknown) => unknown, ...rest: unknown[]) => value.call(object, (tx: unknown) => run(wrap(tx)), ...rest);
      return value.bind(object);
    },
  });
  return { db: wrap(target) as T, statements: () => count };
}

// The per-workspace check exactly as it was before batching, kept verbatim so the
// batched path can be compared against it outcome for outcome.
async function referenceTaskWorkspaceAccess(db: Db, actor: AuthorizationActor, companyId: string, workspaceId: string) {
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, companyId),
    await executionWorkspaceReadSqlCondition(db, actor),
  ));
  if (!workspace) throw forbidden("Task workspace access is no longer available");
  await assertTaskWorkspaceSourceProjectAccess(db, actor, companyId, workspace.projectId, {});
  const retainedIssueIds = Object.keys(workspace.metadata?._issuePrivacySources ?? {});
  if (workspace.sourceIssueId) retainedIssueIds.push(workspace.sourceIssueId);
  const sources = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, companyId),
    or(eq(issues.executionWorkspaceId, workspaceId), retainedIssueIds.length > 0
      ? inArray(sql<string>`${issues.id}::text`, retainedIssueIds) : undefined),
  ));
  const sourceIds = new Set(sources.map(source => source.id));
  if (retainedIssueIds.some(id => !sourceIds.has(id))) throw forbidden("Task workspace source is no longer accessible");
  const access = accessService(db);
  if (sources.length === 0 && !workspace.projectId) {
    const decision = await access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } });
    if (!decision.allowed) throw forbidden("An unscoped workspace is outside this actor's authorization boundary");
  }
  for (const source of sources) {
    const decision = await access.decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId: source.id } });
    if (!decision.allowed) throw forbidden("Task workspace retains files outside this actor's authorization boundary");
  }
}

// Records the table behind every `select().from(table)` issued through the handle.
function tableReadsDb<T extends object>(target: T): { db: T; reads: (table: string) => number } {
  const tables: string[] = [];
  const builder = (query: any): any => new Proxy(query, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (property === "from" && typeof value === "function") {
        return (table: unknown, ...rest: unknown[]) => { if (isTable(table)) tables.push(getTableName(table)); return value.call(object, table, ...rest); };
      }
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  const handle = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (property === "select" && typeof value === "function") return (...args: unknown[]) => builder(value.apply(object, args));
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  return { db: handle as T, reads: table => tables.filter(name => name === table).length };
}

// Like tableReadsDb, but also records reads issued inside transactions opened on the handle.
function deepTableReadsDb<T extends object>(target: T): { db: T; reads: (table: string) => number } {
  const tables: string[] = [];
  const builder = (query: any): any => new Proxy(query, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (property === "from" && typeof value === "function") {
        return (table: unknown, ...rest: unknown[]) => { if (isTable(table)) tables.push(getTableName(table)); return value.call(object, table, ...rest); };
      }
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  const wrap = (handle: any): any => new Proxy(handle, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "select") return (...args: unknown[]) => builder(value.apply(object, args));
      if (property === "transaction") return (run: (tx: unknown) => unknown, ...rest: unknown[]) => value.call(object, (tx: unknown) => run(wrap(tx)), ...rest);
      return value.bind(object);
    },
  });
  return { db: wrap(target) as T, reads: table => tables.filter(name => name === table).length };
}

const outcome = (promise: Promise<unknown>) => promise.then(() => "allowed", (error: Error) => `denied: ${error.message}`);

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("batched task workspace access", () => {
  const context = createRepositoryTrustFixture(acquisition);
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { ({ db } = await context.setup()); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.clearAllMocks(); });
  afterAll(context.cleanup);
  const { fixture, standardPeer, privateTask, grantPeer } = context;

  async function addPeers(f: Awaited<ReturnType<typeof fixture>>, count: number, shared: { projectId?: string; sourceIssueId?: string } = {}) {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: `Peer ${index}`, cwd: f.admission.cwd,
        mode: "shared_workspace", strategyType: "operator_directory", ...shared }).returning();
      await db.insert(issues).values({ companyId: f.companyId, title: `Peer task ${index}`, assigneeAgentId: f.agentId, executionWorkspaceId: workspace.id });
      ids.push(workspace.id);
    }
    return ids;
  }

  async function rootReadStatements(f: Awaited<ReturnType<typeof fixture>>) {
    const counted = countingDb(db);
    await assertExecutionWorkspaceRootReadAccess(counted.db, { companyId: f.companyId, cwd: f.admission.cwd, actor: f.actor });
    return counted.statements();
  }

  it("authorizes each extra workspace sharing a root for no more than the decision on its own task", async () => {
    const f = await fixture();
    await addPeers(f, 2);
    const small = await rootReadStatements(f);
    await addPeers(f, 10);
    const large = await rootReadStatements(f);
    const [probe] = await db.insert(issues).values({ companyId: f.companyId, title: "Probe", assigneeAgentId: f.agentId }).returning();
    const counted = countingDb(db);
    await accessService(counted.db).decide({ actor: f.actor, action: "issue:read", resource: { type: "issue", companyId: f.companyId, issueId: probe.id } });
    const perTaskDecision = counted.statements();
    expect(perTaskDecision, "premise: deciding one task read issues statements").toBeGreaterThan(0);
    expect((large - small) / 10).toBeLessThanOrEqual(perTaskDecision);
  });

  it("decides a project or task shared by many workspaces once", async () => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Shared project" }).returning();
    const [shared] = await db.insert(issues).values({ companyId: f.companyId, title: "Shared source", assigneeAgentId: f.agentId, projectId: project.id }).returning();
    const statementsFor = async (count: number) => {
      const ids = await addPeers(f, count, { projectId: project.id, sourceIssueId: shared.id });
      await assertTaskWorkspacesAccess(db, f.actor, f.companyId, ids);
      const counted = countingDb(db);
      await assertTaskWorkspacesAccess(counted.db, f.actor, f.companyId, ids);
      return counted.statements();
    };
    const small = await statementsFor(2);
    const large = await statementsFor(10);
    const [probe] = await db.insert(issues).values({ companyId: f.companyId, title: "Probe", assigneeAgentId: f.agentId }).returning();
    const counted = countingDb(db);
    await accessService(counted.db).decide({ actor: f.actor, action: "issue:read", resource: { type: "issue", companyId: f.companyId, issueId: probe.id } });
    expect(await outcome(assertTaskWorkspacesAccess(db, f.actor, f.companyId, [])), "premise: an empty list is allowed").toBe("allowed");
    expect((large - small) / 8).toBeLessThan(counted.statements());
  });

  it("issues a fixed number of statements however many tasks share the root", async () => {
    const f = await fixture();
    const ids = await addPeers(f, 2);
    await assertTaskWorkspacesAccess(db, f.actor, f.companyId, ids);
    const few = countingDb(db);
    await assertTaskWorkspacesAccess(few.db, f.actor, f.companyId, ids);
    ids.push(...await addPeers(f, 10));
    const many = countingDb(db);
    await assertTaskWorkspacesAccess(many.db, f.actor, f.companyId, ids);
    const [probe] = await db.insert(issues).values({ companyId: f.companyId, title: "Probe", assigneeAgentId: f.agentId }).returning();
    const single = countingDb(db);
    await accessService(single.db).decide({ actor: f.actor, action: "issue:read", resource: { type: "issue", companyId: f.companyId, issueId: probe.id } });
    expect(single.statements(), "premise: deciding one task read issues statements").toBeGreaterThan(0);
    expect(many.statements()).toBe(few.statements());
  });

  it.each([
    ["the private task's sponsor", "owner"],
    ["another sponsor without a grant", "peer"],
    ["another sponsor with a grant", "granted"],
  ] as const)("decides task reads for %s the same with issues prefetched", async (_label, who) => {
    const f = await fixture();
    const peer = await standardPeer(f);
    await privateTask(f);
    if (who === "granted") await grantPeer(f, peer);
    const actor = who === "owner" ? f.actor : peer.actor;
    const issueIds = [f.issueId, peer.issueId, randomUUID()];
    const plain = authorizationService(db);
    const reference = [];
    for (const issueId of issueIds) reference.push(await plain.decide({ actor, action: "issue:read", resource: { type: "issue", companyId: f.companyId, issueId } }));
    if (who === "peer") expect(reference[0]!.allowed, "premise: a sponsor without a grant cannot read the private task").toBe(false);
    else expect(reference[0]!.allowed, "premise: the private task is readable").toBe(true);
    const prefetched = authorizationService(db, { rowMemo: new Map() });
    await prefetched.prefetchIssues(actor, f.companyId, issueIds);
    const decisions = [];
    for (const issueId of issueIds) decisions.push(await prefetched.decide({ actor, action: "issue:read", resource: { type: "issue", companyId: f.companyId, issueId } }));
    expect(decisions.map(d => [d.allowed, d.reason])).toEqual(reference.map(d => [d.allowed, d.reason]));
  });

  it("does not answer one actor's private task read from another actor's prefetch", async () => {
    const f = await fixture();
    const peer = await standardPeer(f);
    await privateTask(f);
    const shared = authorizationService(db, { rowMemo: new Map() });
    await shared.prefetchIssues(f.actor, f.companyId, [f.issueId]);
    const read = { action: "issue:read", resource: { type: "issue", companyId: f.companyId, issueId: f.issueId } } as const;
    expect((await shared.decide({ actor: f.actor, ...read })).allowed, "premise: the sponsor reads the private task").toBe(true);
    expect((await shared.decide({ actor: peer.actor, ...read })).allowed).toBe(false);
  });

  it("checks each workspace once when the same list repeats", async () => {
    const f = await fixture();
    const ids = await addPeers(f, 6);
    await assertTaskWorkspacesAccess(db, f.actor, f.companyId, ids);
    const once = countingDb(db);
    await assertTaskWorkspacesAccess(once.db, f.actor, f.companyId, ids);
    const twice = countingDb(db);
    await assertTaskWorkspacesAccess(twice.db, f.actor, f.companyId, [...ids, ...ids]);
    expect(twice.statements()).toBe(once.statements());
  });

  it("reads the actor's own rows a fixed number of times however many workspaces it checks", async () => {
    const f = await fixture();
    const ids = await addPeers(f, 10);
    await assertTaskWorkspacesAccess(db, f.actor, f.companyId, ids);
    const few = tableReadsDb(db);
    await assertTaskWorkspacesAccess(few.db, f.actor, f.companyId, ids.slice(0, 2));
    const many = tableReadsDb(db);
    await assertTaskWorkspacesAccess(many.db, f.actor, f.companyId, ids);
    for (const table of ["agents", "heartbeat_runs", "company_memberships"]) {
      expect(few.reads(table), `premise: deciding reads ${table}`).toBeGreaterThan(0);
      expect(many.reads(table), table).toBe(few.reads(table));
    }
  });

  it("authorizes a root reader against the workspaces sharing its root with a fixed number of reads of its own rows", async () => {
    const f = await fixture();
    await addPeers(f, 2);
    await f.service.guardForPublication(f.admission);
    const few = deepTableReadsDb(db);
    await executionWorkspaceRepositoryService(few.db).guardForPublication(f.admission);
    await addPeers(f, 10);
    const many = deepTableReadsDb(db);
    await executionWorkspaceRepositoryService(many.db).guardForPublication(f.admission);
    for (const table of ["agents", "heartbeat_runs"]) {
      expect(few.reads(table), `premise: authorizing the reader reads ${table}`).toBeGreaterThan(0);
      expect(many.reads(table), table).toBe(few.reads(table));
    }
  });

  it.each([
    ["every workspace readable", "allowed"],
    ["one workspace id unknown", "denied: Task workspace access is no longer available"],
    ["one workspace retains a task that no longer exists", "denied: Task workspace access is no longer available"],
    ["one workspace holds another sponsor's private task", "denied: Task workspace access is no longer available"],
    ["one unscoped workspace without tasks", "allowed"],
  ] as const)("matches the per-workspace check when %s", async (scenario, expected) => {
    const f = await fixture();
    const ids = await addPeers(f, 4);
    let actor: AuthorizationActor = f.actor;
    if (scenario === "one workspace id unknown") ids.splice(2, 0, randomUUID());
    if (scenario === "one workspace retains a task that no longer exists") {
      const [gone] = await db.insert(issues).values({ companyId: f.companyId, title: "Retained then removed", assigneeAgentId: f.agentId,
        executionWorkspaceId: ids[1]! }).returning();
      await db.update(executionWorkspaces).set({ metadata: {} }).where(eq(executionWorkspaces.id, ids[1]!));
      await db.delete(issues).where(eq(issues.id, gone.id));
    }
    if (scenario === "one workspace holds another sponsor's private task") {
      const peer = await standardPeer(f);
      await privateTask(f);
      ids.splice(1, 0, f.workspace.id);
      actor = peer.actor;
    }
    if (scenario === "one unscoped workspace without tasks") {
      const [bare] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Bare", cwd: f.admission.cwd,
        mode: "shared_workspace", strategyType: "operator_directory" }).returning();
      ids.push(bare.id);
    }
    const reference = await outcome((async () => { for (const id of ids) await referenceTaskWorkspaceAccess(db, actor, f.companyId, id); })());
    expect(reference, "premise: the scenario produces the expected per-workspace outcome").toBe(expected);
    expect(await outcome(assertTaskWorkspacesAccess(db, actor, f.companyId, ids))).toBe(reference);
    expect(await outcome((async () => { for (const id of ids) await assertTaskWorkspaceAccess(db, actor, f.companyId, id); })())).toBe(reference);
  });
  // A run bound to one task is low trust: the workspace read condition lets its root's
  // workspaces through, so the project, task and company-scope checks decide instead.
  it.each([
    ["every workspace is the run's own", "allowed"],
    ["one workspace holds a task outside the run", "denied: Task workspace retains files outside this actor's authorization boundary"],
    ["one unscoped workspace without tasks", "denied: An unscoped workspace is outside this actor's authorization boundary"],
    ["one workspace belongs to a project outside the run", "denied: Project is outside this low-trust boundary."],
  ] as const)("matches the per-workspace check for a low-trust run when %s", async (scenario, expected) => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    const ids = [f.workspace.id];
    const extra = { companyId: f.companyId, cwd: f.admission.cwd, mode: "shared_workspace", strategyType: "operator_directory" } as const;
    if (scenario === "one workspace holds a task outside the run") {
      const [workspace] = await db.insert(executionWorkspaces).values({ ...extra, name: "Peer" }).returning();
      await db.insert(issues).values({ companyId: f.companyId, title: "Outside", assigneeAgentId: f.agentId, executionWorkspaceId: workspace.id });
      ids.push(workspace.id);
    }
    if (scenario === "one unscoped workspace without tasks") {
      const [workspace] = await db.insert(executionWorkspaces).values({ ...extra, name: "Bare" }).returning();
      ids.push(workspace.id);
    }
    if (scenario === "one workspace belongs to a project outside the run") {
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Outside project" }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ ...extra, name: "Project", projectId: project.id }).returning();
      ids.push(workspace.id);
    }
    const reference = await outcome((async () => { for (const id of ids) await referenceTaskWorkspaceAccess(db, f.actor, f.companyId, id); })());
    expect(reference, "premise: the scenario produces the expected per-workspace outcome").toBe(expected);
    expect(await outcome(assertTaskWorkspacesAccess(db, f.actor, f.companyId, ids))).toBe(reference);
  });
});
