import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { runOrchestration } from "../src/orchestrator.js";
import { loadState } from "../src/state.js";

describe("orchestrator", () => {
  it("runs dry-run batches through worktrees, commits, merges, and completes state", async () => {
    const { repoPath, planPath } = await makeRepoAndPlan();

    await runOrchestration({
      planPath,
      repoPath,
      agentOverride: "dry-run",
      newRun: true,
    });

    const state = await loadState(repoPath);
    const alpha = await readFile(path.join(repoPath, "docs", "generated", "alpha.md"), "utf8");
    const beta = await readFile(path.join(repoPath, "docs", "generated", "beta.md"), "utf8");
    const summary = await readFile(path.join(repoPath, "docs", "generated", "summary.md"), "utf8");

    expect(state?.status).toBe("completed");
    expect(state?.batches).toHaveLength(2);
    expect(state?.batches.flatMap((batch) => batch.parts).every((part) => part.status === "merged")).toBe(true);
    expect(alpha).toContain("Dry-run output for alpha");
    expect(beta).toContain("Dry-run output for beta");
    expect(summary).toContain("Dry-run output for summary");
  }, 30_000);
});

async function makeRepoAndPlan(): Promise<{ root: string; repoPath: string; planPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "awo-orchestrator-"));
  const repoPath = path.join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await execa("git", ["init"], { cwd: repoPath });
  await execa("git", ["checkout", "-b", "main"], { cwd: repoPath });
  await execa("git", ["config", "user.email", "test@example.local"], { cwd: repoPath });
  await execa("git", ["config", "user.name", "Test User"], { cwd: repoPath });

  await writeFile(
    path.join(repoPath, "package.json"),
    `${JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(repoPath, "README.md"), "# Test Repo\n", "utf8");
  await execa("git", ["add", "README.md", "package.json"], { cwd: repoPath });
  await execa("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });

  const planPath = path.join(root, "plan.yaml");
  await writeFile(
    planPath,
    `
version: 1
name: orchestrator-test
base_branch: main
agent:
  type: dry-run
  timeout_minutes: 1
tests:
  post_merge: npm test
merge:
  strategy: no-ff
batches:
  - id: batch-1
    parts:
      - id: alpha
        title: Alpha
        files:
          - docs/generated/alpha.md
        brief: Generate alpha output.
      - id: beta
        title: Beta
        files:
          - docs/generated/beta.md
        brief: Generate beta output.
  - id: batch-2
    parts:
      - id: summary
        title: Summary
        files:
          - docs/generated/summary.md
        brief: Generate summary output.
`.trimStart(),
    "utf8",
  );

  return { root, repoPath, planPath };
}
