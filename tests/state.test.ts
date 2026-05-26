import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadPlan } from "../src/plan.js";
import {
  ensureAwoDirs,
  getAwoDir,
  getLogsDir,
  getPromptsDir,
  initializeState,
  loadState,
  saveState,
  updateBatchStatus,
  updatePartStatus,
} from "../src/state.js";
import type { LoadedPlan, RunState } from "../src/types.js";

describe("state storage", () => {
  it("ensureAwoDirs creates .awo, logs, and prompts", async () => {
    const repoPath = await tempRepo();

    await ensureAwoDirs(repoPath);

    await expectDirectory(getAwoDir(repoPath));
    await expectDirectory(getLogsDir(repoPath));
    await expectDirectory(getPromptsDir(repoPath));
  });

  it("saveState then loadState round trips", async () => {
    const repoPath = await tempRepo();
    const state = makeState(repoPath);

    await saveState(repoPath, state);
    const loadedState = await loadState(repoPath);

    expect(loadedState).toEqual(state);
  });

  it("loadState returns null if no state exists", async () => {
    const repoPath = await tempRepo();

    await expect(loadState(repoPath)).resolves.toBeNull();
  });

  it("initializeState persists a state with pending batch and part statuses", async () => {
    const repoPath = await tempRepo();
    const loadedPlan = await sampleLoadedPlan();

    const state = await initializeState({ repoPath, loadedPlan, runId: "test-run" });
    const persistedState = await loadState(repoPath);

    expect(state.status).toBe("idle");
    expect(state.currentBatchIndex).toBe(0);
    expect(state.batches[0]?.status).toBe("pending");
    expect(state.batches[0]?.parts[0]?.status).toBe("pending");
    expect(persistedState).toEqual(state);
  });

  it("initializeState sets promptPath and logPath for parts", async () => {
    const repoPath = await tempRepo();
    const loadedPlan = await sampleLoadedPlan();

    const state = await initializeState({ repoPath, loadedPlan, runId: "test-run" });
    const part = state.batches[0]?.parts[0];

    expect(part?.promptPath).toBe(path.join(getPromptsDir(repoPath), "alpha.md"));
    expect(part?.logPath).toBe(path.join(getLogsDir(repoPath), "alpha.log"));
  });

  it("updatePartStatus updates and persists a part", async () => {
    const repoPath = await tempRepo();
    await saveState(repoPath, makeState(repoPath));

    const updatedState = await updatePartStatus({
      repoPath,
      batchId: "batch-1",
      partId: "alpha",
      status: "running",
      updates: { branch: "awo/alpha" },
    });
    const persistedState = await loadState(repoPath);

    expect(updatedState.batches[0]?.parts[0]?.status).toBe("running");
    expect(updatedState.batches[0]?.parts[0]?.branch).toBe("awo/alpha");
    expect(persistedState).toEqual(updatedState);
  });

  it("updateBatchStatus updates and persists a batch", async () => {
    const repoPath = await tempRepo();
    await saveState(repoPath, makeState(repoPath));

    const updatedState = await updateBatchStatus({
      repoPath,
      batchId: "batch-1",
      status: "running",
      updates: { startedAt: "2026-05-26T12:00:00.000Z" },
    });
    const persistedState = await loadState(repoPath);

    expect(updatedState.batches[0]?.status).toBe("running");
    expect(updatedState.batches[0]?.startedAt).toBe("2026-05-26T12:00:00.000Z");
    expect(persistedState).toEqual(updatedState);
  });
});

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "awo-state-"));
}

async function expectDirectory(dirPath: string): Promise<void> {
  const dirStat = await stat(dirPath);
  expect(dirStat.isDirectory()).toBe(true);
}

function makeState(repoPath: string): RunState {
  return {
    runId: "test-run",
    planHash: "abc123",
    repoPath,
    baseBranch: "main",
    currentBatchIndex: 0,
    status: "idle",
    startedAt: "2026-05-26T12:00:00.000Z",
    updatedAt: "2026-05-26T12:00:00.000Z",
    batches: [
      {
        id: "batch-1",
        status: "pending",
        parts: [
          {
            id: "alpha",
            status: "pending",
            promptPath: path.join(getPromptsDir(repoPath), "alpha.md"),
            logPath: path.join(getLogsDir(repoPath), "alpha.log"),
          },
        ],
      },
    ],
  };
}

async function sampleLoadedPlan(): Promise<LoadedPlan> {
  const planPath = path.resolve("examples", "plan.yaml");
  return loadPlan(planPath);
}
