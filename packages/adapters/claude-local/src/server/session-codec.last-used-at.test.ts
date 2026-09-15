import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

// Regression for MEM-371: execute.ts writes sessionParams.lastUsedAt so that
// adapterConfig.maxResumeIdleMinutes can decide whether a stale session should
// be resumed. The codec rebuilds the params object from an explicit allowlist,
// so a field the producer writes but the codec does not list is dropped on
// persist -- silently, with no error on either side. That is exactly what
// happened: at the time of diagnosis every stored session (549 then, 559 by
// the time of the fix) had no lastUsedAt, sessionIdleMinutes was always null,
// and the switch never fired once after a full 26-agent rollout.
//
// WHAT THESE TESTS DO NOT COVER -- read this before trusting them:
//
//   1. The producer contract. Every case below hands the codec an object this
//      file builds itself. Nothing here reads execute.ts. Rename lastUsedAt at
//      the write site (execute.ts, resolvedSessionParams) and all of these
//      still pass while the bug returns unchanged. The defect class is
//      "producer writes a key the codec allowlist omits", and that seam is
//      still untested. The durable fix is a shared field list rather than two
//      hand-maintained allowlists; filed as follow-up, not done here.
//   2. The decision itself. sessionIdleTooLong / sessionIdleMinutes in
//      execute.ts (~L800) has no unit test at all. These tests prove the value
//      survives storage, not that the resume decision reads it correctly.
//
// So: do not read a green run here as "maxResumeIdleMinutes works". It means
// "the codec no longer eats the field".

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

  // Named for what it actually does: both functions share one allowlist, so
  // this catches the two lists drifting apart -- not a real trip through storage.
  it("survives serialize(deserialize(x)) in both directions", () => {
    const stored = sessionCodec.serialize(
      sessionCodec.deserialize({ ...base, lastUsedAt: LAST_USED }),
    );
    expect(stored?.lastUsedAt).toBe(LAST_USED);

    // and a second round-trip, since every heartbeat re-persists
    const again = sessionCodec.serialize(sessionCodec.deserialize(stored));
    expect(again?.lastUsedAt).toBe(LAST_USED);
  });

  // The real storage hop is JSON.stringify -> jsonb -> JSON.parse. Lossless for
  // strings, so this can only fail if the codec starts emitting a non-JSON value.
  it("survives an actual JSON storage hop", () => {
    const out = sessionCodec.serialize({ ...base, lastUsedAt: LAST_USED });
    const reread = sessionCodec.deserialize(JSON.parse(JSON.stringify(out)));
    expect(reread?.lastUsedAt).toBe(LAST_USED);
  });

  // Speculative, kept only for symmetry with every neighbouring field: nothing
  // in this repo writes the snake_case spelling for this key today.
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
