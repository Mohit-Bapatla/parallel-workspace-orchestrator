#!/usr/bin/env node

import { Command } from "commander";

import { runConductorMergeWatch } from "./conductor-merge.js";
import { dispatchConductorBatch } from "./conductor.js";
import { runOrchestration } from "./orchestrator.js";
import { loadPlan, validatePlan } from "./plan.js";
import { loadState } from "./state.js";
import { renderStatus } from "./status.js";
import type { AgentType } from "./types.js";

const program = new Command();

program
  .name("awo")
  .description("Automated Parallel Workspace Orchestrator")
  .version("0.1.0");

program
  .command("validate")
  .argument("<plan>", "path to an AWO YAML plan")
  .option("--strict", "treat warnings as validation errors")
  .action(async (planPath: string, options: { strict?: boolean }) => {
    try {
      const loadedPlan = await loadPlan(planPath);
      const validation = validatePlan(loadedPlan.plan, { strict: options.strict === true });

      console.log(`Plan: ${loadedPlan.plan.name ?? "(unnamed)"}`);
      console.log(`Path: ${loadedPlan.planPath}`);
      console.log(`Hash: ${loadedPlan.planHash}`);

      if (validation.warnings.length > 0) {
        console.log("");
        console.log("Warnings:");
        for (const warning of validation.warnings) {
          console.log(`- ${warning}`);
        }
      }

      if (validation.errors.length > 0) {
        console.error("");
        console.error("Errors:");
        for (const error of validation.errors) {
          console.error(`- ${error}`);
        }
        process.exitCode = 1;
        return;
      }

      console.log("");
      console.log("Plan is valid.");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .requiredOption("--repo <repo>", "target repository path")
  .option("--watch", "re-render status every second")
  .action(async (options: { repo: string; watch?: boolean }) => {
    const render = async (): Promise<void> => {
      try {
        const state = await loadState(options.repo);
        console.log(renderStatus(state));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    };

    if (options.watch === true) {
      await renderWatchedStatus(render);
      return;
    }

    await render();
  });

program
  .command("run")
  .argument("<plan>", "path to an AWO YAML plan")
  .requiredOption("--repo <repo>", "target repository path")
  .option("--agent <agent>", "agent type: dry-run, command, or claude")
  .option("--agent-command <command>", "command to run when using the command agent")
  .option("--strict", "treat plan warnings as validation errors")
  .option("--new-run", "start a fresh run even if state exists")
  .option("--timeout-minutes <number>", "agent timeout in minutes", parsePositiveNumber)
  .option("--max-turns <number>", "maximum Claude turns", parsePositiveInteger)
  .option("--claude-skip-permissions", "bypass Claude permission prompts (only for trusted local/test repos)")
  .action(
    async (
      planPath: string,
      options: {
        repo: string;
        agent?: string;
        agentCommand?: string;
        strict?: boolean;
        newRun?: boolean;
        timeoutMinutes?: number;
        maxTurns?: number;
        claudeSkipPermissions?: boolean;
      },
    ) => {
      try {
        const orchestrationArgs: Parameters<typeof runOrchestration>[0] = {
          planPath,
          repoPath: options.repo,
          strict: options.strict === true,
          newRun: options.newRun === true,
        };
        const agentOverride = parseAgentOverride(options.agent);
        if (agentOverride !== undefined) {
          orchestrationArgs.agentOverride = agentOverride;
        }
        if (options.agentCommand !== undefined) {
          orchestrationArgs.agentCommand = options.agentCommand;
        }
        if (options.timeoutMinutes !== undefined) {
          orchestrationArgs.timeoutMinutes = options.timeoutMinutes;
        }
        if (options.maxTurns !== undefined) {
          orchestrationArgs.maxTurns = options.maxTurns;
        }
        if (options.claudeSkipPermissions === true) {
          orchestrationArgs.claudeSkipPermissions = true;
        }
        await runOrchestration(orchestrationArgs);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    },
  );

program
  .command("conductor:dispatch")
  .argument("<plan>", "path to an AWO YAML plan")
  .requiredOption("--repo <repo>", "target repository path")
  .option("--batch <batchId>", "batch id to dispatch (defaults to first batch)")
  .option("--submit-key <key>", "AppleScript submit key: enter or cmd-enter", "enter")
  .option("--delay-ms <number>", "milliseconds to wait between parts", parsePositiveInteger, 2000)
  .option("--dry-run", "print prompts and URLs without opening Conductor")
  .action(
    async (
      planPath: string,
      options: {
        repo: string;
        batch?: string;
        submitKey: string;
        delayMs: number;
        dryRun?: boolean;
      },
    ) => {
      try {
        const submitKey = options.submitKey === "cmd-enter" ? "cmd-enter" : "enter";
        const dispatchArgs: Parameters<typeof dispatchConductorBatch>[0] = {
          planPath,
          repoPath: options.repo,
          submitKey,
          delayMs: options.delayMs,
          dryRun: options.dryRun === true,
        };
        if (options.batch !== undefined) {
          dispatchArgs.batchId = options.batch;
        }
        await dispatchConductorBatch(dispatchArgs);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    },
  );

program
  .command("conductor:merge-watch")
  .argument("<plan>", "path to an AWO YAML plan")
  .requiredOption("--repo <repo>", "target repository path")
  .option("--interval-ms <number>", "poll interval in milliseconds", parsePositiveInteger, 30_000)
  .option("--once", "run exactly one watcher cycle")
  .option("--batch <batchId>", "batch id to watch")
  .option("--human-gate", "keep human review gate enabled", true)
  .option("--auto-merge", "merge ready branches")
  .option("--push", "push base branch after successful merge and tests")
  .option("--remote <remote>", "remote to push to", "origin")
  .option("--base-branch <branch>", "override plan base branch")
  .option("--post-merge-test <command>", "override post-merge test command")
  .option("--max-cycles <number>", "maximum polling cycles", parsePositiveInteger)
  .option("--dry-run", "print actions without merging or pushing")
  .action(
    async (
      planPath: string,
      options: {
        repo: string;
        intervalMs: number;
        once?: boolean;
        batch?: string;
        humanGate: boolean;
        autoMerge?: boolean;
        push?: boolean;
        remote: string;
        baseBranch?: string;
        postMergeTest?: string;
        maxCycles?: number;
        dryRun?: boolean;
      },
    ) => {
      try {
        await runConductorMergeWatch({
          planPath,
          repoPath: options.repo,
          intervalMs: options.intervalMs,
          once: options.once === true,
          ...(options.batch === undefined ? {} : { batchId: options.batch }),
          humanGate: options.humanGate,
          autoMerge: options.autoMerge === true,
          push: options.push === true,
          remote: options.remote,
          ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }),
          ...(options.postMergeTest === undefined ? {} : { postMergeTest: options.postMergeTest }),
          ...(options.maxCycles === undefined ? {} : { maxCycles: options.maxCycles }),
          dryRun: options.dryRun === true,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    },
  );

function parseAgentOverride(value: string | undefined): AgentType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "dry-run" || value === "command" || value === "claude") {
    return value;
  }
  throw new Error(`Invalid agent "${value}". Expected dry-run, command, or claude.`);
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, got "${value}".`);
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${value}".`);
  }
  return parsed;
}

await program.parseAsync(process.argv);

async function renderWatchedStatus(render: () => Promise<void>): Promise<void> {
  const renderOnce = async (): Promise<void> => {
    console.clear();
    await render();
  };

  await renderOnce();
  setInterval(() => {
    void renderOnce();
  }, 1_000);
}
