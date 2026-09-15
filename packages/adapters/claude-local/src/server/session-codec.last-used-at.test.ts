import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

// Regression for MEM-371: execute.ts writes sessionParams.lastUsedAt so that
// adapterConfig.maxResumeIdleMinutes can decide whether a stale session should
// be resumed. The codec rebuilds the params object from an explicit allowlist,
// so a field that execute.ts writes but the codec does not list is dropped on
// persist -- silently, with no error on either side. That is exactly what
// happened: 549/549 stored sessions had no lastUsedAt, sessionIdleMinutes was
// always null, and the switch never fired once after a full rollout.
//
// These tests cross the write -> persist -> read-back boundary, which the
// original patch's tests did not.

const base = {
  sessionId: "55a5f9e8-1142-4b24-ac35-951da09fa8d5",
  cwd: "/tmp/work",
  promptBundleKey: "bundle-key",
  mcpServerIdentity: "[]",
};

const LAST_USED = "2026-09-15T07:30:00.000Z";

describe("sessionCodec preserves lastUsedAt", () => {
  it("serialize keeps lastUsedAt", () => {
    const out = sessionCodec.serialize({ ...base, lastUsedAt: LAST_USED });
    expect(out?.lastUsedAt).toBe(LAST_USED);
  });

  it("deserialize keeps lastUsedAt", () => {
    const out = sessionCodec.deserialize({ ...base, lastUsedAt: LAST_USED });
    expect(out?.lastUsedAt).toBe(LAST_USED);
  });

  it("survives the full persist round-trip serialize(deserialize(x))", () => {
    const stored = sessionCodec.serialize(
      sessionCodec.deserialize({ ...base, lastUsedAt: LAST_USED }),
    );
    expect(stored?.lastUsedAt).toBe(LAST_USED);

    // and a second round-trip, since every heartbeat re-persists
    const again = sessionCodec.serialize(sessionCodec.deserialize(stored));
    expect(again?.lastUsedAt).toBe(LAST_USED);
  });

  it("accepts the snake_case spelling too", () => {
    const out = sessionCodec.serialize({ ...base, last_used_at: LAST_USED });
    expect(out?.lastUsedAt).toBe(LAST_USED);
  });

  it("omits the key entirely when absent, so existing rows are untouched", () => {
    const out = sessionCodec.serialize({ ...base });
    expect(out).not.toHaveProperty("lastUsedAt");
  });

  it("does not disturb the other persisted fields", () => {
    const out = sessionCodec.serialize({ ...base, lastUsedAt: LAST_USED });
    expect(out?.sessionId).toBe(base.sessionId);
    expect(out?.cwd).toBe(base.cwd);
    expect(out?.promptBundleKey).toBe(base.promptBundleKey);
    expect(out?.mcpServerIdentity).toBe(base.mcpServerIdentity);
  });
});
