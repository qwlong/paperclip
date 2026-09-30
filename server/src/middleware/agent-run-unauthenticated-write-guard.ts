import { execFile } from "node:child_process";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import type { RequestHandler } from "express";
import { and, eq, isNotNull } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

const execFileAsync = promisify(execFile);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_ANCESTRY_DEPTH = 64;

export interface AgentRunMatch {
  runId: string;
  agentId: string;
  companyId: string;
  processPid: number;
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
 * ancestry and logs or rejects them; everything else passes untouched.
 */
export function agentRunUnauthenticatedWriteGuard(opts: {
  mode: "log" | "reject";
  findRunForSocket: (socket: Socket) => Promise<AgentRunMatch | null>;
  report: (write: UnauthenticatedAgentRunWrite) => void;
}): RequestHandler {
  return async (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return next();
    if (req.actor?.type !== "board" || req.actor.source !== "local_implicit") return next();

    let run: AgentRunMatch | null;
    try {
      run = await opts.findRunForSocket(req.socket);
    } catch {
      return next();
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

/** The pid of the process on the other end of a loopback connection. */
export async function lookupLoopbackPeerPid(socket: Socket): Promise<number | null> {
  const port = socket.remotePort;
  if (!port) return null;
  // Both ends of the connection match `TCP:<port>`: the peer (local port) and
  // this server (remote port). The peer is the pid that is not ours.
  const { stdout } = await execFileAsync(
    "lsof",
    ["-nP", "-a", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fpn"],
    { timeout: 5_000 },
  ).catch((error: { stdout?: string; code?: number }) => {
    // lsof exits 1 when nothing matches.
    if (error.code === 1) return { stdout: error.stdout ?? "" };
    throw error;
  });
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      continue;
    }
    // `n<local>-><remote>`: the peer's own side of the socket is local port `port`.
    if (line.startsWith("n") && pid !== null) {
      const local = line.slice(1).split("->")[0] ?? "";
      if (local.endsWith(`:${port}`)) return pid;
    }
  }
  return null;
}

export async function readParentPids(): Promise<Map<number, number>> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  const parents = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid!, ppid!);
  }
  return parents;
}

/**
 * Resolves which running agent run, if any, owns the process behind a
 * connection. A connection's process never changes, so its ancestry is read
 * once per socket; the set of running runs is read on every call.
 */
export function createPeerRunResolver(deps: {
  listRunningRunProcesses: () => Promise<AgentRunMatch[]>;
  lookupPeerPid?: (socket: Socket) => Promise<number | null>;
  readParentPids?: () => Promise<Map<number, number>>;
}): (socket: Socket) => Promise<AgentRunMatch | null> {
  const lookupPeerPid = deps.lookupPeerPid ?? lookupLoopbackPeerPid;
  const readParents = deps.readParentPids ?? readParentPids;
  const ancestryBySocket = new WeakMap<Socket, Promise<number[]>>();

  async function ancestryOf(socket: Socket): Promise<number[]> {
    const pid = await lookupPeerPid(socket);
    if (pid === null) return [];
    const parents = await readParents();
    const chain: number[] = [];
    for (let current = pid; current > 1 && chain.length < MAX_ANCESTRY_DEPTH; current = parents.get(current) ?? 0) {
      chain.push(current);
    }
    return chain;
  }

  return async (socket) => {
    const runs = await deps.listRunningRunProcesses();
    if (runs.length === 0) return null;
    let ancestry = ancestryBySocket.get(socket);
    if (!ancestry) {
      ancestry = ancestryOf(socket);
      ancestryBySocket.set(socket, ancestry);
      ancestry.catch(() => ancestryBySocket.delete(socket));
    }
    const chain = await ancestry;
    const runByPid = new Map(runs.map((run) => [run.processPid, run]));
    for (const pid of chain) {
      const run = runByPid.get(pid);
      if (run) return run;
    }
    return null;
  };
}

export function parseAgentRunUnauthenticatedWriteMode(value: string | undefined): AgentRunUnauthenticatedWriteMode {
  const mode = value?.trim().toLowerCase();
  return mode === "off" || mode === "reject" ? mode : "log";
}

export async function listRunningRunProcesses(db: Db): Promise<AgentRunMatch[]> {
  const rows = await db
    .select({
      runId: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      processPid: heartbeatRuns.processPid,
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
