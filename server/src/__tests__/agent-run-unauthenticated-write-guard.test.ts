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

  it("lets the write through when resolving the peer takes too long", async () => {
    const report = vi.fn();
    const handled = vi.fn();
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit" };
      next();
    });
    app.use(agentRunUnauthenticatedWriteGuard({
      mode: "reject",
      findRunForSocket: () => new Promise(() => {}),
      report,
      timeoutMs: 50,
    }));
    app.post("/api/issues/x", (_req, res) => {
      handled();
      res.status(204).end();
    });

    await request(app).post("/api/issues/x").expect(204);

    expect(handled).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
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
  const STARTED_AT = Date.parse("2026-10-01T05:00:00.000Z");
  const CLIENT_PORT = 5001;
  const SERVER_PORT = 3100;
  const socket = (remotePort = CLIENT_PORT, remoteAddress = "127.0.0.1") =>
    ({ remotePort, remoteAddress, localAddress: remoteAddress, localPort: SERVER_PORT }) as Socket;
  const connection = (remotePort = CLIENT_PORT) => `127.0.0.1:${remotePort}->127.0.0.1:${SERVER_PORT}`;
  const proc = (ppid: number, pgid: number, startedAtMs: number | null = STARTED_AT - 60_000) => ({ ppid, pgid, startedAtMs });
  // 20 is the run process (its own group leader); 30 is a shell it spawned, 40 the script
  // that shell ran; 60 was reparented to init but stayed in the run's group; 50 is unrelated.
  const processTable = new Map([
    [40, proc(30, 20)],
    [30, proc(20, 20)],
    [20, proc(10, 20, STARTED_AT)],
    [60, proc(1, 20)],
    [10, proc(1, 10)],
    [50, proc(10, 50)],
    [1, proc(0, 1)],
  ]);
  const RUN_PROCESS = { ...RUN, processPid: 20, processGroupId: 20, processStartedAt: new Date(STARTED_AT) };
  const MATCH = { ...RUN, processPid: 20 };

  function resolverWith(overrides: Partial<Parameters<typeof createPeerRunResolver>[0]> = {}) {
    let clock = 1_000_000;
    const deps = {
      listRunningRunProcesses: vi.fn(async () => [RUN_PROCESS]),
      readConnectionPids: vi.fn(async (_port: number) => new Map([[connection(), 40]])),
      readProcessTable: vi.fn(async () => processTable),
      now: () => clock,
      ...overrides,
    };
    return { resolve: createPeerRunResolver(deps), deps, advance: (ms: number) => { clock += ms; } };
  }

  it("matches a peer whose ancestor is a running run's process", async () => {
    const { resolve, deps } = resolverWith();
    await expect(resolve(socket())).resolves.toEqual(MATCH);
    expect(deps.readConnectionPids).toHaveBeenCalledWith(SERVER_PORT);
  });

  it("matches the run process itself", async () => {
    const { resolve } = resolverWith({ readConnectionPids: vi.fn(async () => new Map([[connection(), 20]])) });
    await expect(resolve(socket())).resolves.toEqual(MATCH);
  });

  it("matches a process that left the run's ancestry but stayed in its process group", async () => {
    const { resolve } = resolverWith({ readConnectionPids: vi.fn(async () => new Map([[connection(), 60]])) });
    await expect(resolve(socket())).resolves.toEqual(MATCH);
  });

  it("does not match a sibling of the run process", async () => {
    const { resolve } = resolverWith({ readConnectionPids: vi.fn(async () => new Map([[connection(), 50]])) });
    await expect(resolve(socket())).resolves.toBeNull();
  });

  it.each([
    { label: "a pid now held by a process that started later", processStartedAt: new Date(STARTED_AT - 10_000) },
    { label: "a run without a recorded start time", processStartedAt: null },
  ])("does not trust $label", async ({ processStartedAt }) => {
    const { resolve } = resolverWith({
      listRunningRunProcesses: vi.fn(async () => [{ ...RUN_PROCESS, processStartedAt }]),
    });
    await expect(resolve(socket())).resolves.toBeNull();
  });

  it("does not trust a run whose pid is not a local process group leader", async () => {
    // Remote and sandbox runs record the remote pid with no process group.
    const { resolve, deps } = resolverWith({
      listRunningRunProcesses: vi.fn(async () => [{ ...RUN_PROCESS, processGroupId: null }]),
    });
    await expect(resolve(socket())).resolves.toBeNull();
    expect(deps.readConnectionPids).not.toHaveBeenCalled();
  });

  it("returns null when no run is executing, without reading processes", async () => {
    const { resolve, deps } = resolverWith({ listRunningRunProcesses: vi.fn(async () => []) });
    await expect(resolve(socket())).resolves.toBeNull();
    expect(deps.readConnectionPids).not.toHaveBeenCalled();
    expect(deps.readProcessTable).not.toHaveBeenCalled();
  });

  it("matches the exact connection, not another one on the same port number", async () => {
    const { resolve } = resolverWith({
      readConnectionPids: vi.fn(async () => new Map([
        [`127.0.0.1:${CLIENT_PORT}->127.0.0.1:9999`, 40],
        [`127.0.0.1:${SERVER_PORT}->127.0.0.1:${CLIENT_PORT}`, 40],
      ])),
    });
    await expect(resolve(socket())).resolves.toBeNull();
  });

  it("matches IPv6 loopback connections", async () => {
    const { resolve } = resolverWith({
      readConnectionPids: vi.fn(async () => new Map([[`[::1]:${CLIENT_PORT}->[::1]:${SERVER_PORT}`, 40]])),
    });
    await expect(resolve(socket(CLIENT_PORT, "::1"))).resolves.toEqual(MATCH);
  });

  it("terminates on a cyclic process table", async () => {
    const { resolve } = resolverWith({
      readProcessTable: vi.fn(async () => new Map([[40, proc(30, 40)], [30, proc(40, 30)], [20, proc(1, 20, STARTED_AT)]])),
    });
    await expect(resolve(socket())).resolves.toBeNull();
  });

  it("shares one snapshot between requests close together", async () => {
    const { resolve, deps } = resolverWith();
    await Promise.all([resolve(socket()), resolve(socket()), resolve(socket())]);
    await resolve(socket());
    expect(deps.listRunningRunProcesses).toHaveBeenCalledTimes(1);
    expect(deps.readConnectionPids).toHaveBeenCalledTimes(1);
    expect(deps.readProcessTable).toHaveBeenCalledTimes(1);
  });

  it("refreshes the snapshot once it is older than a second", async () => {
    const { resolve, deps, advance } = resolverWith();
    await resolve(socket());
    advance(1_001);
    await resolve(socket());
    expect(deps.listRunningRunProcesses).toHaveBeenCalledTimes(2);
    expect(deps.readConnectionPids).toHaveBeenCalledTimes(2);
  });

  it("rereads connections for a connection the current snapshot has not seen", async () => {
    const readConnectionPids = vi.fn()
      .mockResolvedValueOnce(new Map([[connection(), 40]]))
      .mockResolvedValueOnce(new Map([[connection(), 40], [connection(5002), 40]]));
    const { resolve, advance } = resolverWith({ readConnectionPids });
    await resolve(socket());
    advance(10);
    await expect(resolve(socket(5002))).resolves.toEqual(MATCH);
    expect(readConnectionPids).toHaveBeenCalledTimes(2);
  });

  it("rereads processes for a peer the current process table has not seen", async () => {
    const newer = new Map([...processTable, [70, proc(20, 20)]]);
    const readProcessTable = vi.fn().mockResolvedValueOnce(processTable).mockResolvedValueOnce(newer);
    const readConnectionPids = vi.fn(async () => new Map([[connection(), 40], [connection(5002), 70]]));
    const { resolve, advance } = resolverWith({ readProcessTable, readConnectionPids });
    await resolve(socket());
    advance(10);
    await expect(resolve(socket(5002))).resolves.toEqual(MATCH);
    expect(readProcessTable).toHaveBeenCalledTimes(2);
  });

  it("returns null for a connection that is still unknown after rereading", async () => {
    const { resolve } = resolverWith();
    await expect(resolve(socket(6000))).resolves.toBeNull();
  });

  it("retries a failed read on the next request instead of caching the failure", async () => {
    const readConnectionPids = vi.fn()
      .mockRejectedValueOnce(new Error("lsof failed"))
      .mockResolvedValueOnce(new Map([[connection(), 40]]));
    const { resolve } = resolverWith({ readConnectionPids });
    await expect(resolve(socket())).rejects.toThrow("lsof failed");
    await expect(resolve(socket())).resolves.toEqual(MATCH);
  });

  it("rechecks running runs for a kept-alive connection", async () => {
    const listRunningRunProcesses = vi.fn()
      .mockResolvedValueOnce([RUN_PROCESS])
      .mockResolvedValueOnce([]);
    const { resolve, advance } = resolverWith({ listRunningRunProcesses });
    const keptAlive = socket();
    await expect(resolve(keptAlive)).resolves.not.toBeNull();
    advance(1_001);
    await expect(resolve(keptAlive)).resolves.toBeNull();
  });
});

