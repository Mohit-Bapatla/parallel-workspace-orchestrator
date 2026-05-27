import { execa } from "execa";
import path from "node:path";
import process from "node:process";

import { loadPlan, validatePlan } from "../src/plan.js";
import type { PlanBatch, PlanPart } from "../src/types.js";

interface DispatchOptions {
  planPath: string;
  repoPath: string;
  batchId: string;
  dryRun: boolean;
  submitKey: "enter" | "cmd-enter";
}

const options = parseArgs(process.argv.slice(2));
const loadedPlan = await loadPlan(options.planPath);
const validation = validatePlan(loadedPlan.plan);
if (!validation.valid) {
  throw new Error(`Plan validation failed: ${validation.errors.join("; ")}`);
}

const batch = loadedPlan.plan.batches.find((candidate) => candidate.id === options.batchId);
if (batch === undefined) {
  throw new Error(`Batch "${options.batchId}" not found in ${loadedPlan.planPath}.`);
}

console.log(`Plan: ${loadedPlan.plan.name ?? "(unnamed)"}`);
console.log(`Batch: ${batch.id}`);
console.log(`Repo: ${options.repoPath}`);
console.log("Provider/model: choose Claude Code or Codex manually in Conductor before dispatch.");

for (const part of batch.parts) {
  const prompt = renderConductorPrompt({
    batch,
    part,
    repoPath: options.repoPath,
    fullPlanText: loadedPlan.rawText,
  });

  if (options.dryRun) {
    console.log("");
    console.log(`--- DRY RUN: ${batch.id}/${part.id} ---`);
    console.log(prompt);
    continue;
  }

  await openConductorPrompt(prompt);
  await maybeSubmit(options.submitKey);
}

if (options.dryRun) {
  console.log("");
  console.log(`Dry run complete. ${batch.parts.length} Conductor prompt(s) rendered.`);
} else {
  console.log(`Dispatched ${batch.parts.length} Conductor prompt(s).`);
}

function parseArgs(args: string[]): DispatchOptions {
  const planPath = args[0];
  if (planPath === undefined || planPath.startsWith("--")) {
    throw new Error("Usage: npm run conductor:dispatch -- <planPath> --repo <repoPath> --batch <batchId> [--dry-run] [--submit-key enter|cmd-enter]");
  }

  let repoPath: string | undefined;
  let batchId: string | undefined;
  let dryRun = false;
  let submitKey: "enter" | "cmd-enter" = "enter";

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repoPath = args[index + 1];
      index += 1;
    } else if (arg === "--batch") {
      batchId = args[index + 1];
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--submit-key") {
      const value = args[index + 1];
      if (value !== "enter" && value !== "cmd-enter") {
        throw new Error('--submit-key must be "enter" or "cmd-enter".');
      }
      submitKey = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }

  if (repoPath === undefined) {
    throw new Error("--repo is required.");
  }
  if (batchId === undefined) {
    throw new Error("--batch is required.");
  }

  return {
    planPath: path.resolve(planPath),
    repoPath: path.resolve(repoPath),
    batchId,
    dryRun,
    submitKey,
  };
}

function renderConductorPrompt(args: {
  batch: PlanBatch;
  part: PlanPart;
  repoPath: string;
  fullPlanText: string;
}): string {
  const files = args.part.files?.length
    ? args.part.files.map((file) => `- ${file}`).join("\n")
    : "- (not specified)";
  const acceptance = args.part.acceptance?.length
    ? args.part.acceptance.map((item) => `- ${item}`).join("\n")
    : "- (not specified)";

  return [
    "# AWO Conductor Workspace Task",
    "",
    `Repository: ${args.repoPath}`,
    `Batch ID: ${args.batch.id}`,
    `Part ID: ${args.part.id}`,
    args.part.title === undefined ? "" : `Title: ${args.part.title}`,
    "",
    "## File Scope",
    files,
    "",
    "## Brief",
    args.part.brief,
    "",
    "## Context",
    args.part.context ?? "(not specified)",
    "",
    "## Acceptance Criteria",
    acceptance,
    "",
    "## Instructions",
    "- Work only on this part's scope.",
    "- Do not depend on sibling Conductor workspaces.",
    "- Leave the workspace in a reviewable state.",
    "- The human will review, test, and merge approved work.",
    "",
    "## Full AWO Plan",
    "```yaml",
    args.fullPlanText.trimEnd(),
    "```",
    "",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

async function openConductorPrompt(prompt: string): Promise<void> {
  const url = `conductor://new?prompt=${encodeURIComponent(prompt)}`;
  if (process.platform === "darwin") {
    await execa("open", [url]);
  } else if (process.platform === "win32") {
    await execa("powershell", ["-NoProfile", "-Command", "Start-Process", url]);
  } else {
    await execa("xdg-open", [url]);
  }
}

async function maybeSubmit(submitKey: "enter" | "cmd-enter"): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const script =
    submitKey === "cmd-enter"
      ? 'tell application "System Events" to keystroke return using command down'
      : 'tell application "System Events" to key code 36';
  await execa("osascript", ["-e", script], { reject: false });
}
