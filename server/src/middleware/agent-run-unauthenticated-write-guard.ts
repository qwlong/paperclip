import { execFile } from "node:child_process";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import type { RequestHandler } from "express";
import { and, eq, isNotNull } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

const execFileAsync = promisify(execFile);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_ANCESTRY_DEPTH = 64;
const DEFAULT_RESOLVE_TIMEOUT_MS = 1_000;
const COMMAND_TIMEOUT_MS = 2_000;
const SNAPSHOT_TTL_MS = 1_000;
// `ps` reports start times to the second; the run records them the same way or from its spawn clock.
const START_TIME_TOLERANCE_MS = 2_000;

export interface AgentRunMatch {
  runId: string;
  agentId: string;
  companyId: string;
  processPid: number;
}

export interface RunningRunProcess extends AgentRunMatch {
  processGroupId: number | null;
  processStartedAt: Date | null;
}

export interface ProcessInfo {
  ppid: number;
  pgid: number;
  startedAtMs: number | null;
}

export interface UnauthenticatedAgentRunWrite extends AgentRunMatch {
  method: string;
  path: string;
  action: "logged" | "rejected";
}

export type AgentRunUnauthenticatedWriteMode = "off" | "log" | "reject";

export const AGENT_RUN_UNAUTHENTICATED_WRITE_ERROR =
  "This request came from an agent run but carries no credentials, so it would act as the board user. "
  + "Send the run's own key: Authorization: Bearer $PAPERCLIP_API_KEY (and X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID).";

/**
 * Local-trusted mode treats every credential-less request as the board user.
 * A process started by an agent run that forgets its API key would therefore
 * act as the human. This guard finds such writes by the requesting process's
 * ancestry and logs or rejects them; everything else passes untouched,
 * including requests whose origin cannot be resolved within `timeoutMs`.
 */
export function agentRunUnauthenticatedWriteGuard(opts: {
  mode: "log" | "reject";
  findRunForSocket: (socket: Socket) => Promise<AgentRunMatch | null>;
  report: (write: UnauthenticatedAgentRunWrite) => void;
  timeoutMs?: number;
}): RequestHandler {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  return async (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return next();
    if (req.actor?.type !== "board" || req.actor.source !== "local_implicit") return next();

    let timer: NodeJS.Timeout | undefined;
    let run: AgentRunMatch | null;
    try {
      run = await Promise.race([
        opts.findRunForSocket(req.socket),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
    } catch {
      run = null;
    } finally {
      clearTimeout(timer);
    }
    if (!run) return next();

    const action = opts.mode === "reject" ? "rejected" : "logged";
    opts.report({ ...run, method: req.method.toUpperCase(), path: req.originalUrl.split("?")[0]!, action });
    if (action === "rejected") {
      res.status(401).json({ error: AGENT_RUN_UNAUTHENTICATED_WRITE_ERROR });
      return;
    }
    next();
  };
}

function formatAddress(address: string | undefined): string {
  const plain = (address ?? "").replace(/^::ffff:/, "");
  return plain.includes(":") ? `[${plain}]` : plain;
}

/** A connection as the client's own socket names it in `lsof`: `client->server`. */
function clientConnectionKey(socket: Socket): string {
  return `${formatAddress(socket.remoteAddress)}:${socket.remotePort}->${formatAddress(socket.localAddress)}:${socket.localPort}`;
}

function runCommand(file: string, args: string[]): Promise<string> {
  return execFileAsync(file, args, {
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  }).then(({ stdout }) => stdout, (error: { stdout?: string; code?: number }) => {
    // lsof exits 1 when nothing matches.
    if (file === "lsof" && error.code === 1) return error.stdout ?? "";
    throw error;
  });
}

/** Every established TCP connection touching `serverPort`, keyed `local->remote`, with its owning pid. */
export async function readConnectionPids(serverPort: number): Promise<Map<string, number>> {
  const stdout = await runCommand("lsof", ["-nP", "-b", "-w", "-a", `-iTCP:${serverPort}`, "-sTCP:ESTABLISHED", "-Fpn"]);
  const pids = new Map<string, number>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) pids.set(line.slice(1), pid);
  }
  return pids;
}

export async function readProcessTable(): Promise<Map<number, ProcessInfo>> {
  const stdout = await runCommand("ps", ["-axo", "pid=,ppid=,pgid=,lstart="]);
  const table = new Map<number, ProcessInfo>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const startedAtMs = Date.parse(match[4]!);
    table.set(Number(match[1]), {
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAtMs: Number.isNaN(startedAtMs) ? null : startedAtMs,
    });
  }
  return table;
}

/**
 * Loads a value at most once per `ttlMs`, sharing one load between concurrent
 * callers. A caller passing `freshAfter` gets a load that started no earlier.
 * Failed loads are not kept.
 */
type Snapshot<T> = (freshAfter: number) => Promise<T>;

