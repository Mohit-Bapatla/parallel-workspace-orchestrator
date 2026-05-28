import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";

import { runConductorMergeWatch } from "../src/conductor-merge.js";
import { createWorktree, isBranchMerged } from "../src/git.js";

describe("conductor merge watcher", () => {
  it("auto-merges ready marker branches and completes the batch", async () => {
    const fixture = await makeFixture();
    await createCompletedPart(fixture, "alpha");
    await createCompletedPart(fixture, "beta");

    await runConductorMergeWatch({
      planPath: fixture.planPath,
      repoPath: fixture.repoPath,
      batchId: "batch-1",
      once: true,
      autoMerge: true,
    });

    const state = await readMergeState(fixture.repoPath);
    const batch = state.batches.find((candidate) => candidate.id === "batch-1");
    expect(batch?.status).toBe("completed");
    expect(batch?.parts.map((part: { status: string }) => part.status)).toEqual(["merged", "merged"]);
    await expect(readFile(path.join(fixture.repoPath, "docs", "generated", "alpha.md"), "utf8")).resolves.toContain("alpha");
    await expect(readFile(path.join(fixture.repoPath, "docs", "generated", "beta.md"), "utf8")).resolves.toContain("beta");
  }, 30_000);

  it("keeps a committed branch without a marker running when auto-merge is off", async () => {
    const fixture = await makeFixture();
    await createCompletedPart(fixture, "alpha", { markerStatus: "none" });

    await runConductorMergeWatch({
      planPath: fixture.planPath,
      repoPath: fixture.repoPath,
      batchId: "batch-1",
      once: true,
    });

    const state = await readMergeState(fixture.repoPath);
    const alpha = findPart(state, "batch-1", "alpha");
    expect(alpha.status).toBe("running");
  }, 30_000);

  it("detects ready markers in worktrees whose branch names do not include the part id", async () => {
    const fixture = await makeFixture();
    const branch = "conductor/workspace-7429";
    const worktreeName = "workspace-7429";
    await createCompletedPart(fixture, "alpha", { branch, worktreeName });

    await runConductorMergeWatch({
      planPath: fixture.planPath,
      repoPath: fixture.repoPath,
      batchId: "batch-1",
      once: true,
      humanGate: false,
    });

    const state = await readMergeState(fixture.repoPath);
    const alpha = findPart(state, "batch-1", "alpha");
    expect(alpha.status).toBe("ready");
    expect(alpha.branch).toBe(branch);
    const actualWorktreeReal = await fs.realpath(alpha.worktreePath);
    const expectedWorktreeReal = await fs.realpath(path.join(fixture.worktreeRoot, worktreeName));
    expect(actualWorktreeReal).toBe(expectedWorktreeReal);
    const actualMarkerReal = await fs.realpath(alpha.markerPath);
    const expectedMarkerReal = await fs.realpath(path.join(fixture.worktreeRoot, worktreeName, ".awo", "completed", "alpha.json"));
    expect(actualMarkerReal).toBe(expectedMarkerReal);
  }, 30_000);

  it("detects ready markers in an external Conductor workspaces root", async () => {
    const fixture = await makeFixture();
    const branch = "conductor/workspace-7429";
    await createCompletedPart(fixture, "alpha", { branch, markerStatus: "none" });
    const conductorWorkspacesRoot = path.join(fixture.root, "conductor", "workspaces");
    const workspacePath = path.join(conductorWorkspacesRoot, "workspace-7429");
    await mkdir(workspacePath, { recursive: true });
    await execa("git", ["init", "-b", branch], { cwd: workspacePath });
    await execa("git", ["config", "user.email", "test@example.local"], { cwd: workspacePath });
    await execa("git", ["config", "user.name", "Test User"], { cwd: workspacePath });
    await writeFile(path.join(workspacePath, "README.md"), "# External workspace\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: workspacePath });
    await execa("git", ["commit", "-m", "Initial external workspace commit"], { cwd: workspacePath });
    const markerDir = path.join(workspacePath, ".awo", "completed");
    await mkdir(markerDir, { recursive: true });
    await writeFile(path.join(markerDir, "alpha.json"), JSON.stringify({
      partId: "alpha",
      batchId: "batch-1",
      status: "ready_for_merge",
      summary: "alpha ready_for_merge",
      testsRun: [],
      notes: "Ready.",
    }, null, 2), "utf8");

    await runConductorMergeWatch({
      planPath: fixture.planPath,
      repoPath: fixture.repoPath,
      batchId: "batch-1",
      once: true,
      humanGate: false,
      conductorWorkspacesRoot,
    });

    const state = await readMergeState(fixture.repoPath);
    const alpha = findPart(state, "batch-1", "alpha");
    expect(alpha.status).toBe("ready");
    expect(alpha.branch).toBe(branch);
    const actualWorktreeReal = await fs.realpath(alpha.worktreePath);
    const expectedWorktreeReal = await fs.realpath(workspacePath);
    expect(actualWorktreeReal).toBe(expectedWorktreeReal);
    const actualMarkerReal = await fs.realpath(alpha.markerPath);
    const expectedMarkerReal = await fs.realpath(path.join(workspacePath, ".awo", "completed", "alpha.json"));
    expect(actualMarkerReal).toBe(expectedMarkerReal);
  }, 30_000);

  it("does not merge blocked marker branches", async () => {
    const fixture = await makeFixture();
    await createCompletedPart(fixture, "alpha", { markerStatus: "blocked" });

    await runConductorMergeWatch({
      planPath: fixture.planPath,
      repoPath: fixture.repoPath,
      batchId: "batch-1",
      once: true,
      autoMerge: true,
    });

    const state = await readMergeState(fixture.repoPath);
    const alpha = findPart(state, "batch-1", "alpha");
    expect(alpha.status).toBe("blocked");
    await expect(isBranchMerged(fixture.repoPath, "main", "conductor/alpha")).resolves.toBe(false);
  }, 30_000);

  it("dry-run reports merge and push commands without changing main", async () => {
    const fixture = await makeFixture();
    await createCompletedPart(fixture, "alpha");
    await createCompletedPart(fixture, "beta");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await runConductorMergeWatch({
        planPath: fixture.planPath,
        repoPath: fixture.repoPath,
        batchId: "batch-1",
        once: true,
        autoMerge: true,
        push: true,
        dryRun: true,
      });
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("[dry-run] git merge conductor/alpha");
      expect(output).toContain("[dry-run] git push origin main");
    } finally {
      logSpy.mockRestore();
    }

    await expect(isBranchMerged(fixture.repoPath, "main", "conductor/alpha")).resolves.toBe(false);
  }, 30_000);
});

