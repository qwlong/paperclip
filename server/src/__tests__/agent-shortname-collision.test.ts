import { describe, expect, it } from "vitest";
import { deriveAgentUrlKey } from "@paperclipai/shared";
import { hasAgentShortnameCollision, deduplicateAgentName } from "../services/agents.ts";

describe("hasAgentShortnameCollision", () => {
  it("detects collisions by normalized shortname", () => {
    const collision = hasAgentShortnameCollision("Codex Coder", [
      { id: "a1", name: "codex-coder", status: "idle" },
    ]);
    expect(collision).toBe(true);
  });

  it("ignores terminated agents", () => {
    const collision = hasAgentShortnameCollision("Codex Coder", [
      { id: "a1", name: "codex-coder", status: "terminated" },
    ]);
    expect(collision).toBe(false);
  });

  it("ignores the excluded agent id", () => {
    const collision = hasAgentShortnameCollision(
      "Codex Coder",
      [
        { id: "a1", name: "codex-coder", status: "idle" },
        { id: "a2", name: "other-agent", status: "idle" },
      ],
      { excludeAgentId: "a1" },
    );
    expect(collision).toBe(false);
  });

  it("does not collide when candidate has no shortname", () => {
    const collision = hasAgentShortnameCollision("!!!", [
      { id: "a1", name: "codex-coder", status: "idle" },
    ]);
    expect(collision).toBe(false);
  });

  it("does not collide two non-ASCII names that share a latin remainder", () => {
    // Both normalize to "getmemorial" once the CJK is stripped, but a reader sees
    // two different agents and deriveAgentUrlKey gives each a short-id suffix.
    const collision = hasAgentShortnameCollision("工程师 · GetMemorial", [
      { id: "a1", name: "增长 · GetMemorial", status: "idle" },
    ]);
    expect(collision).toBe(false);
  });

  it("still collides when both names are ASCII", () => {
    const collision = hasAgentShortnameCollision("Engineer GetMemorial", [
      { id: "a1", name: "engineer-getmemorial", status: "idle" },
    ]);
    expect(collision).toBe(true);
  });
});

describe("deduplicateAgentName", () => {
  it("returns original name when no collision", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "other-agent", status: "idle" },
    ]);
    expect(name).toBe("OpenClaw");
  });

  it("appends suffix when name collides", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "openclaw", status: "idle" },
    ]);
    expect(name).toBe("OpenClaw 2");
  });

  it("increments suffix until unique", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "openclaw", status: "idle" },
      { id: "a2", name: "openclaw-2", status: "idle" },
      { id: "a3", name: "openclaw-3", status: "idle" },
    ]);
    expect(name).toBe("OpenClaw 4");
  });

  it("ignores terminated agents for collision", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "openclaw", status: "terminated" },
    ]);
    expect(name).toBe("OpenClaw");
  });
});

describe("deriveAgentUrlKey", () => {
  const ID_A = "e25fba85-eafd-4be4-b714-000000000001";
  const ID_B = "e3229c92-dc46-41ad-9ee3-000000000002";

  it("keeps the plain slug for an ASCII name", () => {
    expect(deriveAgentUrlKey("Engineer GetMemorial", ID_A)).toBe("engineer-getmemorial");
  });

  it("suffixes a short id when the name carries non-ASCII content", () => {
    expect(deriveAgentUrlKey("增长 · GetMemorial", ID_A)).toBe("getmemorial-e25fba85");
    expect(deriveAgentUrlKey("工程师 · GetMemorial", ID_B)).toBe("getmemorial-e3229c92");
  });

  it("falls back to the short id when normalization leaves nothing", () => {
    // Previously this returned the whole agent id, so the agent had no usable
    // short handle at all.
    expect(deriveAgentUrlKey("增长 · 纪念宝", ID_A)).toBe("e25fba85");
  });

  it("keeps the documented fallbacks", () => {
    expect(deriveAgentUrlKey(null, null)).toBe("agent");
    expect(deriveAgentUrlKey("", "Legacy Name")).toBe("legacy-name");
  });
});
