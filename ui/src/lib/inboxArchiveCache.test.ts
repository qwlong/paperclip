import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLocalInboxArchive,
  boundLocalInboxArchive,
  clearLocalInboxArchive,
  confirmLocalInboxArchive,
  filterLocalInboxArchivedIssues,
  getIssuePresenceInActiveInboxCaches,
  getLocalInboxArchiveIssueIds,
  removeIssueFromInboxCaches,
  restoreIssueToInboxCaches,
  snapshotInboxIssueCaches,
} from "./inboxArchiveCache";
import { queryKeys } from "./queryKeys";

function issue(id: string): Issue {
  return { id } as Issue;
}

describe("inboxArchiveCache", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const issueId of getLocalInboxArchiveIssueIds("company-1")) {
      clearLocalInboxArchive("company-1", issueId);
    }
  });

  it("restores only the failed archive during overlapping optimistic removals", () => {
    const companyId = "company-1";
    const queryClient = new QueryClient();
    const queryKey = [...queryKeys.issues.listMineByMe(companyId), "with-routine-executions"] as const;

    queryClient.setQueryData<Issue[]>(queryKey, [
      issue("issue-a"),
      issue("issue-b"),
      issue("issue-c"),
    ]);

    const archiveASnapshot = snapshotInboxIssueCaches(queryClient, companyId);
    removeIssueFromInboxCaches(queryClient, companyId, "issue-a");

    const archiveBSnapshot = snapshotInboxIssueCaches(queryClient, companyId);
    removeIssueFromInboxCaches(queryClient, companyId, "issue-b");

    restoreIssueToInboxCaches(queryClient, archiveASnapshot, "issue-a");

    expect(queryClient.getQueryData<Issue[]>(queryKey)?.map((cachedIssue) => cachedIssue.id)).toEqual([
      "issue-a",
      "issue-c",
    ]);

    restoreIssueToInboxCaches(queryClient, archiveBSnapshot, "issue-b");

    expect(queryClient.getQueryData<Issue[]>(queryKey)?.map((cachedIssue) => cachedIssue.id)).toEqual([
      "issue-a",
      "issue-b",
      "issue-c",
    ]);
  });

  it("filters locally archived issues until confirmed grace expires", () => {
    vi.useFakeTimers();
    const issues = [issue("issue-a"), issue("issue-b")];

    beginLocalInboxArchive("company-1", "issue-a");
    expect(filterLocalInboxArchivedIssues("company-1", issues)).toEqual([issue("issue-b")]);

    confirmLocalInboxArchive("company-1", "issue-a");
    vi.advanceTimersByTime(4_999);
    expect(filterLocalInboxArchivedIssues("company-1", issues)).toEqual([issue("issue-b")]);

    vi.advanceTimersByTime(1);
    expect(filterLocalInboxArchivedIssues("company-1", issues)).toEqual(issues);
  });

  it("does not expire an in-flight archive before post-settle bounding starts", () => {
    vi.useFakeTimers();
    beginLocalInboxArchive("company-1", "issue-a");

    vi.advanceTimersByTime(30_000);
    expect(getLocalInboxArchiveIssueIds("company-1").has("issue-a")).toBe(true);

    boundLocalInboxArchive("company-1", "issue-a");
    vi.advanceTimersByTime(29_999);
    expect(getLocalInboxArchiveIssueIds("company-1").has("issue-a")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(getLocalInboxArchiveIssueIds("company-1").has("issue-a")).toBe(false);
  });

  it("distinguishes present, absent, and unavailable active inbox data", () => {
    const companyId = "company-1";
    const queryClient = new QueryClient();
    const queryKey = [...queryKeys.issues.listMineByMe(companyId), "with-routine-executions"] as const;

    expect(getIssuePresenceInActiveInboxCaches(queryClient, companyId, "issue-a")).toBe("unknown");

    queryClient.setQueryData<Issue[]>(queryKey, [issue("issue-a")]);
    const observer = new QueryObserver<Issue[]>(queryClient, {
      queryKey,
      queryFn: async () => [],
    });
    const unsubscribe = observer.subscribe(() => undefined);

    expect(getIssuePresenceInActiveInboxCaches(queryClient, companyId, "issue-a")).toBe("present");
    queryClient.setQueryData<Issue[]>(queryKey, [issue("issue-b")]);
    expect(getIssuePresenceInActiveInboxCaches(queryClient, companyId, "issue-a")).toBe("absent");

    unsubscribe();
  });
});

describe("the Inbox unread issue ids follow the Inbox mine list", () => {
  const companyId = "company-1";
  const listKey = [...queryKeys.issues.listMineByMe(companyId), "compact"] as const;
  const idsKey = queryKeys.issues.inboxUnreadIssueIds(companyId);
  const unread = (id: string) => ({ id, isUnreadForMe: true }) as Issue;

  function clientWith(list: Issue[] | undefined, issueIds: string[]) {
    const queryClient = new QueryClient();
    if (list) queryClient.setQueryData<Issue[]>(listKey, list);
    queryClient.setQueryData(idsKey, { issueIds });
    return queryClient;
  }

  it("are refreshed whenever the mine list is", async () => {
    const queryClient = clientWith([], ["a"]);
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
    expect(queryClient.getQueryState(idsKey)?.isInvalidated).toBe(true);
  });

  it("are not refreshed by sidebar badge invalidations, which fire on every run and activity event", async () => {
    const queryClient = clientWith([], ["a"]);
    await queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
    expect(queryClient.getQueryState(idsKey)?.isInvalidated).toBe(false);
  });

  it("are left alone by the optimistic archive helpers, which handle issue lists", () => {
    const queryClient = clientWith([unread("a")], ["a"]);
    const snapshot = snapshotInboxIssueCaches(queryClient, companyId);
    removeIssueFromInboxCaches(queryClient, companyId, "a");
    restoreIssueToInboxCaches(queryClient, snapshot, "a");
    expect(snapshot.map(([queryKey]) => queryKey)).toEqual([listKey]);
    expect(queryClient.getQueryData(idsKey)).toEqual({ issueIds: ["a"] });
  });

  it("do not count as inbox list data when watched", () => {
    const queryClient = clientWith(undefined, ["a"]);
    const observer = new QueryObserver(queryClient, { queryKey: idsKey, queryFn: async () => ({ issueIds: ["a"] }) });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(getIssuePresenceInActiveInboxCaches(queryClient, companyId, "a")).toBe("unknown");
    unsubscribe();
  });
});
