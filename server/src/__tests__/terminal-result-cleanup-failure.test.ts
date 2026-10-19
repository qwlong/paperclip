import { describe, expect, it } from "vitest";
import { isTerminalResultCleanupFailure } from "../services/heartbeat/run-completion.js";

// Evidence exactly as claude_local recorded it on a run whose result was subtype "success".
const cleanupEvidence = {
  kind: "terminal_result_cleanup",
  reason: "unmanaged background task stopped; no durable live path",
  signal: "SIGTERM",
  stopped: true,
  stopReason: "unmanaged_background_task_stopped",
  forceKilled: false,
  terminalResultSeen: true,
};

describe("isTerminalResultCleanupFailure", () => {
  it("is true when the only failure is Paperclip stopping leftovers after the terminal result", () => {
    expect(isTerminalResultCleanupFailure({
      errorMessage: null,
      timedOut: false,
      resultJson: { subtype: "success", is_error: false, unmanagedBackgroundTask: cleanupEvidence },
    })).toBe(true);
  });

  it.each([
    ["the adapter reported an error", { errorMessage: "Claude exited with code 1" }],
    ["the run timed out", { timedOut: true }],
    ["no terminal result was seen", { evidence: { ...cleanupEvidence, terminalResultSeen: false } }],
    ["nothing was stopped", { evidence: { ...cleanupEvidence, stopped: false } }],
    ["there is no cleanup evidence", { evidence: undefined }],
    ["the evidence is not an object", { evidence: "stopped" }],
  ])("is false when %s", (_label, change: { errorMessage?: string; timedOut?: boolean; evidence?: unknown }) => {
    const evidence = "evidence" in change ? change.evidence : cleanupEvidence;
    expect(isTerminalResultCleanupFailure({
      errorMessage: change.errorMessage ?? null,
      timedOut: change.timedOut ?? false,
      resultJson: evidence === undefined ? {} : { unmanagedBackgroundTask: evidence },
    })).toBe(false);
  });

  it("is false without a result", () => {
    expect(isTerminalResultCleanupFailure({ errorMessage: null, timedOut: false, resultJson: null })).toBe(false);
  });
});
