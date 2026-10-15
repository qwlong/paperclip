import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROCESS_GROUP_REUSE_SLACK_MS,
  readProcessGroupMemberStartedAt,
  runProcessGroupAlive,
} from "../services/run-process-group.js";

const posix = process.platform !== "win32";
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
  }
});

async function liveGroup() {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  children.push(child);
  await new Promise(resolve => child.once("spawn", resolve));
  return child.pid!;
}
const minutes = (n: number) => n * 60_000;

describe.skipIf(!posix)("run process group identity", () => {
  it("reads the start time of each live member of a group", async () => {
    const before = Date.now();
    const pgid = await liveGroup();
    const starts = await readProcessGroupMemberStartedAt(pgid);
    expect(starts).toHaveLength(1);
    // ps reports whole seconds.
    expect(starts[0].getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(starts[0].getTime()).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ["the run has not finished", null, true],
    ["the members started while the run was finishing", 0, true],
    ["the members started just inside the reuse slack", -(PROCESS_GROUP_REUSE_SLACK_MS - minutes(1)), true],
    ["every member started long after the run finished (reused group ID)", -minutes(60), false],
  ] as const)("treats a live group as the run's unless its members are newer: %s", async (_, finishedOffset, alive) => {
    const pgid = await liveGroup();
    const finishedAt = finishedOffset === null ? null : new Date(Date.now() + finishedOffset);
    expect(await runProcessGroupAlive({ processGroupId: pgid, finishedAt })).toBe(alive);
  });

  it("keeps a group alive while any member predates the run's end", async () => {
    const pgid = await liveGroup();
    const read = async () => [new Date(Date.now() - minutes(120)), new Date()];
    expect(await runProcessGroupAlive({ processGroupId: pgid, finishedAt: new Date(Date.now() - minutes(60)) }, read)).toBe(true);
  });

  it.each([
    ["the member list cannot be read", async () => { throw new Error("ps unavailable"); }],
    ["the group has no readable members", async () => []],
  ])("keeps a signalable group alive when %s", async (_, read) => {
    const pgid = await liveGroup();
    expect(await runProcessGroupAlive({ processGroupId: pgid, finishedAt: new Date(Date.now() - minutes(60)) }, read)).toBe(true);
  });

  it("reports a group with no processes as gone", async () => {
    const pgid = await liveGroup();
    process.kill(-pgid, "SIGKILL");
    await expect.poll(() => runProcessGroupAlive({ processGroupId: pgid, finishedAt: null })).toBe(false);
  });

  it("reports a run without a recorded group as having none alive", async () => {
    expect(await runProcessGroupAlive({ processGroupId: null, finishedAt: null })).toBe(false);
  });
});
