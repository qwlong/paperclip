import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
  UNMANAGED_BACKGROUND_TASK_STOP_REASON,
  type RunProcessResult,
  type TerminalResultCleanupEvidence,
} from "@paperclipai/adapter-utils/server-utils";

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

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const event = (value: Record<string, unknown>) => JSON.stringify({ session_id: SESSION_ID, ...value });

// A tool fetched API docs that name the 401 status; the run itself finished.
const toolOutputNamingUnauthorized = event({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '"401": { "description": "Unauthorized" }' }],
  },
});
const successResult = event({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Issue status repaired.",
  usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
});
const stoppedBackgroundTask: TerminalResultCleanupEvidence = {
  kind: "terminal_result_cleanup",
  stopped: true,
  stopReason: UNMANAGED_BACKGROUND_TASK_STOP_REASON,
  reason: UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
  terminalResultSeen: true,
  signal: "SIGTERM",
  forceKilled: false,
};

function processResult(overrides: Partial<RunProcessResult>): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [event({ type: "system", subtype: "init", model: "claude-sonnet" }), successResult].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("claude_local run error code", () => {
  let scratchDir: string;
  let workspaceDir: string;
  let instructionsPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    scratchDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-error-code-"));
    workspaceDir = path.join(scratchDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    instructionsPath = path.join(scratchDir, "instructions.md");
    await writeFile(instructionsPath, "Agent instructions.\n", "utf8");
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  function run() {
    return execute({
      runId: "run-error-code-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        engine: "cli",
        instructionsFilePath: instructionsPath,
        env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir },
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWorkspace: { cwd: workspaceDir, source: "agent_home" },
      },
      onLog: vi.fn(async () => {}),
    } as never);
  }

  it("does not blame a login that a tool output mentioned when a background task was stopped", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      processResult({
        exitCode: 143,
        stdout: [toolOutputNamingUnauthorized, successResult].join("\n"),
        terminalResultCleanup: stoppedBackgroundTask,
      }),
    );

    const result = await run();

    expect(result.exitCode).toBe(143);
    expect(result.errorCode).toBeNull();
  });

  it("leaves a clean success without an error code", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      processResult({ stdout: [toolOutputNamingUnauthorized, successResult].join("\n") }),
    );

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
  });

  it("keeps a real login failure ahead of a stopped background task", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      processResult({
        exitCode: 1,
        stdout: event({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in · Please run /login",
        }),
        terminalResultCleanup: stoppedBackgroundTask,
      }),
    );

    const result = await run();

    expect(result.errorCode).toBe("claude_auth_required");
  });
});
