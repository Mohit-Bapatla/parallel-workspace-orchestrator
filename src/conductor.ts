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
  lines.push("- Do not merge this workspace yourself.");
  lines.push("- Run relevant tests if possible.");
  lines.push("- Ensure changes are committed on this workspace branch, or leave changes ready for commit if Conductor manages commits.");
  lines.push("- Create `.awo/completed` if needed.");
  lines.push("- When done, write `.awo/completed/<part-id>.json` with status `ready_for_merge`.");
  lines.push("- If blocked, write `.awo/completed/<part-id>.json` with status `blocked` and explain why.");
  lines.push("- Leave the workspace ready for human review and merge.");
  lines.push("");
  lines.push("Ready marker shape:");
  lines.push("```json");
  lines.push(JSON.stringify({
    partId: part.id,
    batchId,
    status: "ready_for_merge",
    summary: "Short summary of completed work.",
    testsRun: ["test command or manual check"],
    notes: "Anything the reviewer should know."
  }, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("Blocked marker shape:");
  lines.push("```json");
  lines.push(JSON.stringify({
    partId: part.id,
    batchId,
    status: "blocked",
    summary: "Short summary of what is blocked.",
    testsRun: ["test command or manual check"],
    notes: "Explain what is needed to unblock."
  }, null, 2));
  lines.push("```");

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
  const resolvedPlanPath = path.resolve(args.planPath);
  const resolvedRepoPath = path.resolve(args.repoPath);
  const submitKey = args.submitKey ?? "enter";
  const delayMs = args.delayMs ?? 2000;
  const dryRun = args.dryRun === true;

  if (!dryRun && process.platform !== "darwin") {
    throw new Error("conductor:dispatch requires macOS (process.platform must be 'darwin') unless --dry-run is used.");
  }

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
