import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  branchExists,
  gitPush,
  hasCommitsAhead,
  isBranchMerged,
  listBranches,
  listWorktrees,
  mergeBranch,
  runTestCommand,
  type GitWorktreeInfo,
} from "./git.js";
import { loadPlan, validatePlan } from "./plan.js";
import { getAwoDir } from "./state.js";
import type { LoadedPlan, Plan, PlanBatch, PlanPart } from "./types.js";

export type ConductorMergePartStatus =
  | "pending"
  | "running"
  | "ready"
  | "blocked"
  | "merged"
  | "merge_conflict"
  | "tests_failed";

export interface CompletionMarker {
  partId: string;
  batchId: string;
  status: "ready_for_merge" | "blocked";
  summary?: string;
  testsRun?: string[];
  notes?: string;
}

export interface ConductorMergePartState {
  id: string;
  status: ConductorMergePartStatus;
  branch?: string;
  worktreePath?: string;
  markerPath?: string;
  summary?: string;
  notes?: string;
  error?: string;
  lastCheckedAt?: string;
  mergedAt?: string;
  pushedAt?: string;
}

export interface ConductorMergeBatchState {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  parts: ConductorMergePartState[];
  lastCheckedAt?: string;
  completedAt?: string;
  pushedAt?: string;
}

export interface ConductorMergeState {
  planHash: string;
  repoPath: string;
  baseBranch: string;
  currentBatchId: string;
  batches: ConductorMergeBatchState[];
  lastCheckedAt?: string;
}

export interface ConductorMergeWatchArgs {
  planPath: string;
  repoPath: string;
  intervalMs?: number;
  once?: boolean;
  batchId?: string;
  humanGate?: boolean;
  autoMerge?: boolean;
  push?: boolean;
  remote?: string;
  baseBranch?: string;
  postMergeTest?: string;
  maxCycles?: number;
  dryRun?: boolean;
}

interface BranchCandidate {
  branch?: string;
  worktreePath?: string;
  marker?: CompletionMarker;
  markerPath?: string;
}

interface CycleContext {
  loadedPlan: LoadedPlan;
  plan: Plan;
  repoPath: string;
  planPath: string;
  baseBranch: string;
  batch: PlanBatch;
  state: ConductorMergeState;
  autoMerge: boolean;
  humanGate: boolean;
  push: boolean;
  remote: string;
  postMergeTest?: string;
  dryRun: boolean;
}

export async function runConductorMergeWatch(args: ConductorMergeWatchArgs): Promise<void> {
  const repoPath = path.resolve(args.repoPath);
  const planPath = path.resolve(args.planPath);
  const loadedPlan = await loadPlan(planPath);
  const validation = validatePlan(loadedPlan.plan);
  if (!validation.valid) {
    throw new Error(`Plan validation failed: ${validation.errors.join("; ")}`);
  }

  const baseBranch = args.baseBranch ?? loadedPlan.plan.base_branch;
  let state = await loadOrInitializeState(repoPath, loadedPlan, baseBranch);
  let stopped = false;
  process.once("SIGINT", () => {
    stopped = true;
    console.log("Stopping conductor merge watcher after current cycle.");
  });

  const maxCycles = args.maxCycles ?? (args.once === true ? 1 : undefined);
  let cycles = 0;

  while (!stopped) {
    cycles += 1;
    const batch = selectBatch(loadedPlan.plan, state, args.batchId);
    state.currentBatchId = batch.id;
    await saveMergeState(repoPath, state);

    state = await runMergeWatchCycle({
      loadedPlan,
      plan: loadedPlan.plan,
      repoPath,
      planPath,
      baseBranch,
      batch,
      state,
      autoMerge: args.autoMerge === true,
      humanGate: args.humanGate ?? true,
      push: args.push === true,
      remote: args.remote ?? "origin",
      ...(args.postMergeTest === undefined ? {} : { postMergeTest: args.postMergeTest }),
      dryRun: args.dryRun === true,
    });

    if (args.once === true || (maxCycles !== undefined && cycles >= maxCycles)) {
      break;
    }

    await sleep(args.intervalMs ?? 30_000);
  }
}