const hasLsof = spawnSync("lsof", ["-v"]).error === undefined;
const describeWithLsof = hasLsof && process.platform !== "win32" ? describe : describe.skip;

describeWithLsof("createPeerRunResolver against real processes", () => {
  it("attributes a request from a grandchild of the run process, and not one from elsewhere", async () => {
    let runPid: number | null = null;
    let runStartedAt: Date | null = null;
    const resolve = createPeerRunResolver({
      listRunningRunProcesses: async () =>
        runPid ? [{ ...RUN, processPid: runPid, processGroupId: runPid, processStartedAt: runStartedAt }] : [],
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
      // Like the adapters, the run process leads its own process group.
      const runProcess = spawn("/bin/sh", ["-c", `sleep 1; /bin/sh -c ${JSON.stringify(inner)}; true`], {
        stdio: ["ignore", "pipe", "inherit"],
        detached: true,
      });
      runPid = runProcess.pid!;
      runStartedAt = new Date(spawnSync("ps", ["-o", "lstart=", "-p", String(runPid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout.trim());
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
      { id: running, companyId, agentId, status: "running", invocationSource: "assignment", processPid: 111, processGroupId: 111, processStartedAt: new Date("2026-10-01T05:00:00.000Z") },
      { id: randomUUID(), companyId, agentId, status: "running", invocationSource: "assignment", processPid: null },
      { id: randomUUID(), companyId, agentId, status: "succeeded", invocationSource: "assignment", processPid: 222 },
      { id: randomUUID(), companyId, agentId, status: "queued", invocationSource: "assignment", processPid: 333 },
    ]);

    await expect(listRunningRunProcesses(db)).resolves.toEqual([
      { runId: running, agentId, companyId, processPid: 111, processGroupId: 111, processStartedAt: new Date("2026-10-01T05:00:00.000Z") },
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
