// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listIssues: vi.fn(async () => []),
  inboxUnreadIssueIds: vi.fn(async () => ({ issueIds: ["issue-a", "issue-b", "issue-c"] })),
}));

vi.mock("../api/issues", () => ({
  issuesApi: { list: mocks.listIssues, inboxUnreadIssueIds: mocks.inboxUnreadIssueIds },
}));
vi.mock("../api/approvals", () => ({ approvalsApi: { list: async () => [] } }));
vi.mock("../api/access", () => ({ accessApi: { listJoinRequests: async () => [] } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => null } }));
vi.mock("../api/dashboard", () => ({ dashboardApi: { summary: async () => undefined } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { list: async () => [] } }));
vi.mock("../api/inboxDismissals", () => ({ inboxDismissalsApi: { list: async () => [] } }));

import { beginLocalInboxArchive, clearLocalInboxArchive } from "../lib/inboxArchiveCache";
import { queryKeys } from "../lib/queryKeys";
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

  it("counts unread mine issues from the server's unread ids, not from an issue list", async () => {
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
    expect(mocks.inboxUnreadIssueIds).toHaveBeenCalledWith("company-1");
    expect(mocks.listIssues).not.toHaveBeenCalled();
  });

  async function renderBadge() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const badge: { current: Badge | null } = { current: null };
    root = createRoot(document.createElement("div"));
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Harness onBadge={(latest) => { badge.current = latest; }} />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(badge.current?.mineIssues).toBe(3));
    return { queryClient, badge };
  }

  it("drops at once when an unread issue is being archived, and stays down while a refetch still lists it", async () => {
    const { queryClient, badge } = await renderBadge();

    act(() => beginLocalInboxArchive("company-1", "issue-a"));
    await vi.waitFor(() => expect(badge.current?.mineIssues).toBe(2));

    // The server has not applied the archive yet, so a refetch still lists the issue.
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe("company-1") }));
    await vi.waitFor(() => expect(mocks.inboxUnreadIssueIds).toHaveBeenCalledTimes(2));
    expect(badge.current?.mineIssues).toBe(2);

    act(() => clearLocalInboxArchive("company-1", "issue-a"));
    await vi.waitFor(() => expect(badge.current?.mineIssues).toBe(3));
  });

  it("refetches when the mine list is invalidated, and not on other sidebar badge refreshes", async () => {
    const { queryClient } = await renderBadge();
    expect(mocks.inboxUnreadIssueIds).toHaveBeenCalledTimes(1);

    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges("company-1") }));
    expect(mocks.inboxUnreadIssueIds).toHaveBeenCalledTimes(1);

    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe("company-1") }));
    await vi.waitFor(() => expect(mocks.inboxUnreadIssueIds).toHaveBeenCalledTimes(2));
  });
});
