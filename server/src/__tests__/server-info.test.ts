import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServerInfoSnapshot,
  getServerInfoSnapshot,
  readHeadCommitMetadata,
  resetServerInfoCacheForTests,
} from "../server-info.js";

function gitCommandFor(shortSha: string, subject: string): () => Promise<string> {
  return async () =>
    [shortSha.padEnd(40, "0"), shortSha, subject, "2026-06-25T17:00:00-07:00"].join("\n");
}

describe("server info snapshot", () => {
  it("captures process start time and git metadata", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitBranchCommand: async () => "feature/server-info\n",
      gitStatusCommand: async () => "",
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: true,
        fullSha: "0123456789abcdef0123456789abcdef01234567",
        shortSha: "0123456",
        branchName: "feature/server-info",
        subject: "Add server info debug view",
        committedAt: "2026-06-26T00:00:00.000Z",
        localChanges: {
          available: true,
          hasLocalChanges: false,
          stagedFileCount: 0,
          unstagedFileCount: 0,
          untrackedFileCount: 0,
        },
      },
    });
  });

  it("summarizes local checkout changes without exposing file paths", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitStatusCommand: async () =>
        [
          "M  packages/shared/src/types/server-info.ts",
          " M ui/src/components/SidebarServerInfo.tsx",
          "MM server/src/server-info.ts",
          "?? server/src/__tests__/server-info.test.ts",
        ].join("\n"),
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      localChanges: {
        available: true,
        hasLocalChanges: true,
        stagedFileCount: 2,
        unstagedFileCount: 2,
        untrackedFileCount: 1,
      },
    });
  });

  it("keeps commit metadata available when git status is unavailable", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitStatusCommand: async () => {
        throw new Error("status unavailable");
      },
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      localChanges: {
        available: false,
        unavailableReason: "git_status_unavailable",
      },
    });
  });

  it("keeps commit metadata available when HEAD is detached", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitBranchCommand: async () => {
        throw new Error("detached HEAD");
      },
      gitStatusCommand: async () => "",
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      branchName: null,
      shortSha: "0123456",
    });
  });

  it("uses sanitized fallback metadata when git is unavailable", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () => {
        throw new Error("fatal: not a git repository");
      },
      buildCommitCommand: () => null,
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
    });
  });

  it("uses deployment commit metadata when the runtime has no git directory", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () => {
        throw new Error("fatal: not a git repository");
      },
      buildCommitCommand: () => "0123456789abcdef0123456789abcdef01234567",
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: true,
        fullSha: "0123456789abcdef0123456789abcdef01234567",
        shortSha: "0123456",
        branchName: null,
        subject: "Source build",
        committedAt: null,
        localChanges: {
          available: false,
          unavailableReason: "git_status_unavailable",
        },
      },
    });
  });
});

