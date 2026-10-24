import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClaudeStreamJson } from "./parse.js";
import {
  readClaudeSessionCostBaseline,
  subtractClaudeSessionCostBaseline,
  type ClaudeSessionCostBaseline,
} from "./session-cost-baseline.js";

const SESSION_ID = "8499c947-7acb-4d1f-b64f-729b5e7fc5cb";

// Taken from a production run that resumed a session and made 3 calls: the CLI
// restored the session's cost state, so the result reports the session total.
const restoredCostState = {
  type: "cost-state",
  sessionId: SESSION_ID,
  totalCostUSD: 20.4858672,
  totalAPIDuration: 2100150,
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
  hasUnknownModelCost: false,
};
const baseline: ClaudeSessionCostBaseline = {
  sessionId: SESSION_ID,
  totalCostUsd: restoredCostState.totalCostUSD,
  modelUsage: restoredCostState.modelUsage,
};
const opusSessionTotal = {
  inputTokens: 7833,
  outputTokens: 193507,
  thinkingTokens: 37098,
  cacheReadInputTokens: 54211970,
  cacheCreationInputTokens: 752587,
  webSearchRequests: 0,
  costUSD: 20.761490000000002,
  contextWindow: 1000000,
  maxOutputTokens: 128000,
  canonicalModel: "claude-opus-5-5",
};
const resumedResult = (extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: SESSION_ID,
  num_turns: 3,
  result: "done",
  total_cost_usd: 20.761490000000002,
  modelUsage: { "claude-opus-5-5": opusSessionTotal },
  ...extra,
});

describe("subtractClaudeSessionCostBaseline", () => {
  it("leaves only this invocation's usage and cost when the CLI restored the session total", () => {
    const adjusted = subtractClaudeSessionCostBaseline(resumedResult(), baseline);
    const opus = (adjusted.modelUsage as Record<string, Record<string, unknown>>)["claude-opus-5-5"];

    expect(opus.inputTokens).toBe(6);
    expect(opus.outputTokens).toBe(2015);
    expect(opus.thinkingTokens).toBe(268);
    expect(opus.cacheReadInputTokens).toBe(621254);
    expect(opus.cacheCreationInputTokens).toBe(13881);
    expect(opus.costUSD as number).toBeCloseTo(0.27562, 5);
    expect(adjusted.total_cost_usd as number).toBeCloseTo(0.27562, 5);
    // Descriptive fields are not counters and pass through.
    expect(opus.contextWindow).toBe(1000000);
    expect(opus.canonicalModel).toBe("claude-opus-5-5");
  });

  it("drops a model that only earlier invocations used", () => {
    const withHaiku: ClaudeSessionCostBaseline = {
      ...baseline,
      totalCostUsd: baseline.totalCostUsd + 0.5,
      modelUsage: {
        ...baseline.modelUsage,
        "claude-haiku-5-5": { inputTokens: 900, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 },
      },
    };
    const adjusted = subtractClaudeSessionCostBaseline(
      resumedResult({
        total_cost_usd: 21.261490000000002,
        modelUsage: {
          "claude-opus-5-5": opusSessionTotal,
          "claude-haiku-5-5": { inputTokens: 900, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 },
        },
      }),
      withHaiku,
    );

    expect(Object.keys(adjusted.modelUsage as object)).toEqual(["claude-opus-5-5"]);
    expect(adjusted.total_cost_usd as number).toBeCloseTo(0.27562, 5);
  });

  it("keeps a model this invocation used for the first time whole", () => {
    const haiku = { inputTokens: 300, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 };
    const adjusted = subtractClaudeSessionCostBaseline(
      resumedResult({
        total_cost_usd: 20.771490000000002,
        modelUsage: { "claude-opus-5-5": opusSessionTotal, "claude-haiku-5-5": haiku },
      }),
      baseline,
    );

    expect((adjusted.modelUsage as Record<string, unknown>)["claude-haiku-5-5"]).toEqual(haiku);
    expect(adjusted.total_cost_usd as number).toBeCloseTo(0.28562, 5);
  });

  it("subtracts the counters a projected result keeps and ignores the ones it drops", () => {
    // The usage checkpoint projects events down to the token and cost fields.
    const { thinkingTokens: _thinking, webSearchRequests: _search, contextWindow: _window, maxOutputTokens: _max, canonicalModel: _canonical, ...projected } =
      opusSessionTotal;
    const adjusted = subtractClaudeSessionCostBaseline(resumedResult({ modelUsage: { "claude-opus-5-5": projected } }), baseline);
    const opus = (adjusted.modelUsage as Record<string, Record<string, unknown>>)["claude-opus-5-5"];

    expect(opus.cacheReadInputTokens).toBe(621254);
    expect(opus).not.toHaveProperty("thinkingTokens");
    expect(adjusted.total_cost_usd as number).toBeCloseTo(0.27562, 5);
  });

  it.each([
    ["a counter below the baseline", { modelUsage: { "claude-opus-5-5": { ...opusSessionTotal, cacheReadInputTokens: 621254 } } }],
    ["a model of the baseline missing", { modelUsage: { "claude-sonnet-5-5": opusSessionTotal } }],
    ["the cost below the baseline", { total_cost_usd: 0.27562 }],
    ["another session", { session_id: "00000000-0000-4000-8000-000000000000" }],
  ])("leaves the result unchanged when the CLI did not restore this baseline (%s)", (_name, extra) => {
    const result = resumedResult(extra);

    expect(subtractClaudeSessionCostBaseline(result, baseline)).toEqual(result);
  });
});

