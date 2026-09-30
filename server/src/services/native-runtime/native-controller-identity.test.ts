import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readProcessStartedAt: vi.fn<(pid: number) => Promise<string | null>>(),
  getServerInfoSnapshot: vi.fn(() => {
    throw new Error("controller identity must not read git metadata");
  }),
}));

vi.mock("../hot-restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hot-restart.js")>()),
  readProcessStartedAt: mocks.readProcessStartedAt,
}));

vi.mock("../../server-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server-info.js")>()),
  getServerInfoSnapshot: mocks.getServerInfoSnapshot,
}));

const { currentNativeControllerIdentity } = await import("./native-restart-recovery.js");
const { serverProcessStartedAt } = await import("../../server-info.js");

describe("currentNativeControllerIdentity", () => {
  beforeEach(() => {
    mocks.readProcessStartedAt.mockReset();
    mocks.getServerInfoSnapshot.mockClear();
  });

  it("uses the observed process start without reading git metadata", async () => {
    mocks.readProcessStartedAt.mockResolvedValue("2026-09-29T00:03:28.000Z");

    const identity = await currentNativeControllerIdentity();

    expect(mocks.readProcessStartedAt).toHaveBeenCalledWith(process.pid);
    expect(identity.pid).toBe(process.pid);
    expect(identity.processStartedAt.toISOString()).toBe("2026-09-29T00:03:28.000Z");
    expect(mocks.getServerInfoSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["the probe finds nothing", () => mocks.readProcessStartedAt.mockResolvedValue(null)],
    ["the probe fails", () => mocks.readProcessStartedAt.mockRejectedValue(new Error("ps failed"))],
  ])("falls back to the boot timestamp without reading git metadata when %s", async (_label, arrange) => {
    arrange();

    const identity = await currentNativeControllerIdentity();

    expect(identity.processStartedAt.toISOString()).toBe(serverProcessStartedAt);
    expect(mocks.getServerInfoSnapshot).not.toHaveBeenCalled();
  });
});
