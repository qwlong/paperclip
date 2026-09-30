import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  agentRunUnauthenticatedWriteGuard,
  agentRunUnauthenticatedWriteGuardFor,
  createPeerRunResolver,
  listRunningRunProcesses,
  parseAgentRunUnauthenticatedWriteMode,
  type AgentRunMatch,
  type UnauthenticatedAgentRunWrite,
} from "../middleware/agent-run-unauthenticated-write-guard.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const RUN: AgentRunMatch = { runId: "run-1", agentId: "agent-1", companyId: "company-1", processPid: 4242 };

function appWith(options: {
  mode: "log" | "reject";
  actorSource?: "local_implicit" | "session" | "board_key";
  actorType?: "board" | "agent";
  findRunForSocket: (socket: Socket) => Promise<AgentRunMatch | null>;
  report?: (write: UnauthenticatedAgentRunWrite) => void;
}) {
  const handled = vi.fn();
  const app = express();
  app.use((req, _res, next) => {
    req.actor = options.actorType === "agent"
      ? { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_jwt" }
      : { type: "board", userId: "local-board", source: options.actorSource ?? "local_implicit" };
    next();
  });
  app.use(agentRunUnauthenticatedWriteGuard({
    mode: options.mode,
    findRunForSocket: options.findRunForSocket,
    report: options.report ?? (() => {}),
  }));
  app.all("/api/issues/x", (_req, res) => {
    handled();
    res.status(204).end();
  });
  return { app, handled };
}

describe("agentRunUnauthenticatedWriteGuard", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"] as const)(
    "rejects a %s that an agent run sent without credentials",
    async (method) => {
      const report = vi.fn();
      const { app, handled } = appWith({ mode: "reject", findRunForSocket: async () => RUN, report });

      const res = await request(app)[method.toLowerCase() as "post"]("/api/issues/x");

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
      expect(handled).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(expect.objectContaining({
        ...RUN, method, path: "/api/issues/x", action: "rejected",
      }));
    },
  );

  it("lets the write through in log mode and reports it", async () => {
    const report = vi.fn();
    const { app, handled } = appWith({ mode: "log", findRunForSocket: async () => RUN, report });

    await request(app).post("/api/issues/x").expect(204);

    expect(handled).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ ...RUN, method: "POST", action: "logged" }));
  });

  it("does not attribute writes from outside any run", async () => {
    const report = vi.fn();
    const { app, handled } = appWith({ mode: "reject", findRunForSocket: async () => null, report });

    await request(app).post("/api/issues/x").expect(204);

    expect(handled).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("does not inspect reads", async () => {
    const findRunForSocket = vi.fn(async () => RUN);
    const { app } = appWith({ mode: "reject", findRunForSocket });

    await request(app).get("/api/issues/x").expect(204);

    expect(findRunForSocket).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an agent credential", actorType: "agent" as const, actorSource: undefined },
    { label: "a board session", actorType: "board" as const, actorSource: "session" as const },
    { label: "a board key", actorType: "board" as const, actorSource: "board_key" as const },
  ])("does not inspect writes that carry $label", async ({ actorType, actorSource }) => {
    const findRunForSocket = vi.fn(async () => RUN);
    const { app } = appWith({ mode: "reject", actorType, actorSource, findRunForSocket });

    await request(app).post("/api/issues/x").expect(204);

    expect(findRunForSocket).not.toHaveBeenCalled();
  });

  it("lets the write through when the peer cannot be resolved", async () => {
    const { app, handled } = appWith({
      mode: "reject",
      findRunForSocket: async () => {
        throw new Error("lsof unavailable");
      },
    });

    await request(app).post("/api/issues/x").expect(204);

    expect(handled).toHaveBeenCalledTimes(1);
  });
});

describe("createPeerRunResolver", () => {
  const socket = (remotePort: number) => ({ remotePort, remoteAddress: "127.0.0.1" }) as Socket;
  // pid -> ppid; 30 is a shell spawned by the run process 20, 40 is the script it ran.
  const processTable = new Map([[40, 30], [30, 20], [20, 10], [10, 1], [50, 10], [1, 0]]);

  function resolverWith(overrides: Partial<Parameters<typeof createPeerRunResolver>[0]> = {}) {
    const deps = {
      lookupPeerPid: vi.fn(async () => 40 as number | null),
      readParentPids: vi.fn(async () => processTable),
      listRunningRunProcesses: vi.fn(async () => [{ ...RUN, processPid: 20 }]),
      ...overrides,
    };
    return { resolve: createPeerRunResolver(deps), deps };
  }

  it("matches a peer whose ancestor is a running run's process", async () => {
    const { resolve } = resolverWith();
    await expect(resolve(socket(5001))).resolves.toEqual({ ...RUN, processPid: 20 });
  });

  it("matches the run process itself", async () => {
    const { resolve } = resolverWith({ lookupPeerPid: vi.fn(async () => 20) });
    await expect(resolve(socket(5001))).resolves.toEqual({ ...RUN, processPid: 20 });
  });

  it("does not match a sibling of the run process", async () => {
    const { resolve } = resolverWith({ lookupPeerPid: vi.fn(async () => 50) });
    await expect(resolve(socket(5001))).resolves.toBeNull();
  });

  it("returns null when no run is executing, without reading processes", async () => {
    const { resolve, deps } = resolverWith({ listRunningRunProcesses: vi.fn(async () => []) });
    await expect(resolve(socket(5001))).resolves.toBeNull();
    expect(deps.lookupPeerPid).not.toHaveBeenCalled();
  });

  it("returns null when the peer process is unknown", async () => {
    const { resolve } = resolverWith({ lookupPeerPid: vi.fn(async () => null) });
    await expect(resolve(socket(5001))).resolves.toBeNull();
  });

  it("terminates on a cyclic process table", async () => {
    const { resolve } = resolverWith({
      readParentPids: vi.fn(async () => new Map([[40, 30], [30, 40]])),
    });
    await expect(resolve(socket(5001))).resolves.toBeNull();
  });

  it("resolves each connection's peer once", async () => {
    const { resolve, deps } = resolverWith();
    const keptAlive = socket(5001);
    await resolve(keptAlive);
    await resolve(keptAlive);
    await resolve(socket(5002));
    expect(deps.lookupPeerPid).toHaveBeenCalledTimes(2);
  });

  it("rechecks running runs for a kept-alive connection", async () => {
    const listRunningRunProcesses = vi.fn()
      .mockResolvedValueOnce([{ ...RUN, processPid: 20 }])
      .mockResolvedValueOnce([]);
    const { resolve } = resolverWith({ listRunningRunProcesses });
    const keptAlive = socket(5001);
    await expect(resolve(keptAlive)).resolves.not.toBeNull();
    await expect(resolve(keptAlive)).resolves.toBeNull();
  });
});

