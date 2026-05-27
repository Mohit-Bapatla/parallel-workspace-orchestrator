import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { execa, type ExecaError } from "execa";

import type { AutoResolvePolicy, MergeResult, MergeStrategy } from "./types.js";

export async function verifyGitRepo(repoPath: string): Promise<void> {
  try {
    const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath });
    if (result.stdout.trim() !== "true") {
      throw new Error(`Path is not inside a Git work tree: ${repoPath}`);
    }
  } catch (error) {
    throw new Error(`Not a Git repository at ${repoPath}: ${errorMessage(error)}`);
  }
}

export async function ensureCleanWorkingTree(repoPath: string): Promise<void> {
  const status = await git(repoPath, ["status", "--porcelain"], "Unable to inspect Git working tree");
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `Repository must be clean before orchestration starts: ${repoPath}\n${status.stdout}`,
    );
  }
}

export async function getCurrentSha(repoPath: string, ref: string): Promise<string> {
  const result = await git(repoPath, ["rev-parse", ref], `Unable to resolve Git ref "${ref}"`);
  return result.stdout.trim();
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const result = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repoPath,
    reject: false,
  });
  return result.exitCode === 0;
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const result = await git(repoPath, ["branch", "--format=%(refname:short)"], "Unable to list branches");
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface GitWorktreeInfo {
  path: string;
  branch?: string;
  head?: string;
}

export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  const result = await git(repoPath, ["worktree", "list", "--porcelain"], "Unable to list worktrees");
  const worktrees: GitWorktreeInfo[] = [];
  let current: Partial<GitWorktreeInfo> = {};

  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      if (current.path !== undefined) {
        worktrees.push(toWorktreeInfo(current));
      }
      current = {};
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      current.path = value;
    } else if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    }
  }

  if (current.path !== undefined) {
    worktrees.push(toWorktreeInfo(current));
  }

  return worktrees;
}

export async function isBranchMerged(
  repoPath: string,
  baseBranch: string,
  branch: string,
): Promise<boolean> {
  const result = await execa("git", ["merge-base", "--is-ancestor", branch, baseBranch], {
    cwd: repoPath,
    reject: false,
  });
  return result.exitCode === 0;
}

export async function gitPush(repoPath: string, remote: string, baseBranch: string): Promise<void> {
  await git(repoPath, ["push", remote, baseBranch], `Unable to push ${baseBranch} to ${remote}`);
}

export async function createWorktree(args: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}): Promise<void> {
  const parentDir = path.dirname(args.worktreePath);
  await mkdir(parentDir, { recursive: true });

  const worktreeState = await getWorktreePathState(args.worktreePath);
  if (worktreeState === "git-worktree") {
    return;
  }
  if (worktreeState === "non-empty") {
    throw new Error(`Worktree path exists and is not an empty directory or Git worktree: ${args.worktreePath}`);
  }

  const exists = await branchExists(args.repoPath, args.branch);
  const gitArgs = exists
    ? ["worktree", "add", args.worktreePath, args.branch]
    : ["worktree", "add", "-b", args.branch, args.worktreePath, args.baseRef];

  await git(args.repoPath, gitArgs, `Unable to create Git worktree at ${args.worktreePath}`);
}

function toWorktreeInfo(value: Partial<GitWorktreeInfo>): GitWorktreeInfo {
  if (value.path === undefined) {
    throw new Error("Invalid Git worktree entry without a path.");
  }
  const info: GitWorktreeInfo = { path: value.path };
  if (value.branch !== undefined) {
    info.branch = value.branch;
  }
  if (value.head !== undefined) {
    info.head = value.head;
  }
  return info;
}

export async function hasCommitsAhead(
  repoPath: string,
  baseRef: string,
  branch: string,
): Promise<boolean> {
  const result = await git(
    repoPath,
    ["rev-list", "--count", `${baseRef}..${branch}`],
    `Unable to compare ${branch} against ${baseRef}`,
  );
  return Number.parseInt(result.stdout.trim(), 10) > 0;
}

export async function hasDirtyChanges(worktreePath: string): Promise<boolean> {
  const result = await git(
    worktreePath,
    ["status", "--porcelain"],
    "Unable to inspect Git worktree status",
  );
  return result.stdout.trim().length > 0;
}

export async function autoCommitIfDirty(worktreePath: string, message: string): Promise<boolean> {
  if (!(await hasDirtyChanges(worktreePath))) {
    return false;
  }

  await git(worktreePath, ["add", "-A"], "Unable to stage dirty changes");
  await git(
    worktreePath,
    [
      "-c",
      "user.name=AWO Bot",
      "-c",
      "user.email=awo@example.local",
      "commit",
      "-m",
      message,
    ],
    "Unable to commit dirty changes",
  );
  return true;
}

