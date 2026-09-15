import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "11111111-2222-4333-8444-555555555555",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "11111111-2222-4333-8444-555555555555",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

type SpawnOptions = { stdin?: string; env: Record<string, string> };

function spawnOptions(callIndex = 0): SpawnOptions {
  const call = runAdapterExecutionTargetProcess.mock.calls[callIndex] as unknown as unknown[];
  return call[4] as SpawnOptions;
}

function spawnArgs(callIndex = 0): string[] {
  const call = runAdapterExecutionTargetProcess.mock.calls[callIndex] as unknown as unknown[];
  return call[3] as string[];
}

describe("claude_local stableFreshSessionPrompt", () => {
  let scratchDir: string;
  let workspaceDir: string;
  let instructionsPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    scratchDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-stable-prompt-"));
    workspaceDir = path.join(scratchDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    instructionsPath = path.join(scratchDir, "instructions.md");
    await writeFile(instructionsPath, "Agent instructions.\n", "utf8");
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  function buildContext(config: Record<string, unknown>, sessionParams: Record<string, unknown> | null = null) {
    return {
      runId: "run-stable-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: sessionParams ? SESSION_ID : null,
        sessionParams,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        engine: "cli",
        instructionsFilePath: instructionsPath,
        env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir },
        ...config,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWorkspace: { cwd: workspaceDir, source: "agent_home" },
      },
      onLog: vi.fn(async () => {}),
    };
  }

  it("leaves stdin and env untouched when the flag is off", async () => {
    await execute(buildContext({}) as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const { stdin, env } = spawnOptions();
    expect(typeof stdin).toBe("string");
    expect(stdin).not.toContain("PAPERCLIP_WAKE_PROMPT_FILE");
    expect(env.PAPERCLIP_WAKE_PROMPT_FILE).toBeUndefined();

    // Lets the verification script diff this stdin against the unpatched adapter.
    const dumpPath = process.env.STABLE_PROMPT_STDIN_DUMP;
    if (dumpPath) await writeFile(dumpPath, stdin ?? "", "utf8");
  });

  it("sends the fixed prompt on a fresh session and moves the wake prompt to a file", async () => {
    await execute(buildContext({}) as never);
    const originalStdin = spawnOptions().stdin ?? "";
    vi.clearAllMocks();

    await execute(buildContext({ stableFreshSessionPrompt: true }) as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const { stdin, env } = spawnOptions();
    expect(spawnArgs()).not.toContain("--resume");
    expect(stdin).toContain("PAPERCLIP_WAKE_PROMPT_FILE");
    expect(stdin).not.toContain("issue-1");

    const wakeFile = env.PAPERCLIP_WAKE_PROMPT_FILE;
    expect(wakeFile).toBe(path.join(scratchDir, "paperclip-wake-prompt-run-stable-1.md"));
    expect(await readFile(wakeFile, "utf8")).toBe(originalStdin);
  });

  it("keeps the fixed prompt byte-identical across runs with different wake payloads", async () => {
    await execute(buildContext({ stableFreshSessionPrompt: true }) as never);
    const first = spawnOptions();
    const firstWakePrompt = await readFile(first.env.PAPERCLIP_WAKE_PROMPT_FILE, "utf8");
    vi.clearAllMocks();

    const other = buildContext({
      stableFreshSessionPrompt: true,
      promptTemplate: "Different wake text for {{agent.name}}.",
    });
    other.runId = "run-stable-2";
    await execute(other as never);
    const second = spawnOptions();
    const secondWakePrompt = await readFile(second.env.PAPERCLIP_WAKE_PROMPT_FILE, "utf8");

    expect(second.stdin).toBe(first.stdin);
    expect(secondWakePrompt).not.toBe(firstWakePrompt);
    expect(secondWakePrompt).toContain("Different wake text for Claude Coder.");
  });

  it("does not use the file handoff on a resumed session", async () => {
    await execute(buildContext({ resumeSessions: true }, { sessionId: SESSION_ID }) as never);
    expect(spawnArgs()).toContain("--resume");
    const baselineResumeStdin = spawnOptions().stdin;
    vi.clearAllMocks();

    await execute(
      buildContext({ resumeSessions: true, stableFreshSessionPrompt: true }, { sessionId: SESSION_ID }) as never,
    );

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(spawnArgs()).toContain("--resume");
    const { stdin, env } = spawnOptions();
    expect(stdin).toBe(baselineResumeStdin);
    expect(stdin).not.toContain("PAPERCLIP_WAKE_PROMPT_FILE");
    expect(env.PAPERCLIP_WAKE_PROMPT_FILE).toBeUndefined();
  });
});
