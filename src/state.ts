import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BatchRunState,
  BatchStatus,
  LoadedPlan,
  PartRunState,
  PartStatus,
  RunState,
} from "./types.js";

const stateFileName = "state.json";
const tmpStateFileName = "state.json.tmp";

export function getAwoDir(repoPath: string): string {
  return path.join(repoPath, ".awo");
}

export function getLogsDir(repoPath: string): string {
  return path.join(getAwoDir(repoPath), "logs");
}

export function getPromptsDir(repoPath: string): string {
  return path.join(getAwoDir(repoPath), "prompts");
}

export async function ensureAwoDirs(repoPath: string): Promise<void> {
  await mkdir(getLogsDir(repoPath), { recursive: true });
  await mkdir(getPromptsDir(repoPath), { recursive: true });
  await ensureGitExclude(repoPath);
}

export async function loadState(repoPath: string): Promise<RunState | null> {
  const statePath = getStatePath(repoPath);
  try {
    const rawState = await readFile(statePath, "utf8");
    return JSON.parse(rawState) as RunState;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw new Error(`Unable to load AWO state from ${statePath}: ${errorMessage(error)}`);
  }
}

export async function saveState(repoPath: string, state: RunState): Promise<void> {
  await ensureAwoDirs(repoPath);
  const statePath = getStatePath(repoPath);
  const tmpStatePath = path.join(getAwoDir(repoPath), tmpStateFileName);
  const stateJson = `${JSON.stringify(state, null, 2)}\n`;

  try {
    await writeFile(tmpStatePath, stateJson, "utf8");
    try {
      await rename(tmpStatePath, statePath);
    } catch (error) {
      if (!isReplaceRetryableError(error)) {
        throw error;
      }
      await rm(statePath, { force: true });
      await rename(tmpStatePath, statePath);
    }
  } catch (error) {
    throw new Error(`Unable to save AWO state to ${statePath}: ${errorMessage(error)}`);
  }
}

export async function initializeState(args: {
  repoPath: string;
  loadedPlan: LoadedPlan;
  runId?: string;
}): Promise<RunState> {
  await ensureAwoDirs(args.repoPath);

  const now = new Date().toISOString();
  const runId = args.runId ?? compactTimestamp(new Date());
  const state: RunState = {
    runId,
    planHash: args.loadedPlan.planHash,
    repoPath: args.repoPath,
    baseBranch: args.loadedPlan.plan.base_branch,
    currentBatchIndex: 0,
    status: "idle",
    startedAt: now,
    updatedAt: now,
    batches: args.loadedPlan.plan.batches.map((batch) => ({
      id: batch.id,
      status: "pending",
      parts: batch.parts.map((part) => ({
        id: part.id,
        status: "pending",
        promptPath: path.join(getPromptsDir(args.repoPath), `${part.id}.md`),
        logPath: path.join(getLogsDir(args.repoPath), `${part.id}.log`),
      })),
    })),
  };

  await saveState(args.repoPath, state);
  return state;
}

export async function updatePartStatus(args: {
  repoPath: string;
  batchId: string;
  partId: string;
  status: PartStatus;
  updates?: Partial<PartRunState>;
}): Promise<RunState> {
  const state = await requireState(args.repoPath);
  const batch = state.batches.find((candidate) => candidate.id === args.batchId);
  if (batch === undefined) {
    throw new Error(`Batch "${args.batchId}" not found in AWO state`);
  }

  const partIndex = batch.parts.findIndex((part) => part.id === args.partId);
  if (partIndex === -1) {
    throw new Error(`Part "${args.partId}" not found in batch "${args.batchId}"`);
  }
  const existingPart = batch.parts[partIndex];
  if (existingPart === undefined) {
    throw new Error(`Part "${args.partId}" not found in batch "${args.batchId}"`);
  }

  batch.parts[partIndex] = {
    ...existingPart,
    ...args.updates,
    id: args.partId,
    status: args.status,
  };
  state.updatedAt = new Date().toISOString();

  await saveState(args.repoPath, state);
  return state;
}

export async function updateBatchStatus(args: {
  repoPath: string;
  batchId: string;
  status: BatchStatus;
  updates?: Partial<BatchRunState>;
}): Promise<RunState> {
  const state = await requireState(args.repoPath);
  const batchIndex = state.batches.findIndex((batch) => batch.id === args.batchId);
  if (batchIndex === -1) {
    throw new Error(`Batch "${args.batchId}" not found in AWO state`);
  }
  const existingBatch = state.batches[batchIndex];
  if (existingBatch === undefined) {
    throw new Error(`Batch "${args.batchId}" not found in AWO state`);
  }

  state.batches[batchIndex] = {
    ...existingBatch,
    ...args.updates,
    id: args.batchId,
    status: args.status,
  };
  state.updatedAt = new Date().toISOString();

  await saveState(args.repoPath, state);
  return state;
}

function getStatePath(repoPath: string): string {
  return path.join(getAwoDir(repoPath), stateFileName);
}

async function requireState(repoPath: string): Promise<RunState> {
  const state = await loadState(repoPath);
  if (state === null) {
    throw new Error(`No AWO state found in ${getAwoDir(repoPath)}`);
  }
  return state;
}

async function ensureGitExclude(repoPath: string): Promise<void> {
  const gitPath = path.join(repoPath, ".git");
  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  if (!gitStat.isDirectory()) {
    return;
  }

  const infoDir = path.join(gitPath, "info");
  const excludePath = path.join(infoDir, "exclude");
  await mkdir(infoDir, { recursive: true });

  let excludeText = "";
  try {
    excludeText = await readFile(excludePath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const hasAwoEntry = excludeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".awo/");

  if (!hasAwoEntry) {
    const prefix = excludeText.length > 0 && !excludeText.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, `${excludeText}${prefix}.awo/\n`, "utf8");
  }
}

function compactTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