interface Fixture {
  root: string;
  repoPath: string;
  planPath: string;
  worktreeRoot: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "awo-conductor-merge-"));
  const repoPath = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  await mkdir(repoPath, { recursive: true });
  await execa("git", ["init", "-b", "main"], { cwd: repoPath });
  await execa("git", ["config", "user.email", "test@example.local"], { cwd: repoPath });
  await execa("git", ["config", "user.name", "Test User"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "# Sample\n", "utf8");
  await execa("git", ["add", "README.md"], { cwd: repoPath });
  await execa("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });

  const planPath = path.join(root, "plan.yaml");
  await writeFile(planPath, [
    "version: 1",
    "name: conductor-merge-test",
    "base_branch: main",
    "merge:",
    "  strategy: no-ff",
    "  auto_resolve: []",
    "batches:",
    "  - id: batch-1",
    "    parts:",
    "      - id: alpha",
    "        files:",
    "          - docs/generated/alpha.md",
    "        brief: Create alpha docs.",
    "      - id: beta",
    "        files:",
    "          - docs/generated/beta.md",
    "        brief: Create beta docs.",
  ].join("\n"), "utf8");

  return { root, repoPath, planPath, worktreeRoot };
}

async function createCompletedPart(
  fixture: Fixture,
  partId: "alpha" | "beta",
  options: { branch?: string; markerStatus?: "ready_for_merge" | "blocked" | "none"; worktreeName?: string } = {},
): Promise<void> {
  const branch = options.branch ?? `conductor/${partId}`;
  const worktreePath = path.join(fixture.worktreeRoot, options.worktreeName ?? partId);
  await createWorktree({ repoPath: fixture.repoPath, worktreePath, branch, baseRef: "main" });
  const docsDir = path.join(worktreePath, "docs", "generated");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, `${partId}.md`), `# ${partId}\n`, "utf8");
  await execa("git", ["add", path.join("docs", "generated", `${partId}.md`)], { cwd: worktreePath });
  await execa("git", ["commit", "-m", `Add ${partId}`], { cwd: worktreePath });

  const markerStatus = options.markerStatus ?? "ready_for_merge";
  if (markerStatus === "none") {
    return;
  }

  const markerDir = path.join(worktreePath, ".awo", "completed");
  await mkdir(markerDir, { recursive: true });
  await writeFile(path.join(markerDir, `${partId}.json`), JSON.stringify({
    partId,
    batchId: "batch-1",
    status: markerStatus,
    summary: `${partId} ${markerStatus}`,
    testsRun: [],
    notes: markerStatus === "blocked" ? "Needs human help." : "Ready.",
  }, null, 2), "utf8");
}

async function readMergeState(repoPath: string): Promise<any> {
  return JSON.parse(await readFile(path.join(repoPath, ".awo", "conductor-merge-state.json"), "utf8"));
}

function findPart(state: any, batchId: string, partId: string): any {
  const batch = state.batches.find((candidate: { id: string }) => candidate.id === batchId);
  return batch.parts.find((candidate: { id: string }) => candidate.id === partId);
}