export async function runMergeWatchCycle(context: CycleContext): Promise<ConductorMergeState> {
  const branches = await listBranches(context.repoPath);
  const worktrees = await listWorktrees(context.repoPath);
  const batchState = getBatchState(context.state, context.batch);
  const now = new Date().toISOString();
  context.state.lastCheckedAt = now;
  context.state.currentBatchId = context.batch.id;
  batchState.lastCheckedAt = now;
  batchState.status = batchState.status === "completed" ? "completed" : "running";

  for (const part of context.batch.parts) {
    const partState = getPartState(batchState, part);
    const candidate = await findCandidate(context.repoPath, context.baseBranch, part, branches, worktrees);
    await updatePartStatusFromCandidate(context, part, partState, candidate);
    await saveMergeState(context.repoPath, context.state);
  }

  printStatusTable(context.batch, batchState);
  await saveMergeState(context.repoPath, context.state);

  const readyParts = batchState.parts.filter((part) => part.status === "ready");
  if (readyParts.length > 0 && !context.autoMerge && context.humanGate) {
    console.log("");
    console.log("Ready for review. Inspect Conductor diffs/tests, then rerun with --auto-merge to merge.");
    for (const part of readyParts) {
      console.log(`- ${part.id}: ${part.branch ?? "-"} ${part.summary ?? ""}`.trimEnd());
    }
    return context.state;
  }

  if (context.autoMerge) {
    await autoMergeReadyParts(context, batchState);
  }

  return context.state;
}

async function updatePartStatusFromCandidate(
  context: CycleContext,
  part: PlanPart,
  partState: ConductorMergePartState,
  candidate: BranchCandidate,
): Promise<void> {
  const now = new Date().toISOString();
  partState.lastCheckedAt = now;
  applyCandidateToState(partState, candidate);

  if (candidate.branch !== undefined && await isBranchMerged(context.repoPath, context.baseBranch, candidate.branch)) {
    partState.status = "merged";
    partState.mergedAt ??= now;
    delete partState.error;
    return;
  }

  if (candidate.marker?.status === "blocked") {
    partState.status = "blocked";
    setOptionalString(partState, "summary", candidate.marker.summary);
    setOptionalString(partState, "notes", candidate.marker.notes);
    partState.error = candidate.marker.notes ?? candidate.marker.summary ?? "Conductor workspace reported blocked.";
    return;
  }

  const branch = candidate.branch;
  const hasBranch = branch !== undefined;
  const branchAhead = branch !== undefined
    ? await hasCommitsAhead(context.repoPath, context.baseBranch, branch)
    : false;

  if (candidate.marker?.status === "ready_for_merge" && branchAhead) {
    if (!await runPerPartTestsIfConfigured(context, candidate, partState)) {
      return;
    }

    partState.status = "ready";
    setOptionalString(partState, "summary", candidate.marker.summary);
    setOptionalString(partState, "notes", candidate.marker.notes);
    delete partState.error;
    return;
  }

  if (context.autoMerge && branchAhead) {
    if (!await runPerPartTestsIfConfigured(context, candidate, partState)) {
      return;
    }
    partState.status = "ready";
    partState.summary = "Ready by auto-merge criteria: branch has commits ahead of base.";
    delete partState.notes;
    delete partState.error;
    return;
  }

  if (hasBranch || candidate.worktreePath !== undefined) {
    partState.status = "running";
    delete partState.error;
    return;
  }

  partState.status = "pending";
  delete partState.error;
}