const hasLsof = spawnSync("lsof", ["-v"]).error === undefined;
const describeWithLsof = hasLsof && process.platform !== "win32" ? describe : describe.skip;

describeWithLsof("createPeerRunResolver against real processes", () => {
  it("attributes a request from a grandchild of the run process, and not one from elsewhere", async () => {
    let runPid: number | null = null;
    const resolve = createPeerRunResolver({
      listRunningRunProcesses: async () => (runPid ? [{ ...RUN, processPid: runPid }] : []),
    });
    const app = express();
    app.post("/probe", async (req, res) => {
      res.json({ run: await resolve(req.socket) });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((ready) => server.once("listening", ready));
    const port = (server.address() as AddressInfo).port;

    try {
      const client = `fetch("http://127.0.0.1:${port}/probe",{method:"POST"}).then(r=>r.text()).then(t=>process.stdout.write(t))`;
      // The run process starts a shell that starts the client, like an agent CLI
      // running a script through its shell tool. Trailing `; true` keeps each
      // shell from exec-ing into its child, so the ancestry really has two hops.
      const inner = `"${process.execPath}" -e '${client}'; true`;
      const runProcess = spawn("/bin/sh", ["-c", `/bin/sh -c ${JSON.stringify(inner)}; true`], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      runPid = runProcess.pid!;
      const fromRun = await new Promise<string>((done, fail) => {
        let out = "";
        runProcess.stdout.on("data", (chunk) => { out += chunk; });
        runProcess.on("exit", () => done(out));
        runProcess.on("error", fail);
      });
      expect(JSON.parse(fromRun)).toEqual({ run: { ...RUN, processPid: runPid } });

      const fromHere = await fetch(`http://127.0.0.1:${port}/probe`, { method: "POST" });
      expect(await fromHere.json()).toEqual({ run: null });
    } finally {
      server.close();
    }
  }, 20_000);
});

describe("parseAgentRunUnauthenticatedWriteMode", () => {
  it.each([
    [undefined, "log"],
    ["", "log"],
    ["off", "off"],
    ["log", "log"],
    [" REJECT ", "reject"],
    ["block", "log"],
  ])("maps %j to %s", (value, mode) => {
    expect(parseAgentRunUnauthenticatedWriteMode(value)).toBe(mode);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("listRunningRunProcesses", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-unauth-writes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns running runs that have a process, and nothing else", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Runs", issuePrefix: `RU${companyId.slice(0, 4).toUpperCase()}` });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Runner", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const running = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: running, companyId, agentId, status: "running", invocationSource: "assignment", processPid: 111 },
      { id: randomUUID(), companyId, agentId, status: "running", invocationSource: "assignment", processPid: null },
      { id: randomUUID(), companyId, agentId, status: "succeeded", invocationSource: "assignment", processPid: 222 },
      { id: randomUUID(), companyId, agentId, status: "queued", invocationSource: "assignment", processPid: 333 },
    ]);

    await expect(listRunningRunProcesses(db)).resolves.toEqual([
      { runId: running, agentId, companyId, processPid: 111 },
    ]);
  });
});

describe("agentRunUnauthenticatedWriteGuardFor", () => {
  function appFor(deploymentMode: "local_trusted" | "authenticated", mode: string | undefined) {
    const report = vi.fn();
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit" };
      next();
    });
    app.use(agentRunUnauthenticatedWriteGuardFor({
      deploymentMode,
      mode,
      findRunForSocket: async () => RUN,
      report,
    }));
    app.post("/api/x", (_req, res) => res.status(204).end());
    return { app, report };
  }

  it("guards local-trusted instances in the configured mode", async () => {
    const { app, report } = appFor("local_trusted", "reject");
    await request(app).post("/api/x").expect(401);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("logs by default", async () => {
    const { app, report } = appFor("local_trusted", undefined);
    await request(app).post("/api/x").expect(204);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ action: "logged" }));
  });

  it.each([
    ["authenticated", "reject"],
    ["local_trusted", "off"],
  ] as const)("does nothing on %s instances with mode %s", async (deploymentMode, mode) => {
    const { app, report } = appFor(deploymentMode, mode);
    await request(app).post("/api/x").expect(204);
    expect(report).not.toHaveBeenCalled();
  });
});
