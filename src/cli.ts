#!/usr/bin/env node

import { Command } from "commander";

import { loadPlan, validatePlan } from "./plan.js";
import { loadState } from "./state.js";
import { renderStatus } from "./status.js";

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
  .option("--repo <repo>", "target repository path")
  .action(() => {
    console.log("run command not implemented yet");
  });

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