function snapshot<T>(load: () => Promise<T>, now: () => number): Snapshot<T> {
  let current: { startedAt: number; value: Promise<T> } | null = null;
  return (freshAfter) => {
    const time = now();
    if (!current || current.startedAt < freshAfter || time - current.startedAt > SNAPSHOT_TTL_MS) {
      const entry = { startedAt: time, value: load() };
      current = entry;
      entry.value.catch(() => {
        if (current === entry) current = null;
      });
    }
    return current.value;
  };
}

/**
 * Resolves which running agent run, if any, owns the process behind a
 * connection. A process belongs to a run when the run's process is among its
 * ancestors or leads its process group. Only runs whose process is a local
 * process group leader that started when the run recorded are trusted, so a
 * remote run's pid or a reused pid never matches.
 *
 * Runs, connections and processes are each read at most once a second, and
 * again for a connection first seen after the last read.
 */
export function createPeerRunResolver(deps: {
  listRunningRunProcesses: () => Promise<RunningRunProcess[]>;
  readConnectionPids?: (serverPort: number) => Promise<Map<string, number>>;
  readProcessTable?: () => Promise<Map<number, ProcessInfo>>;
  now?: () => number;
}): (socket: Socket) => Promise<AgentRunMatch | null> {
  const now = deps.now ?? Date.now;
  const readConnections = deps.readConnectionPids ?? readConnectionPids;
  const runs = snapshot(deps.listRunningRunProcesses, now);
  const processes = snapshot(deps.readProcessTable ?? readProcessTable, now);
  const connectionsByPort = new Map<number, Snapshot<Map<string, number>>>();
  const firstSeen = new WeakMap<Socket, number>();

  function connections(port: number, freshAfter: number) {
    let forPort = connectionsByPort.get(port);
    if (!forPort) {
      forPort = snapshot(() => readConnections(port), now);
      connectionsByPort.set(port, forPort);
    }
    return forPort(freshAfter);
  }

  return async (socket) => {
    let seenAt = firstSeen.get(socket);
    if (seenAt === undefined) {
      seenAt = now();
      firstSeen.set(socket, seenAt);
    }
    const candidates = (await runs(-Infinity)).filter(
      (run) => run.processGroupId === run.processPid && run.processStartedAt !== null,
    );
    if (candidates.length === 0 || !socket.localPort) return null;

    const peerPid = (await connections(socket.localPort, seenAt)).get(clientConnectionKey(socket));
    if (peerPid === undefined) return null;
    const table = await processes(seenAt);

    const runByPid = new Map<number, RunningRunProcess>();
    for (const run of candidates) {
      const info = table.get(run.processPid);
      if (info?.startedAtMs == null) continue;
      if (Math.abs(info.startedAtMs - run.processStartedAt!.getTime()) > START_TIME_TOLERANCE_MS) continue;
      runByPid.set(run.processPid, run);
    }

    const toMatch = ({ runId, agentId, companyId, processPid }: RunningRunProcess): AgentRunMatch =>
      ({ runId, agentId, companyId, processPid });
    const group = runByPid.get(table.get(peerPid)?.pgid ?? 0);
    if (group) return toMatch(group);
    for (let pid = peerPid, depth = 0; pid > 1 && depth < MAX_ANCESTRY_DEPTH; pid = table.get(pid)?.ppid ?? 0, depth++) {
      const run = runByPid.get(pid);
      if (run) return toMatch(run);
    }
    return null;
  };
}

export function parseAgentRunUnauthenticatedWriteMode(value: string | undefined): AgentRunUnauthenticatedWriteMode {
  const mode = value?.trim().toLowerCase();
  return mode === "off" || mode === "reject" ? mode : "log";
}

export async function listRunningRunProcesses(db: Db): Promise<RunningRunProcess[]> {
  const rows = await db
    .select({
      runId: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      processPid: heartbeatRuns.processPid,
      processGroupId: heartbeatRuns.processGroupId,
      processStartedAt: heartbeatRuns.processStartedAt,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.status, "running"), isNotNull(heartbeatRuns.processPid)));
  return rows.map((row) => ({ ...row, processPid: row.processPid! }));
}

/** Only local-trusted instances turn credential-less requests into the board user. */
export function agentRunUnauthenticatedWriteGuardFor(opts: {
  deploymentMode: string;
  mode: string | undefined;
  findRunForSocket: (socket: Socket) => Promise<AgentRunMatch | null>;
  report: (write: UnauthenticatedAgentRunWrite) => void;
}): RequestHandler {
  const mode = parseAgentRunUnauthenticatedWriteMode(opts.mode);
  if (opts.deploymentMode !== "local_trusted" || mode === "off") {
    return (_req, _res, next) => next();
  }
  return agentRunUnauthenticatedWriteGuard({ mode, findRunForSocket: opts.findRunForSocket, report: opts.report });
}
