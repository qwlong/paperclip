import fs from "node:fs/promises";
import path from "node:path";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

/**
 * The cost state Claude Code saved at the end of a session's last invocation.
 * `--resume` restores it, so the next invocation's result `modelUsage` and
 * `total_cost_usd` start from these totals instead of zero.
 */
export type ClaudeSessionCostBaseline = {
  sessionId: string;
  totalCostUsd: number;
  modelUsage: Record<string, Record<string, unknown>>;
};

const COST_STATE_MARKER = Buffer.from('"cost-state"');
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

async function findSessionTranscript(configDir: string, sessionId: string): Promise<string | null> {
  const projectsDir = path.join(configDir, "projects");
  const projects = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue;
    const candidate = path.join(projectsDir, project.name, `${sessionId}.jsonl`);
    if (await fs.stat(candidate).then((stat) => stat.isFile(), () => false)) return candidate;
  }
  return null;
}

function parseCostState(line: Buffer): Record<string, unknown> | null {
  if (!line.includes(COST_STATE_MARKER)) return null;
  try {
    const record = parseObject(JSON.parse(line.toString("utf8")) as unknown);
    return asString(record.type, "") === "cost-state" ? record : null;
  } catch {
    // A line cut off by a crash is not a cost state.
    return null;
  }
}

/** Transcripts can reach hundreds of MiB, and the last cost state sits near the end, so read backwards. */
async function readLastCostState(transcript: string, chunkBytes: number): Promise<Record<string, unknown> | null> {
  const file = await fs.open(transcript, "r");
  try {
    let position = (await file.stat()).size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(chunkBytes, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await file.read(chunk, 0, length, position);
      const buffer = Buffer.concat([chunk, carry]);
      let end = buffer.length;
      for (let newline = buffer.lastIndexOf(10, end - 1); newline >= 0; newline = buffer.lastIndexOf(10, end - 1)) {
        const found = parseCostState(buffer.subarray(newline + 1, end));
        if (found) return found;
        end = newline;
        if (end === 0) break;
      }
      carry = Buffer.from(buffer.subarray(0, end));
    }
    return carry.length > 0 ? parseCostState(carry) : null;
  } finally {
    await file.close();
  }
}

export async function readClaudeSessionCostBaseline(input: {
  configDir: string;
  sessionId: string;
  chunkBytes?: number;
}): Promise<ClaudeSessionCostBaseline | null> {
  const transcript = await findSessionTranscript(input.configDir, input.sessionId);
  if (!transcript) return null;

  const last = await readLastCostState(transcript, input.chunkBytes ?? DEFAULT_CHUNK_BYTES).catch(() => null);
  if (!last) return null;
  const modelUsage = parseObject(last.modelUsage);
  const totalCostUsd = last.totalCostUSD;
  if (Object.keys(modelUsage).length === 0 || typeof totalCostUsd !== "number" || !Number.isFinite(totalCostUsd)) {
    return null;
  }
  return {
    sessionId: asString(last.sessionId, input.sessionId),
    totalCostUsd,
    modelUsage: Object.fromEntries(Object.entries(modelUsage).map(([model, entry]) => [model, parseObject(entry)])),
  };
}

/**
 * Turn a resumed invocation's result into this invocation's own usage and
 * cost. Only the counters the cost state carries are subtracted; descriptive
 * fields such as `contextWindow` pass through. When any total is below the
 * baseline, the CLI did not restore it, and the result is returned unchanged.
 */
export function subtractClaudeSessionCostBaseline(
  result: Record<string, unknown>,
  baseline: ClaudeSessionCostBaseline,
): Record<string, unknown> {
  if (asString(result.session_id, "") !== baseline.sessionId) return result;
  const totalCostUsd = result.total_cost_usd;
  if (typeof totalCostUsd !== "number" || totalCostUsd < baseline.totalCostUsd) return result;

  const sessionUsage = parseObject(result.modelUsage);
  const ownUsage: Record<string, Record<string, unknown>> = {};
  for (const [model, rawEntry] of Object.entries(sessionUsage)) ownUsage[model] = { ...parseObject(rawEntry) };

  for (const [model, before] of Object.entries(baseline.modelUsage)) {
    const entry = ownUsage[model];
    if (!entry) return result;
    let usedNow = false;
    for (const [counter, beforeValue] of Object.entries(before)) {
      if (typeof beforeValue !== "number" || entry[counter] === undefined) continue;
      const total = asNumber(entry[counter], Number.NaN);
      if (!(total >= beforeValue)) return result;
      entry[counter] = total - beforeValue;
      usedNow ||= entry[counter] !== 0;
    }
    if (!usedNow) delete ownUsage[model];
  }

  return { ...result, modelUsage: ownUsage, total_cost_usd: totalCostUsd - baseline.totalCostUsd };
}