describe("parseClaudeStreamJson with a session cost baseline", () => {
  const stream = (...results: Record<string, unknown>[]) =>
    [
      JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-opus-5-5" }),
      ...results.map((result) => JSON.stringify(result)),
    ].join("\n");

  it("reports a resumed run's own usage and cost", () => {
    const parsed = parseClaudeStreamJson(stream(resumedResult()), { costBaseline: baseline });

    expect(parsed.usage).toEqual({ inputTokens: 6 + 13881, outputTokens: 2015, cachedInputTokens: 621254 });
    expect(parsed.costUsd as number).toBeCloseTo(0.27562, 5);
    expect(parsed.usageBasis).toBe("per_run");
  });

  it("applies the baseline to a late task-notification result too", () => {
    const late = resumedResult({ origin: { kind: "task-notification" }, num_turns: 0, result: "" });
    const parsed = parseClaudeStreamJson(stream(resumedResult(), late), { costBaseline: baseline });

    expect(parsed.usage?.cachedInputTokens).toBe(621254);
  });

  it("reports the session total without a baseline, as a fresh session's total is its own", () => {
    const parsed = parseClaudeStreamJson(stream(resumedResult()));

    expect(parsed.usage?.cachedInputTokens).toBe(54211970);
  });
});

describe("readClaudeSessionCostBaseline", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cost-baseline-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  async function writeTranscript(projectDir: string, lines: Record<string, unknown>[]) {
    const dir = path.join(configDir, "projects", projectDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${SESSION_ID}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }

  it.each([undefined, 1, 7, 64])("returns the last cost state the CLI saved for the session (chunk %s bytes)", async (chunkBytes) => {
    await writeTranscript("-Users-me-repo", [
      { type: "user", message: { content: "hi" } },
      { ...restoredCostState, totalCostUSD: 17.75, modelUsage: { "claude-opus-5-5": { costUSD: 17.75 } } },
      { type: "assistant", message: { id: "m1" } },
      restoredCostState,
      { type: "last-prompt" },
    ]);

    expect(await readClaudeSessionCostBaseline({ configDir, sessionId: SESSION_ID, chunkBytes })).toEqual(baseline);
  });

  it("ignores a record that only mentions cost-state", async () => {
    await writeTranscript("-repo", [
      restoredCostState,
      { type: "assistant", message: { content: [{ type: "tool_use", input: { pattern: "cost-state", modelUsage: {}, totalCostUSD: 0 } }] } },
    ]);

    expect(await readClaudeSessionCostBaseline({ configDir, sessionId: SESSION_ID })).toEqual(baseline);
  });

  it("finds the transcript under any project directory", async () => {
    await mkdir(path.join(configDir, "projects", "-other"), { recursive: true });
    await writeTranscript("-Users-me-a-very-long-worktree-path-noindex", [restoredCostState]);

    expect(await readClaudeSessionCostBaseline({ configDir, sessionId: SESSION_ID })).toEqual(baseline);
  });

  it.each([
    ["no cost state in the transcript", async () => writeTranscript("-repo", [{ type: "user" }])],
    ["no transcript", async () => mkdir(path.join(configDir, "projects", "-repo"), { recursive: true })],
    ["no projects directory", async () => undefined],
    ["only a cost state cut off by a crash", async () => {
      await writeTranscript("-repo", []);
      await writeFile(path.join(configDir, "projects", "-repo", `${SESSION_ID}.jsonl`), JSON.stringify(restoredCostState).slice(0, 80));
    }],
    ["a cost state without usage", async () => writeTranscript("-repo", [{ type: "cost-state", sessionId: SESSION_ID, totalCostUSD: 3 }])],
  ])("returns null with %s", async (_name, arrange) => {
    await arrange();

    expect(await readClaudeSessionCostBaseline({ configDir, sessionId: SESSION_ID })).toBeNull();
  });
});
