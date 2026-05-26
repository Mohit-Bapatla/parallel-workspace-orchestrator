import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadPlan, validatePlan } from "../src/plan.js";
import type { Plan } from "../src/types.js";

describe("plan loading and validation", () => {
  it("valid plan loads successfully", async () => {
    const planPath = await writeTempPlan(`
version: 1
name: valid-plan
base_branch: main
agent:
  type: dry-run
  timeout_minutes: 5
merge:
  strategy: no-ff
batches:
  - id: batch-1
    parts:
      - id: alpha
        brief: Build alpha.
`);

    const loadedPlan = await loadPlan(planPath);

    expect(loadedPlan.plan.name).toBe("valid-plan");
    expect(loadedPlan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(loadedPlan.warnings).toEqual([]);
  });

  it("duplicate part IDs fail", () => {
    const plan = makePlan({
      batches: [
        {
          id: "batch-1",
          parts: [
            { id: "alpha", brief: "First alpha." },
            { id: "alpha", brief: "Second alpha." },
          ],
        },
      ],
    });

    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('duplicate part id "alpha"');
  });

  it("duplicate batch IDs fail", () => {
    const plan = makePlan({
      batches: [
        { id: "batch-1", parts: [{ id: "alpha", brief: "Build alpha." }] },
        { id: "batch-1", parts: [{ id: "beta", brief: "Build beta." }] },
      ],
    });

    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('duplicate batch id "batch-1"');
  });

  it("same-batch overlapping files warn", () => {
    const plan = makePlan({
      batches: [
        {
          id: "batch-1",
          parts: [
            { id: "alpha", brief: "Build alpha.", files: ["src/shared.ts"] },
            { id: "beta", brief: "Build beta.", files: ["src/shared.ts"] },
          ],
        },
      ],
    });

    const result = validatePlan(plan);

    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('file "src/shared.ts"');
  });

  it("strict same-batch overlapping files fail", () => {
    const plan = makePlan({
      batches: [
        {
          id: "batch-1",
          parts: [
            { id: "alpha", brief: "Build alpha.", files: ["src/shared.ts"] },
            { id: "beta", brief: "Build beta.", files: ["src/shared.ts"] },
          ],
        },
      ],
    });

    const result = validatePlan(plan, { strict: true });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('file "src/shared.ts"');
  });

  it("default agent type is dry-run", async () => {
    const loadedPlan = await loadPlan(await writeTempPlan(minimalYamlWithoutDefaults()));

    expect(loadedPlan.plan.agent.type).toBe("dry-run");
  });

  it("default timeout is 30", async () => {
    const loadedPlan = await loadPlan(await writeTempPlan(minimalYamlWithoutDefaults()));

    expect(loadedPlan.plan.agent.timeout_minutes).toBe(30);
  });

  it("default merge strategy is no-ff", async () => {
    const loadedPlan = await loadPlan(await writeTempPlan(minimalYamlWithoutDefaults()));

    expect(loadedPlan.plan.merge.strategy).toBe("no-ff");
  });
});

async function writeTempPlan(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "awo-plan-"));
  const planPath = path.join(dir, "plan.yaml");
  await writeFile(planPath, contents.trimStart(), "utf8");
  return planPath;
}

function minimalYamlWithoutDefaults(): string {
  return `
version: 1
base_branch: main
batches:
  - id: batch-1
    parts:
      - id: alpha
        brief: Build alpha.
`;
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    version: 1,
    base_branch: "main",
    agent: {
      type: "dry-run",
      timeout_minutes: 30,
    },
    merge: {
      strategy: "no-ff",
      auto_resolve: [],
    },
    batches: [
      {
        id: "batch-1",
        parts: [{ id: "alpha", brief: "Build alpha." }],
      },
    ],
    ...overrides,
  };
}
