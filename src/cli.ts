#!/usr/bin/env node

import { Command } from "commander";

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