describe("getServerInfoSnapshot", () => {
  beforeEach(() => {
    resetServerInfoCacheForTests();
  });

  it("re-reads the running commit after the cache TTL expires", async () => {
    const first = await getServerInfoSnapshot({
      now: 0,
      gitCommand: gitCommandFor("aaaaaaa", "First boot"),
    });
    expect(first.git).toMatchObject({ shortSha: "aaaaaaa", subject: "First boot" });

    // Within the TTL window the cached commit is reused.
    const cached = await getServerInfoSnapshot({
      now: 1000,
      gitCommand: gitCommandFor("bbbbbbb", "After restart"),
    });
    expect(cached.git).toMatchObject({ shortSha: "aaaaaaa", subject: "First boot" });

    // Past the TTL the new HEAD is picked up without a process restart.
    const refreshed = await getServerInfoSnapshot({
      now: 3000,
      gitCommand: gitCommandFor("bbbbbbb", "After restart"),
    });
    expect(refreshed.git).toMatchObject({ shortSha: "bbbbbbb", subject: "After restart" });
  });

  it("keeps processStartedAt stable across refreshes", async () => {
    const first = await getServerInfoSnapshot({ now: 0, gitCommand: gitCommandFor("aaaaaaa", "a") });
    const second = await getServerInfoSnapshot({ now: 5000, gitCommand: gitCommandFor("bbbbbbb", "b") });
    expect(second.processStartedAt).toBe(first.processStartedAt);
  });

  it("shares one in-flight refresh across concurrent callers", async () => {
    let release!: (value: string) => void;
    let calls = 0;
    const gitCommand = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const pending = [0, 1000, 5000].map((now) =>
      getServerInfoSnapshot({ now, gitCommand, gitStatusCommand: async () => "", gitBranchCommand: async () => "main" }),
    );
    release(await gitCommandFor("aaaaaaa", "Shared")());
    const snapshots = await Promise.all(pending);

    expect(calls).toBe(1);
    for (const snapshot of snapshots) {
      expect(snapshot.git).toMatchObject({ shortSha: "aaaaaaa", subject: "Shared" });
    }
  });

  it("falls back when git fails and caches the fallback for the TTL", async () => {
    let calls = 0;
    const failingGit = async () => {
      calls += 1;
      throw new Error("fatal: not a git repository");
    };
    const first = await getServerInfoSnapshot({ now: 0, gitCommand: failingGit, buildCommitCommand: () => null });
    const cached = await getServerInfoSnapshot({ now: 2000, gitCommand: failingGit, buildCommitCommand: () => null });

    expect(first.git).toEqual({ available: false, unavailableReason: "git_unavailable" });
    expect(cached.git).toEqual(first.git);
    expect(calls).toBe(1);
  });

  it("reads git without blocking the event loop", async () => {
    let loopTurned = false;
    setImmediate(() => {
      loopTurned = true;
    });
    const snapshot = await getServerInfoSnapshot({ now: 0 });

    // Precondition: the default commands really ran against this checkout.
    expect(snapshot.git.available).toBe(true);
    expect(loopTurned).toBe(true);
  });
});

describe("readHeadCommitMetadata", () => {
  let repo: string;

  function git(args: string[], input?: string): string {
    return execFileSync("git", args, {
      cwd: repo,
      input,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_COMMITTER_DATE: "2026-06-25T17:00:00-07:00",
      },
    }).trim();
  }

  function tree(entries: string, allowMissing = false): string {
    return git(["mktree", ...(allowMissing ? ["--missing"] : [])], entries);
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "server-info-head-"));
    git(["init", "-q"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // A merge whose parent points at a tree that is not in the object store: any
  // command that diffs the merge against its parents fails, so the read only
  // succeeds if it never walks trees. Walking trees is what made a large merge
  // HEAD cost hundreds of milliseconds of blocked event loop per refresh.
  function commitMergeWithUnreadableParentTree(): string {
    const leaf = (content: string) =>
      tree(`100644 blob ${git(["hash-object", "-w", "--stdin"], content)}\tf\n`);
    const root = git(["commit-tree", tree(""), "-m", "root"]);
    const left = git(["commit-tree", tree(`040000 tree ${leaf("a")}\td\n`), "-p", root, "-m", "left"]);
    const right = git([
      "commit-tree",
      tree(`040000 tree ${"2".repeat(40)}\td\n`, true),
      "-p",
      root,
      "-m",
      "right",
    ]);
    const merge = git([
      "commit-tree",
      tree(`040000 tree ${leaf("c")}\td\n`),
      "-p",
      left,
      "-p",
      right,
      "-m",
      "Merge upstream",
    ]);
    git(["update-ref", "HEAD", merge]);
    return merge;
  }

  it("reads a merge HEAD without diffing it against its parents", async () => {
    const merge = commitMergeWithUnreadableParentTree();
    // Precondition: diffing this merge really fails, so the fixture can tell.
    expect(() => git(["show", "-s", "--format=%H", "HEAD"])).toThrow();

    const snapshot = await createServerInfoSnapshot({
      gitCommand: () => readHeadCommitMetadata(repo),
      gitStatusCommand: async () => "",
      gitBranchCommand: async () => "main",
    });

    expect(snapshot.git).toEqual({
      available: true,
      fullSha: merge,
      shortSha: merge.slice(0, 7),
      branchName: "main",
      subject: "Merge upstream",
      committedAt: "2026-06-26T00:00:00.000Z",
      localChanges: {
        available: true,
        hasLocalChanges: false,
        stagedFileCount: 0,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
      },
    });
  });
});
