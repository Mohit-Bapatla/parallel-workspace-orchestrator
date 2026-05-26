import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa, type ExecaError } from "execa";

import type { AgentType, PlanBatch, PlanPart } from "./types.js";

export interface AgentRunInput {
  repoPath: string;
  worktreePath: string;
  part: PlanPart;
  batch: PlanBatch;
  fullPlanText: string;
  promptPath: string;
  logPath: string;
  doneMarkerPath: string;
  timeoutMs: number;
  command?: string;
  maxTurns?: number;
}

export interface AgentRunResult {
  ok: boolean;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export function createAgentRunner(
  type: AgentType,
  options: { command?: string; maxTurns?: number; claudeSkipPermissions?: boolean } = {},
): AgentRunner {
  if (type === "command") {
    return new CommandAgentRunner(options.command);
  }

  if (type === "claude") {
    return new ClaudeAgentRunner(options.maxTurns, options.claudeSkipPermissions);
  }

  return new DryRunAgentRunner();
}

export async function appendLog(logPath: string, message: string): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, message.endsWith("\n") ? message : `${message}\n`, "utf8");
}

class DryRunAgentRunner implements AgentRunner {
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    await appendLog(input.logPath, `[${startedAt}] dry-run started for ${input.part.id}`);

    const generatedAt = new Date().toISOString();
    const outputPath = path.join(input.worktreePath, "docs", "generated", `${input.part.id}.md`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderDryRunMarkdown(input, generatedAt), "utf8");
    await writeDoneMarker(input.doneMarkerPath, `dry-run completed for ${input.part.id}\n`);

    const finishedAt = new Date().toISOString();
    await appendLog(input.logPath, `[${finishedAt}] dry-run completed for ${input.part.id}`);
    return { ok: true, exitCode: 0, startedAt, finishedAt };
  }
}

class CommandAgentRunner implements AgentRunner {
  constructor(private readonly command?: string) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const command = input.command ?? this.command;
    if (command === undefined || command.trim().length === 0) {
      const finishedAt = new Date().toISOString();
      const error = "Command agent runner requires a command.";
      await appendLog(input.logPath, `[${finishedAt}] ${error}`);
      return { ok: false, exitCode: null, startedAt, finishedAt, error };
    }

    await appendLog(input.logPath, `[${startedAt}] command started: ${command}`);

    let result;
    try {
      result = await execa(command, {
        cwd: input.worktreePath,
        shell: true,
        reject: false,
        timeout: input.timeoutMs,
        env: {
          AWO_PART_ID: input.part.id,
          AWO_BATCH_ID: input.batch.id,
          AWO_TASK_FILE: input.promptPath,
          AWO_DONE_FILE: input.doneMarkerPath,
          AWO_WORKTREE: input.worktreePath,
          AWO_LOG_FILE: input.logPath,
        },
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = `Unable to run command agent: ${errorMessage(error)}`;
      await appendLog(input.logPath, `[${finishedAt}] ${message}`);
      return { ok: false, exitCode: null, startedAt, finishedAt, error: message };
    }

    await appendProcessOutput(input.logPath, result.stdout, result.stderr);
    const finishedAt = new Date().toISOString();
    const ok = result.exitCode === 0 && !result.timedOut;
    const error = ok
      ? undefined
      : result.timedOut
        ? `Command timed out after ${input.timeoutMs}ms.`
        : `Command exited with code ${result.exitCode}.`;
    await appendLog(input.logPath, `[${finishedAt}] command finished: ${ok ? "ok" : error}`);

    return {
      ok,
      exitCode: result.exitCode ?? null,
      startedAt,
      finishedAt,
      ...(error === undefined ? {} : { error }),
    };
  }
}

class ClaudeAgentRunner implements AgentRunner {
  constructor(
    private readonly maxTurns?: number,
    private readonly claudeSkipPermissions?: boolean,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    await appendLog(input.logPath, `[${startedAt}] claude runner started for ${input.part.id}`);

    let prompt: string;
    try {
      prompt = await readFile(input.promptPath, "utf8");
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = `Unable to read Claude prompt at ${input.promptPath}: ${errorMessage(error)}`;
      await appendLog(input.logPath, `[${finishedAt}] ${message}`);
      return { ok: false, exitCode: null, startedAt, finishedAt, error: message };
    }

    const maxTurns = input.maxTurns ?? this.maxTurns;
    const args = ["-p", "--output-format", "json"];
    if (this.claudeSkipPermissions === true) {
      args.push("--dangerously-skip-permissions");
    }
    if (maxTurns !== undefined) {
      args.push("--max-turns", String(maxTurns));
    }
    args.push(prompt);

    try {
      const result = await execa("claude", args, {
        cwd: input.worktreePath,
        reject: false,
        timeout: input.timeoutMs,
      });
      await appendProcessOutput(input.logPath, result.stdout, result.stderr);

      const finishedAt = new Date().toISOString();
      const ok = result.exitCode === 0 && !result.timedOut;
      const error = ok
        ? undefined
        : result.timedOut
          ? `Claude timed out after ${input.timeoutMs}ms.`
          : `Claude exited with code ${result.exitCode}.`;
      await appendLog(input.logPath, `[${finishedAt}] claude finished: ${ok ? "ok" : error}`);

      return {
        ok,
        exitCode: result.exitCode ?? null,
        startedAt,
        finishedAt,
        ...(error === undefined ? {} : { error }),
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = `Unable to run Claude Code: ${errorMessage(error)}`;
      await appendLog(input.logPath, `[${finishedAt}] ${message}`);
      return { ok: false, exitCode: null, startedAt, finishedAt, error: message };
    }
  }
}

function renderDryRunMarkdown(input: AgentRunInput, generatedAt: string): string {
  const lines = [
    `# Dry-run output for ${input.part.id}`,
    "",
    `- Part: ${input.part.id}`,
    `- Batch: ${input.batch.id}`,
  ];

  if (input.part.title !== undefined) {
    lines.push(`- Title: ${input.part.title}`);
  }

  lines.push("", "## Brief", "", input.part.brief, "", `Generated at: ${generatedAt}`, "");
  return lines.join("\n");
}

async function writeDoneMarker(doneMarkerPath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(doneMarkerPath), { recursive: true });
  await writeFile(doneMarkerPath, contents, "utf8");
}

async function appendProcessOutput(
  logPath: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  if (stdout.length > 0) {
    await appendLog(logPath, ["--- stdout ---", stdout].join("\n"));
  }
  if (stderr.length > 0) {
    await appendLog(logPath, ["--- stderr ---", stderr].join("\n"));
  }
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
