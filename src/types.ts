export type AgentType = "dry-run" | "command" | "claude";
export type MergeStrategy = "no-ff" | "squash";
export type AutoResolveChoice = "ours" | "theirs";

export interface PlanPart {
  id: string;
  title?: string;
  files?: string[];
  brief: string;
  context?: string;
  acceptance?: string[];
}

export interface PlanBatch {
  id: string;
  parts: PlanPart[];
}

export interface AutoResolvePolicy {
  pattern: string;
  choose: AutoResolveChoice;
}

export interface MergeResult {
  ok: boolean;
  conflictedFiles: string[];
  merged: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface Plan {
  version: number;
  name?: string;
  base_branch: string;
  agent: {
    type: AgentType;
    command?: string;
    timeout_minutes: number;
    max_turns?: number;
  };
  tests?: {
    per_part?: string;
    post_merge?: string;
  };
  merge: {
    strategy: MergeStrategy;
    auto_resolve?: AutoResolvePolicy[];
  };
  batches: PlanBatch[];
}

export interface LoadedPlan {
  plan: Plan;
  rawText: string;
  planPath: string;
  planHash: string;
  warnings: string[];
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export type RunStatus = "idle" | "running" | "halted" | "completed";
export type BatchStatus = "pending" | "running" | "merging" | "completed" | "failed";
export type PartStatus =
  | "pending"
  | "worktree_created"
  | "running"
  | "completed"
  | "failed"
  | "merged"
  | "merge_conflict"
  | "tests_failed"
  | "skipped";

export interface PartRunState {
  id: string;
  status: PartStatus;
  branch?: string;
  worktreePath?: string;
  promptPath?: string;
  logPath?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface BatchRunState {
  id: string;
  status: BatchStatus;
  startedAt?: string;
  finishedAt?: string;
  parts: PartRunState[];
}

export interface RunState {
  runId: string;
  planHash: string;
  repoPath: string;
  baseBranch: string;
  currentBaseSha?: string;
  currentBatchIndex: number;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  batches: BatchRunState[];
}
