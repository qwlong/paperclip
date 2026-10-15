import { executionWorkspaces, issues, type Db } from "@paperclipai/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { accessService } from "./access.js";
import { authorizationService, executionWorkspaceReadSqlCondition, type AuthorizationActor } from "./authorization.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type WorkspaceAccessContext = { write?: boolean; issueId?: string | null; parentIssueId?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null };

export async function assertTaskWorkspaceSourceProjectAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, projectId: string | null, options: WorkspaceAccessContext = {},
) {
  if (!projectId) return;
  const decision = await accessService(db as Db).decide({
    actor, action: "project:read", resource: { type: "project", companyId, projectId },
  });
  if (!decision.allowed) throw forbidden(decision.explanation);
  if (options.write) {
    const [task] = actor.type === "board" && options.issueId
      ? await db.select({ assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId }).from(issues)
        .where(and(eq(issues.id, options.issueId), eq(issues.companyId, companyId)))
      : [];
    const assigneeAgentId = actor.type === "agent" ? actor.agentId ?? null : task?.assigneeAgentId ?? options.assigneeAgentId ?? null;
    const assigneeUserId = actor.type === "agent" ? null : task?.assigneeUserId ?? options.assigneeUserId ?? null;
    const assignment = await accessService(db as Db).decide({
      actor, action: "project:write_workspace",
      resource: { type: "issue", companyId, projectId, assigneeAgentId, assigneeUserId,
        issueId: options.issueId, parentIssueId: options.parentIssueId },
      scope: { projectId, assigneeAgentId, assigneeUserId },
    });
    if (!assignment.allowed) throw forbidden(assignment.explanation);
  }
}

export async function assertTaskWorkspaceAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, workspaceId: string, options: WorkspaceAccessContext = {},
) {
  await assertTaskWorkspacesAccess(db, actor, companyId, [workspaceId], options);
}

/**
 * Same outcome, and the same first denial, as checking each workspace in order
 * with `assertTaskWorkspaceAccess`. Workspaces and their tasks load in one
 * statement each, every distinct project, company, and task decision is made
 * once, and the actor's own rows are read once for the whole check, so a root
 * shared by many workspaces costs only the task-specific reads per task.
 */
export async function assertTaskWorkspacesAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, workspaceIds: Iterable<string>, options: WorkspaceAccessContext = {},
) {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return;
  const rows = await db.select().from(executionWorkspaces).where(and(
    inArray(executionWorkspaces.id, ids), eq(executionWorkspaces.companyId, companyId),
    await executionWorkspaceReadSqlCondition(db, actor),
  ));
  const workspaces = new Map(rows.map(row => [row.id, row]));
  const retainedIssueIds = new Map(rows.map(row => {
    const retained = Object.keys(row.metadata?._issuePrivacySources ?? {});
    if (row.sourceIssueId) retained.push(row.sourceIssueId);
    return [row.id, retained];
  }));
  const allRetained = [...new Set([...retainedIssueIds.values()].flat())];
  const linkedIssues = rows.length === 0 ? [] : await db.select({ id: issues.id, executionWorkspaceId: issues.executionWorkspaceId }).from(issues).where(and(
    eq(issues.companyId, companyId),
    or(inArray(issues.executionWorkspaceId, rows.map(row => row.id)), allRetained.length > 0
      ? inArray(sql<string>`${issues.id}::text`, allRetained) : undefined),
  ));
  const authorization = authorizationService(db, { rowMemo: new Map() });
  const decisions = new Map<string, ReturnType<typeof authorization.decide>>();
  const decide = (input: Omit<Parameters<typeof authorization.decide>[0], "actor">) => {
    const key = JSON.stringify(input);
    if (!decisions.has(key)) decisions.set(key, authorization.decide({ actor, ...input }));
    return decisions.get(key)!;
  };
  const projectChecks = new Map<string, Promise<void>>();
  const checkProject = (projectId: string | null, write: boolean | undefined) => {
    const key = JSON.stringify([projectId, write]);
    if (!projectChecks.has(key)) projectChecks.set(key, assertTaskWorkspaceSourceProjectAccess(db, actor, companyId, projectId, { ...options, write }));
    return projectChecks.get(key)!;
  };
  for (const workspaceId of ids) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw forbidden("Task workspace access is no longer available");
    await checkProject(workspace.projectId, options.write && workspace.strategyType !== "git_worktree");
    const retained = retainedIssueIds.get(workspaceId)!;
    const retainedSet = new Set(retained);
    const sources = linkedIssues.filter(issue => issue.executionWorkspaceId === workspaceId || retainedSet.has(issue.id));
    const sourceIds = new Set(sources.map(source => source.id));
    if (retained.some(id => !sourceIds.has(id))) throw forbidden("Task workspace source is no longer accessible");
    if (sources.length === 0 && !workspace.projectId) {
      const decision = await decide({ action: "company_scope:read", resource: { type: "company", companyId } });
      if (!decision.allowed) throw forbidden("An unscoped workspace is outside this actor's authorization boundary");
    }
    for (const source of sources) {
      const decision = await decide({ action: "issue:read", resource: { type: "issue", companyId, issueId: source.id } });
      if (!decision.allowed) throw forbidden("Task workspace retains files outside this actor's authorization boundary");
    }
  }
}
