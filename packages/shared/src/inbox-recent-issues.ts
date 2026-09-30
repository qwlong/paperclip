/** How many touched issues the Inbox lists, most recently active first. */
export const RECENT_ISSUES_LIMIT = 100;

/** How many touched issues the Inbox fetches before picking the recent ones. */
export const INBOX_TOUCHED_ISSUE_FETCH_LIMIT = 500;

type TimestampValue = string | Date | null | undefined;

export interface InboxActivityFields {
  lastActivityAt?: TimestampValue;
  lastExternalCommentAt?: TimestampValue;
  updatedAt: TimestampValue;
}

export function normalizeTimestamp(value: TimestampValue): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function issueLastActivityTimestamp(issue: InboxActivityFields): number {
  const lastActivityAt = normalizeTimestamp(issue.lastActivityAt);
  if (lastActivityAt > 0) return lastActivityAt;

  const lastExternalCommentAt = normalizeTimestamp(issue.lastExternalCommentAt);
  if (lastExternalCommentAt > 0) return lastExternalCommentAt;

  return normalizeTimestamp(issue.updatedAt);
}

export function sortIssuesByMostRecentActivity(a: InboxActivityFields, b: InboxActivityFields): number {
  const activityDiff = issueLastActivityTimestamp(b) - issueLastActivityTimestamp(a);
  if (activityDiff !== 0) return activityDiff;
  return normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt);
}

export function getRecentTouchedIssues<T extends InboxActivityFields>(issues: T[]): T[] {
  return [...issues].sort(sortIssuesByMostRecentActivity).slice(0, RECENT_ISSUES_LIMIT);
}

/** The number of unread issues among those the Inbox lists. */
export function countUnreadRecentTouchedIssues(
  issues: Array<InboxActivityFields & { isUnreadForMe?: boolean }>,
): number {
  return getRecentTouchedIssues(issues).filter((issue) => issue.isUnreadForMe).length;
}
