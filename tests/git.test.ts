import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import {
  autoCommitIfDirty,
  createWorktree,
  getCurrentSha,
  hasCommitsAhead,
  runTestCommand,
  verifyGitRepo,
} from "../src/git.js";

describe("git adapter", () => {
  it("verifies repo, creates worktree, commits changes, and detects commits ahead", async () => {
    const { repoPath, root } = await makeGitRepo();
    const baseSha = await getCurrentSha(repoPath, "HEAD");
    const worktreePath = path.join(root, "worktree-alpha");
    const branch = "awo/alpha";

    await expect(verifyGitRepo(repoPath)).resolves.toBeUndefined();
    expect(baseSha).toMatch(/^[a-f0-9]{40}$/);

    await createWorktree({ repoPath, worktreePath, branch, baseRef: baseSha });
    await writeFile(path.join(worktreePath, "alpha.txt"), "alpha\n", "utf8");

    await expect(autoCommitIfDirty(worktreePath, "Add alpha")).resolves.toBe(true);
    await expect(hasCommitsAhead(repoPath, baseSha, branch)).resolves.toBe(true);
  }, 30_000);

  it("runTestCommand returns ok true for a passing command", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "awo-git-cmd-"));
    const result = await runTestCommand(cwd, `${quote(process.execPath)} -e "process.exit(0)"`);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("runTestCommand returns ok false for a failing command", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "awo-git-cmd-"));
    const result = await runTestCommand(cwd, `${quote(process.execPath)} -e "process.exit(5)"`);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(5);
  });
});

async function makeGitRepo(): Promise<{ root: string; repoPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "awo-git-"));
  const repoPath = path.join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await execa("git", ["init"], { cwd: repoPath });
  await execa("git", ["config", "user.email", "test@example.local"], { cwd: repoPath });
  await execa("git", ["config", "user.name", "Test User"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "# Test\n", "utf8");
  await execa("git", ["add", "README.md"], { cwd: repoPath });
  await execa("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });
  return { root, repoPath };
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
