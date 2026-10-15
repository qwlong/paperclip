import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { heartbeatRuns } from "@paperclipai/db";
import { readProcessStartedAt } from "./hot-restart.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "processGroupId" | "finishedAt">;

/** Covers clock skew between the run record and the process table, and
 * descendants a run spawned while it was being finalized. */
export const PROCESS_GROUP_REUSE_SLACK_MS = 10 * 60_000;

async function readProcessGroupMemberPids(processGroupId: number) {
  if (process.platform === "linux") {
    const pids: number[] = [];
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const stat = await readFile(`/proc/${name}/stat`, "utf8").catch(() => null);
      if (!stat) continue;
      const [state, , group] = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      if (Number(group) === processGroupId && state !== "Z" && state !== "X") pids.push(Number(name));
    }
    return pids;
  }
  const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=,pgid=,stat="]);
  return stdout.split("\n").map(line => line.trim().split(/\s+/))
    .filter(([pid, group, state]) => pid && Number(group) === processGroupId && !state?.startsWith("Z"))
    .map(([pid]) => Number(pid));
}

/** Start times of the group's live members; members that exit mid-read are skipped. */
export async function readProcessGroupMemberStartedAt(processGroupId: number) {
  const starts = await Promise.all((await readProcessGroupMemberPids(processGroupId))
    .map(pid => readProcessStartedAt(pid).then(startedAt => startedAt ? new Date(startedAt) : null, () => null)));
  return starts.filter((startedAt): startedAt is Date => startedAt !== null && !Number.isNaN(startedAt.getTime()));
}

/** The OS reissues a process group ID only after every member of the old group
 * has exited, so a live group whose members all started well after the run
 * finished belongs to some other program. Without that evidence the group is
 * treated as the run's. */
export async function runProcessGroupAlive(run: Run, readMemberStartedAt = readProcessGroupMemberStartedAt) {
  if (!run.processGroupId) return false;
  try { process.kill(-run.processGroupId, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; }
  if (!run.finishedAt) return true;
  const starts = await readMemberStartedAt(run.processGroupId).catch(() => []);
  const reusedAfter = run.finishedAt.getTime() + PROCESS_GROUP_REUSE_SLACK_MS;
  return !starts.length || starts.some(startedAt => startedAt.getTime() <= reusedAfter);
}
