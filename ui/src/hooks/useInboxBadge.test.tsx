// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listIssues: vi.fn(async () => []),
  inboxUnreadCount: vi.fn(async () => ({ count: 3 })),
}));

vi.mock("../api/issues", () => ({
  issuesApi: { list: mocks.listIssues, inboxUnreadCount: mocks.inboxUnreadCount },
}));
vi.mock("../api/approvals", () => ({ approvalsApi: { list: async () => [] } }));
vi.mock("../api/access", () => ({ accessApi: { listJoinRequests: async () => [] } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => null } }));
vi.mock("../api/dashboard", () => ({ dashboardApi: { summary: async () => undefined } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { list: async () => [] } }));
vi.mock("../api/inboxDismissals", () => ({ inboxDismissalsApi: { list: async () => [] } }));

import { useInboxBadge } from "./useInboxBadge";

type Badge = ReturnType<typeof useInboxBadge>;

function Harness({ onBadge }: { onBadge: (badge: Badge) => void }) {
  const badge = useInboxBadge("company-1");
  useEffect(() => onBadge(badge), [badge, onBadge]);
  return null;
}

describe("useInboxBadge", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.clearAllMocks();
  });

  it("counts unread mine issues from the server count, not from an issue list", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let latest: Badge | null = null;
    root = createRoot(document.createElement("div"));

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Harness onBadge={(badge) => { latest = badge; }} />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(latest?.mineIssues).toBe(3));

    expect(latest!.inbox).toBe(3);
    expect(mocks.inboxUnreadCount).toHaveBeenCalledWith("company-1");
    expect(mocks.listIssues).not.toHaveBeenCalled();
  });
});