async function runPerPartTestsIfConfigured(
  context: CycleContext,
  candidate: BranchCandidate,
  partState: ConductorMergePartState,
): Promise<boolean> {
  const testCommand = context.plan.tests?.per_part;
  if (testCommand === undefined || candidate.worktreePath === undefined) {
    return true;
  }

  const testResult = await runTestCommand(candidate.worktreePath, testCommand);
  if (testResult.ok) {
    return true;
  }

  partState.status = "tests_failed";
  partState.error = ["Per-part tests failed.", testResult.stdout, testResult.stderr]
    .filter((value) => value.length > 0)
    .join("\n");
  return false;
}

async function autoMergeReadyParts(
  context: CycleContext,
  batchState: ConductorMergeBatchState,
): Promise<void> {
  let dryRunMergeCount = 0;
  for (const part of context.batch.parts) {
    const partState = getPartState(batchState, part);
    if (partState.status === "merged") {
      continue;
    }
    if (partState.status !== "ready") {
      return;
    }
    if (partState.branch === undefined) {
      partState.status = "blocked";
      partState.error = "Ready part has no branch to merge.";
      await saveMergeState(context.repoPath, context.state);
      return;
    }

    if (context.dryRun) {
      console.log(`[dry-run] git merge ${partState.branch}`);
      dryRunMergeCount += 1;
      continue;
    }

    const mergeArgs = {
      repoPath: context.repoPath,
      baseBranch: context.baseBranch,
      branch: partState.branch,
      strategy: context.plan.merge.strategy,
      ...(context.plan.merge.auto_resolve === undefined ? {} : { autoResolvePolicies: context.plan.merge.auto_resolve }),
    };
    const mergeResult = await mergeBranch(mergeArgs);

    if (!mergeResult.ok) {
      partState.status = "merge_conflict";
      partState.error = mergeResult.error ?? `Conflicted files: ${mergeResult.conflictedFiles.join(", ")}`;
      batchState.status = "failed";
      await saveMergeState(context.repoPath, context.state);
      throw new Error(`Merge failed for ${part.id}: ${partState.error}`);
    }

    partState.status = "merged";
    partState.mergedAt = new Date().toISOString();
    delete partState.error;
    await saveMergeState(context.repoPath, context.state);
  }

  if (context.dryRun && dryRunMergeCount > 0 && batchState.parts.every((part) => part.status === "ready" || part.status === "merged")) {
    const postMergeTest = context.postMergeTest ?? context.plan.tests?.post_merge;
    if (postMergeTest !== undefined) {
      console.log(`[dry-run] ${postMergeTest}`);
    }
    if (context.push) {
      console.log(`[dry-run] git push ${context.remote} ${context.baseBranch}`);
    }
    return;
  }

  if (batchState.parts.every((part) => part.status === "merged")) {
    await completeBatch(context, batchState);
  }
}

async function completeBatch(
  context: CycleContext,
  batchState: ConductorMergeBatchState,
): Promise<void> {
  const postMergeTest = context.postMergeTest ?? context.plan.tests?.post_merge;
  if (postMergeTest !== undefined) {
    if (context.dryRun) {
      console.log(`[dry-run] ${postMergeTest}`);
    } else {
      const testResult = await runTestCommand(context.repoPath, postMergeTest);
      if (!testResult.ok) {
        batchState.status = "failed";
        const reason = ["Post-merge tests failed.", testResult.stdout, testResult.stderr]
          .filter((value) => value.length > 0)
          .join("\n");
        for (const part of batchState.parts) {
          if (part.status === "merged") {
            part.error = reason;
          }
        }
        await saveMergeState(context.repoPath, context.state);
        throw new Error(reason);
      }
    }
  }

  batchState.status = "completed";
  batchState.completedAt = new Date().toISOString();

  if (context.push) {
    if (context.dryRun) {
      console.log(`[dry-run] git push ${context.remote} ${context.baseBranch}`);
    } else {
      await gitPush(context.repoPath, context.remote, context.baseBranch);
      const pushedAt = new Date().toISOString();
      batchState.pushedAt = pushedAt;
      for (const part of batchState.parts) {
        part.pushedAt = pushedAt;
      }
    }
  }

  await saveMergeState(context.repoPath, context.state);
  const nextBatch = nextIncompleteBatch(context.plan, context.state);
  if (nextBatch !== undefined) {
    console.log(`Next batch: ${nextBatch.id}`);
    console.log(`Dispatch command: npm run conductor:dispatch -- ${context.planPath} --repo ${context.repoPath} --batch ${nextBatch.id}`);
  }
}

