import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

const SESSION_ID = "8499c947-7acb-4d1f-b64f-729b5e7fc5cb";
const savedCostState = {
  type: "cost-state",
  sessionId: SESSION_ID,
  totalCostUSD: 20.4858672,
  modelUsage: {
    "claude-opus-5-5": {
      inputTokens: 7827,
      outputTokens: 191492,
      thinkingTokens: 36830,
      cacheReadInputTokens: 53590716,
      cacheCreationInputTokens: 738706,
      webSearchRequests: 0,
      costUSD: 20.4858672,
    },
  },
};
// The CLI restored the saved state, so this result reports the session total.
const sessionTotalResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: SESSION_ID,
  result: "done",
  total_cost_usd: 20.761490000000002,
  usage: { input_tokens: 2, cache_read_input_tokens: 300000, output_tokens: 900 },
  modelUsage: {
    "claude-opus-5-5": {
      inputTokens: 7833,
      outputTokens: 193507,
      thinkingTokens: 37098,
      cacheReadInputTokens: 54211970,
      cacheCreationInputTokens: 752587,
      webSearchRequests: 0,
      costUSD: 20.761490000000002,
      contextWindow: 1000000,
    },
  },
};
const stdout = [
  JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-opus-5-5" }),
  JSON.stringify(sessionTotalResult),
].join("\n") + "\n";
const ownUsage = { inputTokens: 6 + 13881, outputTokens: 2015, cachedInputTokens: 621254 };

describe("claude_local usage of a resumed session", () => {
  let scratchDir: string;
  let workspaceDir: string;
  let configDir: string;
  let instructionsPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    scratchDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-resumed-usage-"));
    workspaceDir = path.join(scratchDir, "workspace");
    configDir = path.join(scratchDir, "claude-config");
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = path.join(configDir, "projects", workspaceDir.replace(/[^a-zA-Z0-9-]/g, "-"));
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), `${JSON.stringify({ type: "user" })}\n${JSON.stringify(savedCostState)}\n`);
    instructionsPath = path.join(scratchDir, "instructions.md");
    await writeFile(instructionsPath, "Agent instructions.\n", "utf8");
    runAdapterExecutionTargetProcess.mockImplementation(
      async (_runId: string, _target: unknown, _command: string, _args: string[], opts: { onLog: (stream: "stdout", chunk: string) => Promise<void> }) => {
        await opts.onLog("stdout", stdout);
        return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 123, startedAt: new Date().toISOString() } satisfies RunProcessResult;
      },
    );
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  function run(onUsage: (receipt: { usage?: unknown; costUsd?: number | null }) => Promise<void>) {
    return execute({
      runId: "run-resumed-usage-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: {
        sessionId: SESSION_ID,
        sessionParams: { sessionId: SESSION_ID, cwd: workspaceDir },
        sessionDisplayId: SESSION_ID,
        taskKey: "issue-1",
      },
      config: {
        command: "claude",
        engine: "cli",
        resumeSessions: true,
        instructionsFilePath: instructionsPath,
        env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir, CLAUDE_CONFIG_DIR: configDir },
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_commented",
        paperclipWorkspace: { cwd: workspaceDir, source: "agent_home" },
      },
      onLog: vi.fn(async () => {}),
      onUsage,
    } as never);
  }

  it("records only this run's usage and cost, in the result and in the checkpoints", async () => {
    const onUsage = vi.fn(async (_receipt: { usage?: unknown; costUsd?: number | null }) => {});

    const result = await run(onUsage);

    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", SESSION_ID]);
    expect(result.usage).toEqual(ownUsage);
    expect(result.costUsd as number).toBeCloseTo(0.27562, 5);
    expect(result.usageByModel?.map((receipt) => receipt.usage)).toEqual([ownUsage]);
    expect(onUsage).toHaveBeenCalled();
    const checkpoint = onUsage.mock.calls.at(-1)?.[0];
    expect(checkpoint?.usage).toEqual(ownUsage);
    expect(checkpoint?.costUsd as number).toBeCloseTo(0.27562, 5);
  });
});