export async function runTestCommand(
  cwd: string,
  command: string,
): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  const result = await execa(command, { cwd, shell: true, reject: false });
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function listConflictedFiles(repoPath: string): Promise<string[]> {
  const result = await git(
    repoPath,
    ["diff", "--name-only", "--diff-filter=U"],
    "Unable to list conflicted files",
  );
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function mergeBranch(args: {
  repoPath: string;
  baseBranch: string;
  branch: string;
  strategy: MergeStrategy;
  autoResolvePolicies?: AutoResolvePolicy[];
}): Promise<MergeResult> {
  await git(args.repoPath, ["checkout", args.baseBranch], `Unable to checkout ${args.baseBranch}`);

  const mergeArgs =
    args.strategy === "squash"
      ? ["merge", "--squash", args.branch]
      : ["merge", "--no-ff", "--no-edit", args.branch];
  const merge = await execa("git", mergeArgs, { cwd: args.repoPath, reject: false });

  if (merge.exitCode === 0) {
    if (args.strategy === "squash") {
      await commitMerge(args.repoPath, `AWO squash merge ${args.branch}`);
    }
    return {
      ok: true,
      conflictedFiles: [],
      merged: true,
      stdout: merge.stdout,
      stderr: merge.stderr,
    };
  }

  const conflictedFiles = await listConflictedFiles(args.repoPath);
  if (conflictedFiles.length === 0) {
    return {
      ok: false,
      conflictedFiles: [],
      merged: false,
      stdout: merge.stdout,
      stderr: merge.stderr,
      error: merge.stderr || merge.stdout || `Merge failed for ${args.branch}`,
    };
  }

  const resolutions = resolvePolicies(conflictedFiles, args.autoResolvePolicies ?? []);
  if (resolutions === null) {
    return {
      ok: false,
      conflictedFiles,
      merged: false,
      stdout: merge.stdout,
      stderr: merge.stderr,
      error: "Merge has conflicts that are not covered by auto-resolve policies.",
    };
  }

  for (const resolution of resolutions) {
    await git(
      args.repoPath,
      ["checkout", `--${resolution.choose}`, "--", resolution.file],
      `Unable to auto-resolve ${resolution.file}`,
    );
    await git(args.repoPath, ["add", "--", resolution.file], `Unable to stage ${resolution.file}`);
  }

  await commitMerge(args.repoPath, `AWO merge ${args.branch}`);
  return {
    ok: true,
    conflictedFiles,
    merged: true,
    stdout: merge.stdout,
    stderr: merge.stderr,
  };
}

async function git(
  cwd: string,
  args: string[],
  failureMessage: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execa("git", args, { cwd });
  } catch (error) {
    throw new Error(`${failureMessage}: ${errorMessage(error)}`);
  }
}

async function commitMerge(repoPath: string, message: string): Promise<void> {
  await git(
    repoPath,
    [
      "-c",
      "user.name=AWO Bot",
      "-c",
      "user.email=awo@example.local",
      "commit",
      "-m",
      message,
    ],
    "Unable to commit merge result",
  );
}

async function getWorktreePathState(
  worktreePath: string,
): Promise<"missing" | "empty" | "non-empty" | "git-worktree"> {
  try {
    const worktreeStat = await stat(worktreePath);
    if (!worktreeStat.isDirectory()) {
      return "non-empty";
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return "missing";
    }
    throw error;
  }

  const repoCheck = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: worktreePath,
    reject: false,
  });
  if (repoCheck.exitCode === 0 && repoCheck.stdout.trim() === "true") {
    return "git-worktree";
  }

  const entries = await readdir(worktreePath);
  return entries.length === 0 ? "empty" : "non-empty";
}

function resolvePolicies(
  files: string[],
  policies: AutoResolvePolicy[],
): Array<{ file: string; choose: "ours" | "theirs" }> | null {
  const resolutions = files.map((file) => {
    const normalizedFile = normalizeGitPath(file);
    const policy = policies.find((candidate) => globMatches(candidate.pattern, normalizedFile));
    return policy === undefined ? null : { file, choose: policy.choose };
  });

  if (resolutions.some((resolution) => resolution === null)) {
    return null;
  }

  return resolutions as Array<{ file: string; choose: "ours" | "theirs" }>;
}

function globMatches(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizeGitPath(pattern);
  if (!/[?*]/.test(normalizedPattern)) {
    return normalizedPattern === filePath;
  }

  return globToRegExp(normalizedPattern).test(filePath);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char ?? "");
    }
  }
  source += "$";
  return new RegExp(source);
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  if (isExecaError(error)) {
    return error.shortMessage ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isExecaError(error: unknown): error is ExecaError {
  return typeof error === "object" && error !== null && "shortMessage" in error;
}
