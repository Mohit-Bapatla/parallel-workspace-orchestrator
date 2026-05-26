import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createAgentRunner } from "./agent.js";
import {
  autoCommitIfDirty,
  branchExists,
  createWorktree,
  ensureCleanWorkingTree,
  getCurrentSha,
  hasCommitsAhead,
  mergeBranch,
  runTestCommand,
  verifyGitRepo,
} from "./git.js";
import { loadPlan, validatePlan } from "./plan.js";
import { getLogsDir, getPromptsDir, initializeState, loadState, saveState } from "./state.js";
import type { AgentType, BatchRunState, PartRunState, Plan, PlanBatch, PlanPart, RunState } from "./types.js";

export async function runOrchestration(args: {
  planPath: string;
  repoPath: string;
  agentOverride?: AgentType;
  agentCommand?: string;
  strict?: boolean;
  newRun?: boolean;
  timeoutMinutes?: number;
  maxTurns?: number;
  claudeSkipPermissions?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(args.repoPath);
  const planPath = path.resolve(args.planPath);
  const loadedPlan = await loadPlan(planPath);
  const plan = loadedPlan.plan;
  const validation = validatePlan(plan, { strict: args.strict === true });

  console.log(`Loaded plan: ${plan.name ?? "(unnamed)"}`);
  console.log(`Plan hash: ${loadedPlan.planHash}`);

  if (validation.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of validation.warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (!validation.valid) {
    for (const error of validation.errors) {
      console.error(`- ${error}`);
    }
    throw new Error("Plan validation failed.");
  }

  validateSanitizedPartIds(plan);

  await verifyGitRepo(repoPath);
  try {
    await ensureCleanWorkingTree(repoPath);
  } catch (error) {
    throw new Error(
      `${errorMessage(error)}\nIf the repository is dirty because of a previous merge conflict, resolve or abort it and rerun this command.`,
    );
  }

  const agentType = args.agentOverride ?? plan.agent.type;
  const timeoutMinutes = args.timeoutMinutes ?? plan.agent.timeout_minutes;
  const timeoutMs = timeoutMinutes * 60_000;
  const maxTurns = args.maxTurns ?? plan.agent.max_turns;
  const agentCommand = args.agentCommand ?? plan.agent.command;
  const runnerOptions: { command?: string; maxTurns?: number; claudeSkipPermissions?: boolean } = {};
  if (agentCommand !== undefined) {
    runnerOptions.command = agentCommand;
  }
  if (maxTurns !== undefined) {
    runnerOptions.maxTurns = maxTurns;
  }
  if (args.claudeSkipPermissions === true) {
    runnerOptions.claudeSkipPermissions = true;
  }
  const runner = createAgentRunner(agentType, runnerOptions);

  console.log(`Selected agent: ${agentType}`);

  let state = await prepareState({
    repoPath,
    loadedPlan,
    newRun: args.newRun === true,
  });
  if (state.status === "completed") {
    console.log(`Run ${state.runId} is already completed.`);
    return;
  }

  let mutationQueue = Promise.resolve();
  const mutateState = async (mutator: (draft: RunState) => void): Promise<RunState> => {
    let updatedState: RunState | undefined;
    mutationQueue = mutationQueue.then(async () => {
      mutator(state);
      state.updatedAt = new Date().toISOString();
      await saveState(repoPath, state);
      updatedState = state;
    });
    await mutationQueue;
    return updatedState ?? state;
  };

  await mutateState((draft) => {
    draft.status = "running";
  });

  console.log(`Run id: ${state.runId}`);

  for (const [batchIndex, batch] of plan.batches.entries()) {
    const batchState = getBatchState(state, batch.id);
    if (batchState.status === "completed") {
      console.log(`Skipping completed batch: ${batch.id}`);
      continue;
    }

    const runBatchArgs: RunBatchArgs = {
      repoPath,
      loadedPlanRawText: loadedPlan.rawText,
      plan,
      batch,
      batchIndex,
      state,
      mutateState,
      runner,
      timeoutMs,
    };
    if (agentCommand !== undefined) {
      runBatchArgs.agentCommand = agentCommand;
    }
    if (maxTurns !== undefined) {
      runBatchArgs.maxTurns = maxTurns;
    }
    await runBatch(runBatchArgs);
  }

  await mutateState((draft) => {
    draft.status = "completed";
    draft.currentBatchIndex = plan.batches.length;
    delete draft.currentBaseSha;
  });

  console.log(`Run completed: ${state.runId}`);
}

async function prepareState(args: {
  repoPath: string;
  loadedPlan: Awaited<ReturnType<typeof loadPlan>>;
  newRun: boolean;
}): Promise<RunState> {
  if (args.newRun) {
    return initializeState({ repoPath: args.repoPath, loadedPlan: args.loadedPlan });
  }

  const existingState = await loadState(args.repoPath);
  if (existingState === null) {
    return initializeState({ repoPath: args.repoPath, loadedPlan: args.loadedPlan });
  }

  if (existingState.planHash !== args.loadedPlan.planHash) {
    throw new Error("Existing AWO state was created from a different plan. Use --new-run to start fresh.");
  }

  return existingState;
}

interface RunBatchArgs {
  repoPath: string;
  loadedPlanRawText: string;
  plan: Plan;
  batch: PlanBatch;
  batchIndex: number;
  state: RunState;
  mutateState: (mutator: (draft: RunState) => void) => Promise<RunState>;
  runner: ReturnType<typeof createAgentRunner>;
  agentCommand?: string;
  timeoutMs: number;
  maxTurns?: number;
}

async function runBatch(args: RunBatchArgs): Promise<void> {
  const batchState = getBatchState(args.state, args.batch.id);
  const batchBaseSha =
    args.state.currentBatchIndex === args.batchIndex &&
    args.state.currentBaseSha !== undefined &&
    batchState.status !== "pending" &&
    batchState.status !== "completed"
      ? args.state.currentBaseSha
      : await getCurrentSha(args.repoPath, args.plan.base_branch);

  console.log(`Starting batch: ${args.batch.id}`);
  await args.mutateState((draft) => {
    draft.currentBatchIndex = args.batchIndex;
    draft.currentBaseSha = batchBaseSha;
    const draftBatch = getBatchState(draft, args.batch.id);
    draftBatch.status = "running";
    draftBatch.startedAt ??= new Date().toISOString();
    delete draftBatch.finishedAt;
  });

  const runnableParts: PlanPart[] = [];
  for (const part of args.batch.parts) {
    const partState = getPartState(getBatchState(args.state, args.batch.id), part.id);
    const branch = partState.branch;
    if (partState.status === "merged" || partState.status === "completed") {
      continue;
    }

    if (
      partState.status === "running" &&
      branch !== undefined &&
      (await branchExists(args.repoPath, branch)) &&
      (await hasCommitsAhead(args.repoPath, batchBaseSha, branch))
    ) {
      console.log(`Recovering completed part from existing branch: ${part.id}`);
      await args.mutateState((draft) => {
        const draftPart = getPartState(getBatchState(draft, args.batch.id), part.id);
        draftPart.status = "completed";
        draftPart.finishedAt = new Date().toISOString();
      });
      continue;
    }

    const paths = buildPartPaths(args.repoPath, args.state.runId, part.id);
    await createWorktree({
      repoPath: args.repoPath,
      worktreePath: paths.worktreePath,
      branch: paths.branch,
      baseRef: batchBaseSha,
    });
    await writePromptFiles({
      promptPath: paths.promptPath,
      worktreePromptPath: path.join(paths.worktreePath, ".awo-task.md"),
      planText: args.loadedPlanRawText,
      batch: args.batch,
      part,
    });

    console.log(`Worktree ready: ${part.id} -> ${paths.worktreePath}`);
    await args.mutateState((draft) => {
      const draftPart = getPartState(getBatchState(draft, args.batch.id), part.id);
      draftPart.branch = paths.branch;
      draftPart.worktreePath = paths.worktreePath;
      draftPart.promptPath = paths.promptPath;
      draftPart.logPath = paths.logPath;
      draftPart.status = "worktree_created";
      delete draftPart.error;
      delete draftPart.finishedAt;
    });
    runnableParts.push(part);
  }

  const results = await Promise.allSettled(
    runnableParts.map((part) =>
      runPart(
        withOptionalFields(
          {
            repoPath: args.repoPath,
            plan: args.plan,
            batch: args.batch,
            part,
            batchBaseSha,
            state: args.state,
            mutateState: args.mutateState,
            runner: args.runner,
            fullPlanText: args.loadedPlanRawText,
            timeoutMs: args.timeoutMs,
          },
          {
            agentCommand: args.agentCommand,
            maxTurns: args.maxTurns,
          },
        ),
      ),
    ),
  );

  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }

  if (!allPartsCompletedOrMerged(getBatchState(args.state, args.batch.id))) {
    throw new Error(`Batch ${args.batch.id} did not complete all parts.`);
  }

  await mergeBatch(args.repoPath, args.plan, args.batch, args.state, args.mutateState);
}

async function runPart(args: {
  repoPath: string;
  plan: Plan;
  batch: PlanBatch;
  part: PlanPart;
  batchBaseSha: string;
  state: RunState;
  mutateState: (mutator: (draft: RunState) => void) => Promise<RunState>;
  runner: ReturnType<typeof createAgentRunner>;
  agentCommand?: string;
  fullPlanText: string;
  timeoutMs: number;
  maxTurns?: number;
}): Promise<void> {
  const partState = getPartState(getBatchState(args.state, args.batch.id), args.part.id);
  if (partState.branch === undefined || partState.worktreePath === undefined) {
    throw new Error(`Part ${args.part.id} is missing worktree state.`);
  }

  const logPath = partState.logPath ?? buildPartPaths(args.repoPath, args.state.runId, args.part.id).logPath;
  const promptPath =
    partState.promptPath ?? buildPartPaths(args.repoPath, args.state.runId, args.part.id).promptPath;
  const doneMarkerPath = path.join(partState.worktreePath, ".awo-done");

  console.log(`Running part: ${args.batch.id}/${args.part.id}`);
  await args.mutateState((draft) => {
    const draftPart = getPartState(getBatchState(draft, args.batch.id), args.part.id);
    draftPart.status = "running";
    draftPart.startedAt = new Date().toISOString();
    delete draftPart.error;
  });

  const result = await args.runner.run(
    withOptionalFields(
      {
        repoPath: args.repoPath,
        worktreePath: partState.worktreePath,
        part: args.part,
        batch: args.batch,
        fullPlanText: args.fullPlanText,
        promptPath,
        logPath,
        doneMarkerPath,
        timeoutMs: args.timeoutMs,
      },
      {
        command: args.agentCommand,
        maxTurns: args.maxTurns,
      },
    ),
  );

  if (!result.ok) {
    await haltPart(args.mutateState, args.batch.id, args.part.id, "failed", result.error ?? "Agent failed.");
    throw new Error(
      haltMessage({
        reason: `Agent failed for part ${args.part.id}: ${result.error ?? "unknown error"}`,
        repoPath: args.repoPath,
        batchId: args.batch.id,
        partId: args.part.id,
        logPath,
      }),
    );
  }

  await cleanupRuntimeFiles(partState.worktreePath, doneMarkerPath);
  await autoCommitIfDirty(partState.worktreePath, `part(${args.part.id}): automated changes`);
  if (!(await hasCommitsAhead(args.repoPath, args.batchBaseSha, partState.branch))) {
    const message = `Part ${args.part.id} produced no commits ahead of ${args.batchBaseSha}.`;
    await haltPart(args.mutateState, args.batch.id, args.part.id, "failed", message);
    throw new Error(haltMessage({ reason: message, repoPath: args.repoPath, batchId: args.batch.id, partId: args.part.id, logPath }));
  }

  if (args.plan.tests?.per_part !== undefined) {
    console.log(`Running per-part tests: ${args.part.id}`);
    const testResult = await runTestCommand(partState.worktreePath, args.plan.tests.per_part);
    if (!testResult.ok) {
      const message = [
        `Per-part tests failed for ${args.part.id}.`,
        testResult.stdout,
        testResult.stderr,
      ]
        .filter((value) => value.length > 0)
        .join("\n");
      await haltPart(args.mutateState, args.batch.id, args.part.id, "tests_failed", message);
      throw new Error(haltMessage({ reason: message, repoPath: args.repoPath, batchId: args.batch.id, partId: args.part.id, logPath }));
    }
  }

  console.log(`Part completed: ${args.part.id}`);
  await args.mutateState((draft) => {
    const draftPart = getPartState(getBatchState(draft, args.batch.id), args.part.id);
    draftPart.status = "completed";
    draftPart.finishedAt = new Date().toISOString();
    delete draftPart.error;
  });
}

async function mergeBatch(
  repoPath: string,
  plan: Plan,
  batch: PlanBatch,
  state: RunState,
  mutateState: (mutator: (draft: RunState) => void) => Promise<RunState>,
): Promise<void> {
  console.log(`Merging batch: ${batch.id}`);
  await mutateState((draft) => {
    getBatchState(draft, batch.id).status = "merging";
  });

  for (const part of batch.parts) {
    const partState = getPartState(getBatchState(state, batch.id), part.id);
    if (partState.status === "merged") {
      continue;
    }
    if (partState.branch === undefined) {
      throw new Error(`Part ${part.id} has no branch to merge.`);
    }

    console.log(`Merging branch: ${partState.branch}`);
    const mergeResult = await mergeBranch(
      withOptionalFields(
        {
          repoPath,
          baseBranch: plan.base_branch,
          branch: partState.branch,
          strategy: plan.merge.strategy,
        },
        {
          autoResolvePolicies: plan.merge.auto_resolve,
        },
      ),
    );

    if (!mergeResult.ok) {
      const reason = `Merge failed for ${part.id}: ${mergeResult.error ?? "unknown error"}${
        mergeResult.conflictedFiles.length > 0
          ? `\nConflicted files: ${mergeResult.conflictedFiles.join(", ")}`
          : ""
      }`;
      await haltPart(mutateState, batch.id, part.id, "merge_conflict", reason);
      throw new Error(
        haltMessage(
          withOptionalFields(
            { reason, repoPath, batchId: batch.id, partId: part.id },
            { logPath: partState.logPath },
          ),
        ),
      );
    }

    await mutateState((draft) => {
      const draftPart = getPartState(getBatchState(draft, batch.id), part.id);
      draftPart.status = "merged";
      draftPart.finishedAt = new Date().toISOString();
      delete draftPart.error;
    });
  }

  if (plan.tests?.post_merge !== undefined) {
    console.log(`Running post-merge tests for batch: ${batch.id}`);
    const testResult = await runTestCommand(repoPath, plan.tests.post_merge);
    if (!testResult.ok) {
      const reason = ["Post-merge tests failed.", testResult.stdout, testResult.stderr]
        .filter((value) => value.length > 0)
        .join("\n");
      await mutateState((draft) => {
        const draftBatch = getBatchState(draft, batch.id);
        draftBatch.status = "failed";
        draft.status = "halted";
      });
      throw new Error(haltMessage({ reason, repoPath, batchId: batch.id }));
    }
  }

  console.log(`Batch completed: ${batch.id}`);
  await mutateState((draft) => {
    const draftBatch = getBatchState(draft, batch.id);
    draftBatch.status = "completed";
    draftBatch.finishedAt = new Date().toISOString();
    draft.currentBatchIndex += 1;
    delete draft.currentBaseSha;
  });
}

async function haltPart(
  mutateState: (mutator: (draft: RunState) => void) => Promise<RunState>,
  batchId: string,
  partId: string,
  status: PartRunState["status"],
  error: string,
): Promise<void> {
  await mutateState((draft) => {
    const batch = getBatchState(draft, batchId);
    const part = getPartState(batch, partId);
    part.status = status;
    part.error = error;
    part.finishedAt = new Date().toISOString();
    batch.status = "failed";
    draft.status = "halted";
  });
}

function buildPartPaths(repoPath: string, runId: string, partId: string): {
  safePartId: string;
  branch: string;
  worktreePath: string;
  promptPath: string;
  logPath: string;
} {
  const safePartId = sanitizeId(partId);
  const repoParent = path.dirname(repoPath);
  const repoName = path.basename(repoPath);
  return {
    safePartId,
    branch: `awo/${runId}/${safePartId}`,
    worktreePath: path.join(repoParent, ".awo-worktrees", repoName, runId, safePartId),
    promptPath: path.join(getPromptsDir(repoPath), `${safePartId}.md`),
    logPath: path.join(getLogsDir(repoPath), `${safePartId}.log`),
  };
}

export function sanitizeId(id: string): string {
  const sanitized = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized : "part";
}

function validateSanitizedPartIds(plan: Plan): void {
  const seen = new Map<string, string>();
  for (const batch of plan.batches) {
    for (const part of batch.parts) {
      const safeId = sanitizeId(part.id);
      const existing = seen.get(safeId);
      if (existing !== undefined) {
        throw new Error(`Part ids "${existing}" and "${part.id}" both sanitize to "${safeId}".`);
      }
      seen.set(safeId, part.id);
    }
  }
}

async function writePromptFiles(args: {
  promptPath: string;
  worktreePromptPath: string;
  planText: string;
  batch: PlanBatch;
  part: PlanPart;
}): Promise<void> {
  const prompt = renderPrompt(args.batch, args.part, args.planText);
  await mkdir(path.dirname(args.promptPath), { recursive: true });
  await mkdir(path.dirname(args.worktreePromptPath), { recursive: true });
  await writeFile(args.promptPath, prompt, "utf8");
  await writeFile(args.worktreePromptPath, prompt, "utf8");
}

async function cleanupRuntimeFiles(worktreePath: string, doneMarkerPath: string): Promise<void> {
  await rm(path.join(worktreePath, ".awo-task.md"), { force: true });
  await rm(doneMarkerPath, { force: true });
}

function renderPrompt(batch: PlanBatch, part: PlanPart, planText: string): string {
  const fileScope = part.files?.length ? part.files.map((file) => `- ${file}`).join("\n") : "- (not specified)";
  const acceptance = part.acceptance?.length
    ? part.acceptance.map((item) => `- ${item}`).join("\n")
    : "- (not specified)";

  return [
    "# Automated Workspace Task",
    "",
    `Batch ID: ${batch.id}`,
    `Part ID: ${part.id}`,
    part.title === undefined ? "" : `Part title: ${part.title}`,
    "",
    "## File Scope",
    fileScope,
    "",
    "## Task Brief",
    part.brief,
    "",
    "## Context",
    part.context ?? "(not specified)",
    "",
    "## Acceptance Criteria",
    acceptance,
    "",
    "## Instructions",
    "- You are in an isolated git worktree.",
    "- Only modify files necessary for this part.",
    "- Do not inspect or depend on sibling worktrees.",
    "- The orchestrator will run tests, commit, and merge.",
    "- Leave the worktree in a working state.",
    "",
    "## Full Plan",
    "```yaml",
    planText.trimEnd(),
    "```",
    "",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

function getBatchState(state: RunState, batchId: string): BatchRunState {
  const batch = state.batches.find((candidate) => candidate.id === batchId);
  if (batch === undefined) {
    throw new Error(`Batch "${batchId}" not found in state.`);
  }
  return batch;
}

function getPartState(batch: BatchRunState, partId: string): PartRunState {
  const part = batch.parts.find((candidate) => candidate.id === partId);
  if (part === undefined) {
    throw new Error(`Part "${partId}" not found in batch "${batch.id}".`);
  }
  return part;
}

function allPartsCompletedOrMerged(batch: BatchRunState): boolean {
  return batch.parts.every((part) => part.status === "completed" || part.status === "merged");
}

function haltMessage(args: {
  reason: string;
  repoPath: string;
  batchId?: string;
  partId?: string;
  logPath?: string;
}): string {
  return [
    `AWO halted: ${args.reason}`,
    args.batchId === undefined ? "" : `Batch: ${args.batchId}`,
    args.partId === undefined ? "" : `Part: ${args.partId}`,
    args.logPath === undefined ? "" : `Log: ${args.logPath}`,
    `State: ${path.join(args.repoPath, ".awo", "state.json")}`,
    "After fixing the issue, rerun the same command to resume.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

type DefinedOptional<T extends Record<string, unknown>> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

function withOptionalFields<T extends object, U extends Record<string, unknown>>(
  base: T,
  optional: U,
): T & DefinedOptional<U> {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T & DefinedOptional<U>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
