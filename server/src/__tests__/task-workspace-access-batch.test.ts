import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, executionWorkspaces, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { assertExecutionWorkspaceRootReadAccess } from "../services/execution-workspace-repositories.js";
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

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("repository root reads across many workspaces", () => {
  const context = createRepositoryTrustFixture(acquisition);
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { ({ db } = await context.setup()); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.clearAllMocks(); });
  afterAll(context.cleanup);
  const { fixture } = context;

  async function addPeers(f: Awaited<ReturnType<typeof fixture>>, count: number) {
    for (let index = 0; index < count; index += 1) {
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: `Peer ${index}`, cwd: f.admission.cwd,
        mode: "shared_workspace", strategyType: "operator_directory" }).returning();
      await db.insert(issues).values({ companyId: f.companyId, title: `Peer task ${index}`, assigneeAgentId: f.agentId, executionWorkspaceId: workspace.id });
    }
  }

  async function rootRead(f: Awaited<ReturnType<typeof fixture>>) {
    const counted = countingDb(db);
    const realpath = vi.spyOn(fs, "realpath");
    try {
      await assertExecutionWorkspaceRootReadAccess(counted.db, { companyId: f.companyId, cwd: f.admission.cwd, actor: f.actor });
      return { statements: counted.statements(), realpaths: realpath.mock.calls.length };
    } finally { realpath.mockRestore(); }
  }

  it("resolves each distinct workspace directory once however many workspaces share it", async () => {
    const f = await fixture();
    await addPeers(f, 2);
    const few = await rootRead(f);
    await addPeers(f, 10);
    const many = await rootRead(f);
    expect(few.realpaths, "premise: resolving the root reads real paths").toBeGreaterThan(0);
    expect(many.realpaths).toBe(few.realpaths);
  });

  it("issues a fixed number of statements however many tasks share the root", async () => {
    const f = await fixture();
    await addPeers(f, 2);
    const few = await rootRead(f);
    await addPeers(f, 10);
    const many = await rootRead(f);
    expect(few.statements, "premise: a root read issues statements").toBeGreaterThan(0);
    expect(many.statements).toBe(few.statements);
  });
});