async function findCandidate(
  repoPath: string,
  baseBranch: string,
  part: PlanPart,
  branches: string[],
  worktrees: GitWorktreeInfo[],
): Promise<BranchCandidate> {
  const safePartId = sanitizeId(part.id);
  const marker = await findMarker(part, worktrees);
  const markerWorktree = marker?.worktree;

  const candidateBranches = [
    `conductor/${safePartId}`,
    ...branches.filter((branch) => branch.endsWith(`/${safePartId}`)),
    ...branches.filter((branch) => branch.toLowerCase().includes(safePartId)),
  ];
  const branch = unique(candidateBranches).find((candidate) => branches.includes(candidate));
  const worktree = markerWorktree ?? worktrees.find((candidate) => candidate.branch === branch);
  const selectedBranch = branch ?? worktree?.branch;

  if (selectedBranch !== undefined && selectedBranch !== baseBranch && await branchExists(repoPath, selectedBranch)) {
    return {
      branch: selectedBranch,
      ...(worktree?.path === undefined ? {} : { worktreePath: worktree.path }),
      ...(marker?.marker === undefined ? {} : { marker: marker.marker }),
      ...(marker?.markerPath === undefined ? {} : { markerPath: marker.markerPath }),
    };
  }

  return {
    ...(worktree?.path === undefined ? {} : { worktreePath: worktree.path }),
    ...(marker?.marker === undefined ? {} : { marker: marker.marker }),
    ...(marker?.markerPath === undefined ? {} : { markerPath: marker.markerPath }),
  };
}

async function findMarker(
  part: PlanPart,
  worktrees: GitWorktreeInfo[],
): Promise<{ marker: CompletionMarker; markerPath: string; worktree: GitWorktreeInfo } | null> {
  const names = unique([part.id, sanitizeId(part.id)]);
  for (const worktree of worktrees) {
    for (const name of names) {
      const markerPath = path.join(worktree.path, ".awo", "completed", `${name}.json`);
      try {
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as CompletionMarker;
        if (marker.partId === part.id || sanitizeId(marker.partId) === sanitizeId(part.id)) {
          return { marker, markerPath, worktree };
        }
      } catch {
        // Missing or malformed markers are ignored; the workspace remains running/pending.
      }
    }
  }
  return null;
}

function applyCandidateToState(partState: ConductorMergePartState, candidate: BranchCandidate): void {
  if (candidate.branch !== undefined) {
    partState.branch = candidate.branch;
  }
  if (candidate.worktreePath !== undefined) {
    partState.worktreePath = candidate.worktreePath;
  }
  if (candidate.markerPath !== undefined) {
    partState.markerPath = candidate.markerPath;
  }
}

async function loadOrInitializeState(
  repoPath: string,
  loadedPlan: LoadedPlan,
  baseBranch: string,
): Promise<ConductorMergeState> {
  const statePath = getStatePath(repoPath);
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as ConductorMergeState;
    if (state.planHash !== loadedPlan.planHash) {
      return createState(repoPath, loadedPlan, baseBranch);
    }
    return state;
  } catch {
    return createState(repoPath, loadedPlan, baseBranch);
  }
}

function createState(repoPath: string, loadedPlan: LoadedPlan, baseBranch: string): ConductorMergeState {
  const firstBatch = loadedPlan.plan.batches[0];
  if (firstBatch === undefined) {
    throw new Error("Plan has no batches.");
  }
  return {
    planHash: loadedPlan.planHash,
    repoPath,
    baseBranch,
    currentBatchId: firstBatch.id,
    batches: loadedPlan.plan.batches.map((batch) => ({
      id: batch.id,
      status: "pending",
      parts: batch.parts.map((part) => ({ id: part.id, status: "pending" })),
    })),
  };
}

