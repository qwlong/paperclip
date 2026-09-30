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

describe("the Inbox unread count follows the Inbox mine list", () => {
  const companyId = "company-1";
  const listKey = [...queryKeys.issues.listMineByMe(companyId), "compact"] as const;
  const countKey = queryKeys.issues.inboxUnreadCount(companyId);
  const unread = (id: string) => ({ id, isUnreadForMe: true }) as Issue;
  const read = (id: string) => ({ id, isUnreadForMe: false }) as Issue;

  function clientWith(list: Issue[] | undefined, count: number) {
    const queryClient = new QueryClient();
    if (list) queryClient.setQueryData<Issue[]>(listKey, list);
    queryClient.setQueryData(countKey, { count });
    return queryClient;
  }
  const countOf = (queryClient: QueryClient) => queryClient.getQueryData<{ count: number }>(countKey)?.count;

  it("is refreshed whenever the mine list is", async () => {
    const queryClient = clientWith([], 1);
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
    expect(queryClient.getQueryState(countKey)?.isInvalidated).toBe(true);
  });

  it("is not refreshed by sidebar badge invalidations, which fire on every run and activity event", async () => {
    const queryClient = clientWith([], 1);
    await queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
    expect(queryClient.getQueryState(countKey)?.isInvalidated).toBe(false);
  });

  it.each([
    { label: "an unread issue lowers it", list: [unread("a"), read("b")], id: "a", expected: 1 },
    { label: "a read issue leaves it", list: [unread("a"), read("b")], id: "b", expected: 2 },
    { label: "an issue no cached list holds leaves it", list: [unread("a")], id: "z", expected: 2 },
    { label: "an unread issue at zero keeps it at zero", list: [unread("a")], id: "a", expected: 0, start: 0 },
  ])("archiving $label at once", ({ list, id, expected, start }) => {
    const queryClient = clientWith(list, start ?? 2);
    removeIssueFromInboxCaches(queryClient, companyId, id);
    expect(countOf(queryClient)).toBe(expected);
    expect(queryClient.getQueryData<Issue[]>(listKey)?.some((cached) => cached.id === id)).toBe(false);
  });

  it("lowers it once when the same archive is applied twice", () => {
    const queryClient = clientWith([unread("a")], 2);
    removeIssueFromInboxCaches(queryClient, companyId, "a");
    removeIssueFromInboxCaches(queryClient, companyId, "a");
    expect(countOf(queryClient)).toBe(1);
  });

  it("comes back when a failed archive is restored", () => {
    const queryClient = clientWith([unread("a"), read("b")], 2);
    const snapshot = snapshotInboxIssueCaches(queryClient, companyId);
    removeIssueFromInboxCaches(queryClient, companyId, "a");
    restoreIssueToInboxCaches(queryClient, snapshot, "a");
    expect(countOf(queryClient)).toBe(2);
    expect(queryClient.getQueryData<Issue[]>(listKey)?.map((cached) => cached.id)).toEqual(["a", "b"]);
  });

  it("stays put when a failed archive of a read issue is restored", () => {
    const queryClient = clientWith([unread("a"), read("b")], 1);
    const snapshot = snapshotInboxIssueCaches(queryClient, companyId);
    removeIssueFromInboxCaches(queryClient, companyId, "b");
    restoreIssueToInboxCaches(queryClient, snapshot, "b");
    expect(countOf(queryClient)).toBe(1);
  });

  it("stays put when the issue is already back in the list by the time the archive fails", () => {
    const queryClient = clientWith([unread("a"), read("b")], 2);
    const snapshot = snapshotInboxIssueCaches(queryClient, companyId);
    removeIssueFromInboxCaches(queryClient, companyId, "a");
    // A refetch already brought back both the issue and the count.
    queryClient.setQueryData<Issue[]>(listKey, [unread("a"), read("b")]);
    queryClient.setQueryData(countKey, { count: 2 });
    restoreIssueToInboxCaches(queryClient, snapshot, "a");
    expect(countOf(queryClient)).toBe(2);
  });

  it("does not make a watched count count as inbox list data", () => {
    const queryClient = clientWith(undefined, 2);
    const observer = new QueryObserver(queryClient, { queryKey: countKey, queryFn: async () => ({ count: 2 }) });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(getIssuePresenceInActiveInboxCaches(queryClient, companyId, "a")).toBe("unknown");
    unsubscribe();
  });
});
