import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { loadPlan, validatePlan } from "./plan.js";
import type { PlanBatch, PlanPart } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ConductorDispatchArgs {
  planPath: string;
  repoPath: string;
  batchId?: string;
  submitKey?: "enter" | "cmd-enter";
  delayMs?: number;
  dryRun?: boolean;
}

export function buildConductorPrompt(args: {
  batchId: string;
  part: PlanPart;
  rawText: string;
}): string {
  const { batchId, part, rawText } = args;
  const lines: string[] = [];

  lines.push("# Conductor Workspace Task");
  lines.push("");
  lines.push(`**Batch:** ${batchId}`);
  lines.push(`**Part:** ${part.id}`);

  if (part.title !== undefined) {
    lines.push(`**Title:** ${part.title}`);
  }

  if (part.files !== undefined && part.files.length > 0) {
    lines.push("");
    lines.push("**Files/Scope:**");
    for (const f of part.files) {
      lines.push(`- ${f}`);
    }
  }

  lines.push("");
  lines.push("**Brief:**");
  lines.push(part.brief);

  if (part.context !== undefined) {
    lines.push("");
    lines.push("**Context:**");
    lines.push(part.context);
  }

  if (part.acceptance !== undefined && part.acceptance.length > 0) {
    lines.push("");
    lines.push("**Acceptance Criteria:**");
    for (const criterion of part.acceptance) {
      lines.push(`- ${criterion}`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("**Full Plan:**");
  lines.push("");
  lines.push(rawText.trimEnd());

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("**Instructions:**");
  lines.push("");
  lines.push("- You are running inside a Conductor workspace.");
  lines.push("- Edit the files directly.");
  lines.push("- Do not just explain.");
  lines.push("- Keep changes scoped to this part.");
  lines.push("- This workspace should be independent from sibling workspaces.");
  lines.push("- When done, leave the workspace ready for review/merge.");

  return lines.join("\n");
}

export function buildConductorDeepLink(args: {
  prompt: string;
  repoPath: string;
}): string {
  const { prompt, repoPath } = args;
  return `conductor://prompt=${encodeURIComponent(prompt)}&path=${encodeURIComponent(repoPath)}`;
}

export async function dispatchConductorBatch(args: ConductorDispatchArgs): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("conductor:dispatch requires macOS (process.platform must be 'darwin').");
  }

  const resolvedPlanPath = path.resolve(args.planPath);
  const resolvedRepoPath = path.resolve(args.repoPath);
  const submitKey = args.submitKey ?? "enter";
  const delayMs = args.delayMs ?? 2000;
  const dryRun = args.dryRun === true;

  const loaded = await loadPlan(resolvedPlanPath);
  const validation = validatePlan(loaded.plan);
  if (!validation.valid) {
    throw new Error(`Plan validation failed: ${validation.errors.join("; ")}`);
  }

  let batch: PlanBatch | undefined;
  if (args.batchId !== undefined) {
    batch = loaded.plan.batches.find((b) => b.id === args.batchId);
    if (batch === undefined) {
      throw new Error(`Batch "${args.batchId}" not found in plan.`);
    }
  } else {
    batch = loaded.plan.batches[0];
    if (batch === undefined) {
      throw new Error("Plan has no batches.");
    }
  }

  for (const part of batch.parts) {
    const prompt = buildConductorPrompt({
      batchId: batch.id,
      part,
      rawText: loaded.rawText,
    });

    const url = buildConductorDeepLink({
      prompt,
      repoPath: resolvedRepoPath,
    });

    if (dryRun) {
      console.log(`\n--- Part: ${part.id} ---`);
      console.log(`Prompt preview (first 200 chars):\n${prompt.slice(0, 200)}...`);
      console.log(`\nURL (first 200 chars):\n${url.slice(0, 200)}...`);
      continue;
    }

    await execFileAsync("open", [url]);
    await sleep(delayMs);

    const keystroke =
      submitKey === "cmd-enter"
        ? `keystroke return using command down`
        : `keystroke return`;

    await execFileAsync("osascript", [
      "-e",
      `tell application "Conductor" to activate`,
    ]);
    await sleep(500);
    await execFileAsync("osascript", [
      "-e",
      `tell application "System Events" to ${keystroke}`,
    ]);

    await sleep(delayMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
