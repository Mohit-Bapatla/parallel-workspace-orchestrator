import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { LoadedPlan, Plan, PlanValidationResult } from "./types.js";

const agentSchema = z
  .object({
    type: z.enum(["dry-run", "command", "claude"]).default("dry-run"),
    command: z.string().optional(),
    timeout_minutes: z.number().default(30),
    max_turns: z.number().optional(),
  })
  .default({
    type: "dry-run",
    timeout_minutes: 30,
  });

const testsSchema = z
  .object({
    per_part: z.string().optional(),
    post_merge: z.string().optional(),
  })
  .optional();

const autoResolveSchema = z.object({
  pattern: z.string(),
  choose: z.enum(["ours", "theirs"]),
});

const mergeSchema = z
  .object({
    strategy: z.enum(["no-ff", "squash"]).default("no-ff"),
    auto_resolve: z.array(autoResolveSchema).default([]),
  })
  .default({
    strategy: "no-ff",
    auto_resolve: [],
  });

const partSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  files: z.array(z.string()).optional(),
  brief: z.string(),
  context: z.string().optional(),
  acceptance: z.array(z.string()).optional(),
});

const batchSchema = z.object({
  id: z.string(),
  parts: z.array(partSchema),
});

const planSchema = z.object({
  version: z.number(),
  name: z.string().optional(),
  base_branch: z.string(),
  agent: agentSchema,
  tests: testsSchema,
  merge: mergeSchema,
  batches: z.array(batchSchema),
});

export async function loadPlan(planPath: string): Promise<LoadedPlan> {
  const resolvedPath = path.resolve(planPath);
  let rawText: string;

  try {
    rawText = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read plan at ${resolvedPath}: ${errorMessage(error)}`);
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawText);
  } catch (error) {
    throw new Error(`Invalid YAML in ${resolvedPath}: ${errorMessage(error)}`);
  }

  const parsedPlan = planSchema.safeParse(parsedYaml);
  if (!parsedPlan.success) {
    throw new Error(`Invalid plan schema in ${resolvedPath}: ${formatZodError(parsedPlan.error)}`);
  }

  const plan = stripUndefined(parsedPlan.data) as Plan;
  const validation = validatePlan(plan);
  if (!validation.valid) {
    throw new Error(`Invalid plan in ${resolvedPath}: ${validation.errors.join("; ")}`);
  }

  return {
    plan,
    rawText,
    planPath: resolvedPath,
    planHash: hashPlan(plan),
    warnings: validation.warnings,
  };
}

export function validatePlan(plan: Plan, options: { strict?: boolean } = {}): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const strict = options.strict === true;

  if (typeof plan.version !== "number" || Number.isNaN(plan.version)) {
    errors.push("version must exist and be a number");
  }

  if (!isNonEmptyString(plan.base_branch)) {
    errors.push("base_branch must be a non-empty string");
  }

  if (!Array.isArray(plan.batches) || plan.batches.length === 0) {
    errors.push("batches must contain at least one batch");
  }

  const batchIds = new Set<string>();
  const partIds = new Set<string>();

  for (const [batchIndex, batch] of plan.batches.entries()) {
    const batchLabel = batch.id || `batch at index ${batchIndex}`;

    if (!isNonEmptyString(batch.id)) {
      errors.push(`batch at index ${batchIndex} must have a non-empty id`);
    } else if (batchIds.has(batch.id)) {
      errors.push(`duplicate batch id "${batch.id}"`);
    } else {
      batchIds.add(batch.id);
    }

    if (!Array.isArray(batch.parts) || batch.parts.length === 0) {
      errors.push(`batch "${batchLabel}" must contain at least one part`);
      continue;
    }

    const filesByPath = new Map<string, string>();
    for (const [partIndex, part] of batch.parts.entries()) {
      const partLabel = part.id || `part at index ${partIndex}`;

      if (!isNonEmptyString(part.id)) {
        errors.push(`part at index ${partIndex} in batch "${batchLabel}" must have a non-empty id`);
      } else if (partIds.has(part.id)) {
        errors.push(`duplicate part id "${part.id}"`);
      } else {
        partIds.add(part.id);
      }

      if (!isNonEmptyString(part.brief)) {
        errors.push(`part "${partLabel}" in batch "${batchLabel}" must have a non-empty brief`);
      }

      for (const filePath of part.files ?? []) {
        const firstPartId = filesByPath.get(filePath);
        if (firstPartId === undefined) {
          filesByPath.set(filePath, partLabel);
          continue;
        }

        const message = `file "${filePath}" is listed by multiple parts in batch "${batchLabel}" (${firstPartId}, ${partLabel})`;
        if (strict) {
          errors.push(message);
        } else {
          warnings.push(message);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function hashPlan(plan: Plan): string {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortRecursively(value));
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortRecursively(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortRecursively(item)]),
    );
  }

  return value;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)]),
    );
  }

  return value;
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "plan";
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
