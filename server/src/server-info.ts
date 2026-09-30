import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServerGitInfo, ServerGitLocalChanges, ServerInfoSnapshot } from "@paperclipai/shared";
import { parseBuildCommit, readBuildCommit } from "./build-commit.js";

export type { ServerGitInfo, ServerInfoSnapshot };

type GitCommand = () => Promise<string>;
type BuildCommitCommand = () => string | null;

const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const GIT_COMMAND_TIMEOUT_MS = 1500;
const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });
  return stdout;
}

// `git log -1` reads only the commit object. `git show` diffs a merge against
// its parents even with `-s`, which scales with the size of the merge.
export function readHeadCommitMetadata(cwd?: string): Promise<string> {
  return runGit(["log", "-1", "--format=%H%n%h%n%s%n%cI", "HEAD"], cwd);
}

function defaultGitStatusCommand(): Promise<string> {
  return runGit(["status", "--porcelain=v1", "--untracked-files=normal"]);
}

function defaultGitBranchCommand(): Promise<string> {
  return runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

function parseGitLocalChanges(output: string): ServerGitLocalChanges {
  let stagedFileCount = 0;
  let unstagedFileCount = 0;
  let untrackedFileCount = 0;

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";

    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedFileCount += 1;
      continue;
    }
    if (indexStatus !== " " && indexStatus !== "?") stagedFileCount += 1;
    if (worktreeStatus !== " " && worktreeStatus !== "?") unstagedFileCount += 1;
  }

  return {
    available: true,
    hasLocalChanges: stagedFileCount + unstagedFileCount + untrackedFileCount > 0,
    stagedFileCount,
    unstagedFileCount,
    untrackedFileCount,
  };
}

async function getGitLocalChanges(gitStatusCommand: GitCommand): Promise<ServerGitLocalChanges> {
  try {
    return parseGitLocalChanges(await gitStatusCommand());
  } catch {
    return { available: false, unavailableReason: "git_status_unavailable" };
  }
}

function parseGitInfo(
  output: string,
  branchName: string | null,
  localChanges: ServerGitLocalChanges,
): ServerGitInfo {
  const [fullSha = "", shortSha = "", subject = "", committedAt = ""] = output
    .trimEnd()
    .split("\n");
  const parsedFullSha = parseBuildCommit(fullSha);
  const committedAtTime = Date.parse(committedAt);

  if (!parsedFullSha || !SHORT_SHA_RE.test(shortSha)) {
    return { available: false, unavailableReason: "invalid_git_metadata" };
  }

  return {
    available: true,
    fullSha: parsedFullSha,
    shortSha,
    branchName,
    subject: subject.trim() || "No commit subject",
    committedAt: Number.isNaN(committedAtTime) ? null : new Date(committedAtTime).toISOString(),
    localChanges,
  };
}

async function readGitInfo(
  gitCommand: GitCommand = readHeadCommitMetadata,
  gitStatusCommand: GitCommand = defaultGitStatusCommand,
  gitBranchCommand: GitCommand = defaultGitBranchCommand,
  buildCommitCommand: BuildCommitCommand = readBuildCommit,
): Promise<ServerGitInfo> {
  const localChanges = getGitLocalChanges(gitStatusCommand);
  const branchName = gitBranchCommand().then((output) => output.trim() || null, () => null);
  try {
    const output = await gitCommand();
    return parseGitInfo(output, await branchName, await localChanges);
  } catch {
    const buildCommit = parseBuildCommit(buildCommitCommand());
    if (!buildCommit) {
      return { available: false, unavailableReason: "git_unavailable" };
    }

    return {
      available: true,
      fullSha: buildCommit,
      shortSha: buildCommit.slice(0, 7),
      branchName: null,
      subject: "Source build",
      committedAt: null,
      localChanges: {
        available: false,
        unavailableReason: "git_status_unavailable",
      },
    };
  }
}

export async function createServerInfoSnapshot(
  opts: {
    now?: Date;
    gitCommand?: GitCommand;
    gitStatusCommand?: GitCommand;
    gitBranchCommand?: GitCommand;
    buildCommitCommand?: BuildCommitCommand;
  } = {},
): Promise<ServerInfoSnapshot> {
  return {
    processStartedAt: (opts.now ?? new Date()).toISOString(),
    git: await readGitInfo(
      opts.gitCommand,
      opts.gitStatusCommand,
      opts.gitBranchCommand,
      opts.buildCommitCommand,
    ),
  };
}

// processStartedAt is a true boot constant, but the running commit can change
// without the Node process restarting: a managed dev-server restart re-runs the
// code while keeping this module alive, so a commit captured once at boot goes
// stale. Re-read git HEAD on demand, throttled by a short TTL so frequent health
// polls don't spawn git on every request. Callers that arrive while a refresh
// is running share it.
const GIT_INFO_CACHE_TTL_MS = 3000;
export const serverProcessStartedAt = new Date().toISOString();
let gitInfoCache: { value: Promise<ServerGitInfo>; expiresAt: number; settled: boolean } | null = null;

export async function getServerInfoSnapshot(
  opts: {
    now?: number;
    gitCommand?: GitCommand;
    gitStatusCommand?: GitCommand;
    gitBranchCommand?: GitCommand;
    buildCommitCommand?: BuildCommitCommand;
  } = {},
): Promise<ServerInfoSnapshot> {
  const now = opts.now ?? Date.now();
  if (!gitInfoCache || (gitInfoCache.settled && now >= gitInfoCache.expiresAt)) {
    const entry = {
      value: readGitInfo(opts.gitCommand, opts.gitStatusCommand, opts.gitBranchCommand, opts.buildCommitCommand),
      expiresAt: now + GIT_INFO_CACHE_TTL_MS,
      settled: false,
    };
    void entry.value.finally(() => {
      entry.settled = true;
    });
    gitInfoCache = entry;
  }
  return { processStartedAt: serverProcessStartedAt, git: await gitInfoCache.value };
}

export function resetServerInfoCacheForTests(): void {
  gitInfoCache = null;
}
