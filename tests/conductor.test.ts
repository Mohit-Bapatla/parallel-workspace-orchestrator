import { describe, expect, it } from "vitest";

import { buildConductorDeepLink, buildConductorPrompt } from "../src/conductor.js";
import type { PlanPart } from "../src/types.js";

const minimalPart: PlanPart = {
  id: "alpha",
  brief: "Build the alpha module.",
};

const fullPart: PlanPart = {
  id: "beta",
  title: "Beta feature",
  files: ["src/beta.ts", "tests/beta.test.ts"],
  brief: "Build the beta module.",
  context: "Beta depends on alpha being merged first.",
  acceptance: ["src/beta.ts exists", "tests pass"],
};

describe("buildConductorPrompt", () => {
  it("includes required heading and fields", () => {
    const prompt = buildConductorPrompt({
      batchId: "batch-1",
      part: minimalPart,
      rawText: "version: 1\nbase_branch: main\n",
    });

    expect(prompt).toContain("# Conductor Workspace Task");
    expect(prompt).toContain("**Batch:** batch-1");
    expect(prompt).toContain("**Part:** alpha");
    expect(prompt).toContain("Build the alpha module.");
  });

  it("includes optional title when present", () => {
    const prompt = buildConductorPrompt({
      batchId: "batch-1",
      part: fullPart,
      rawText: "version: 1\n",
    });

    expect(prompt).toContain("**Title:** Beta feature");
  });

  it("includes files/scope when present", () => {
    const prompt = buildConductorPrompt({
      batchId: "batch-1",
      part: fullPart,
      rawText: "version: 1\n",
    });

    expect(prompt).toContain("**Files/Scope:**");
    expect(prompt).toContain("- src/beta.ts");
    expect(prompt).toContain("- tests/beta.test.ts");
  });

  it("omits files/scope section when files absent", () => {
    const prompt = buildConductorPrompt({
      batchId: "batch-1",
      part: minimalPart,
      rawText: "version: 1\n",
    });

    expect(prompt).not.toContain("**Files/Scope:**");
  });

  it("includes context when present", () => {
    const prompt = buildConductorPrompt({
      batchId: "batch-1",
      part: fullPart,
      rawText: "version: 1\n",
    });

    expect(prompt).toContain("**Context:**");
    expect(prompt).toContain("Beta depends on alpha being merged first.");
  });

  it("omits context section when absent", () => {
    const prompt = buildConductorPrompt({
      batchId: "batch-1",
      part: minimalPart,
      rawText: "version: 1\n",
    });

    expect(prompt).not.toContain("**Context:**");
  });

  it("includes acceptance criteria when present", () => {
    const prompt = buildConductorPrompt({
      batchId: "batch-1",
      part: fullPart,
      rawText: "version: 1\n",
    });

    expect(prompt).toContain("**Acceptance Criteria:**");
    expect(prompt).toContain("- src/beta.ts exists");
    expect(prompt).toContain("- tests pass");
  });

  it("includes full plan text", () => {
    const rawText = "version: 1\nname: my-plan\nbase_branch: main\n";
    const prompt = buildConductorPrompt({
      batchId: "batch-1",
      part: minimalPart,
      rawText,
    });

    expect(prompt).toContain("**Full Plan:**");
    expect(prompt).toContain("version: 1");
    expect(prompt).toContain("name: my-plan");
  });

  it("includes all instructions", () => {
    const prompt = buildConductorPrompt({
      batchId: "batch-1",
      part: minimalPart,
      rawText: "version: 1\n",
    });

    expect(prompt).toContain("You are running inside a Conductor workspace.");
    expect(prompt).toContain("Edit the files directly.");
    expect(prompt).toContain("Do not just explain.");
    expect(prompt).toContain("Keep changes scoped to this part.");
    expect(prompt).toContain("This workspace should be independent from sibling workspaces.");
    expect(prompt).toContain("Do not merge this workspace yourself.");
    expect(prompt).toContain("write `.awo/completed/<part-id>.json` with status `ready_for_merge`");
    expect(prompt).toContain("write `.awo/completed/<part-id>.json` with status `blocked`");
    expect(prompt).toContain("Leave the workspace ready for human review and merge.");
  });
});

describe("buildConductorDeepLink", () => {
  it("starts with conductor:// scheme", () => {
    const url = buildConductorDeepLink({
      prompt: "hello world",
      repoPath: "/Users/test/repo",
    });

    expect(url).toMatch(/^conductor:\/\//);
  });

  it("encodes prompt with encodeURIComponent", () => {
    const prompt = "hello & world = test";
    const url = buildConductorDeepLink({ prompt, repoPath: "/tmp/repo" });

    expect(url).toContain(`prompt=${encodeURIComponent(prompt)}`);
  });

  it("encodes repoPath with encodeURIComponent", () => {
    const repoPath = "/Users/lo gan/my repo";
    const url = buildConductorDeepLink({ prompt: "x", repoPath });

    expect(url).toContain(`path=${encodeURIComponent(repoPath)}`);
  });

  it("contains both prompt and path params", () => {
    const url = buildConductorDeepLink({
      prompt: "do the thing",
      repoPath: "/tmp/test",
    });

    expect(url).toContain("prompt=");
    expect(url).toContain("&path=");
  });

  it("round-trips prompt through decode", () => {
    const prompt = "# Heading\n\nSome **markdown** content.\n- item 1\n- item 2";
    const url = buildConductorDeepLink({ prompt, repoPath: "/tmp/r" });
    const encoded = url.replace("conductor://prompt=", "").split("&path=")[0]!;

    expect(decodeURIComponent(encoded)).toBe(prompt);
  });
});