async function saveMergeState(repoPath: string, state: ConductorMergeState): Promise<void> {
  const awoDir = getAwoDir(repoPath);
  await mkdir(awoDir, { recursive: true });
  const statePath = getStatePath(repoPath);
  const tmpPath = `${statePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    await rename(tmpPath, statePath);
  } catch (error) {
    if (!isReplaceRetryableError(error)) {
      throw error;
    }
    await rm(statePath, { force: true });
    await rename(tmpPath, statePath);
  }
}

function getStatePath(repoPath: string): string {
  return path.join(getAwoDir(repoPath), "conductor-merge-state.json");
}

function selectBatch(plan: Plan, state: ConductorMergeState, batchId?: string): PlanBatch {
  if (batchId !== undefined) {
    const batch = plan.batches.find((candidate) => candidate.id === batchId);
    if (batch === undefined) {
      throw new Error(`Batch "${batchId}" not found in plan.`);
    }
    return batch;
  }
  return nextIncompleteBatch(plan, state) ?? plan.batches[plan.batches.length - 1]!;
}

function nextIncompleteBatch(plan: Plan, state: ConductorMergeState): PlanBatch | undefined {
  return plan.batches.find((batch) => getBatchState(state, batch).status !== "completed");
}

function getBatchState(state: ConductorMergeState, batch: PlanBatch): ConductorMergeBatchState {
  let batchState = state.batches.find((candidate) => candidate.id === batch.id);
  if (batchState === undefined) {
    batchState = {
      id: batch.id,
      status: "pending",
      parts: batch.parts.map((part) => ({ id: part.id, status: "pending" })),
    };
    state.batches.push(batchState);
  }
  return batchState;
}

function getPartState(batchState: ConductorMergeBatchState, part: PlanPart): ConductorMergePartState {
  let partState = batchState.parts.find((candidate) => candidate.id === part.id);
  if (partState === undefined) {
    partState = { id: part.id, status: "pending" };
    batchState.parts.push(partState);
  }
  return partState;
}

function printStatusTable(batch: PlanBatch, batchState: ConductorMergeBatchState): void {
  console.log("");
  console.log(`Conductor merge watch: ${batch.id}`);
  const rows = batchState.parts.map((part) => ({
    part: part.id,
    status: part.status,
    branch: part.branch ?? "-",
    marker: part.markerPath ?? "-",
    notes: part.error ?? part.summary ?? "-",
  }));
  const widths = {
    part: columnWidth("Part", rows.map((row) => row.part)),
    status: columnWidth("Status", rows.map((row) => row.status)),
    branch: columnWidth("Branch", rows.map((row) => row.branch)),
    marker: columnWidth("Marker", rows.map((row) => row.marker)),
    notes: columnWidth("Notes", rows.map((row) => row.notes)),
  };
  console.log(["Part".padEnd(widths.part), "Status".padEnd(widths.status), "Branch".padEnd(widths.branch), "Marker".padEnd(widths.marker), "Notes".padEnd(widths.notes)].join("  "));
  console.log([widths.part, widths.status, widths.branch, widths.marker, widths.notes].map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log([row.part.padEnd(widths.part), row.status.padEnd(widths.status), row.branch.padEnd(widths.branch), row.marker.padEnd(widths.marker), row.notes.padEnd(widths.notes)].join("  "));
  }
}

function columnWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((value) => value.length));
}

function sanitizeId(id: string): string {
  const sanitized = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized : "part";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function setOptionalString<T extends { [K in P]?: string }, P extends keyof T>(
  target: T,
  key: P,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value as T[P];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReplaceRetryableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "EPERM" ||
      (error as NodeJS.ErrnoException).code === "EEXIST")
  );
}
