import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

const repoPath = path.resolve(".demo", "sample-repo");

await rm(repoPath, { recursive: true, force: true });
await mkdir(path.join(repoPath, "src"), { recursive: true });

await writeFile(
  path.join(repoPath, "package.json"),
  `${JSON.stringify(
    {
      name: "awo-sample-repo",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: {
        test: "node test.js",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

await writeFile(
  path.join(repoPath, "src", "index.js"),
  [
    "export function describeSample() {",
    '  return "AWO sample repository";',
    "}",
    "",
  ].join("\n"),
  "utf8",
);

await writeFile(
  path.join(repoPath, "test.js"),
  [
    'import { existsSync, readdirSync } from "node:fs";',
    'import path from "node:path";',
    "",
    'if (!existsSync(path.join(process.cwd(), "src", "index.js"))) {',
    '  console.error("src/index.js is missing");',
    "  process.exit(1);",
    "}",
    "",
    'const generatedDir = path.join(process.cwd(), "docs", "generated");',
    "if (existsSync(generatedDir)) {",
    "  const docs = readdirSync(generatedDir).filter((entry) => entry.endsWith('.md')).sort();",
    "  if (docs.length > 0) {",
    '    console.log(`generated docs: ${docs.join(", ")}`);',
    "  }",
    "}",
    "",
    'console.log("sample tests passed");',
    "",
  ].join("\n"),
  "utf8",
);

await git(["init"]);
await git(["checkout", "-B", "main"]);
await git(["config", "user.email", "demo@example.local"]);
await git(["config", "user.name", "Demo User"]);
await git(["add", "package.json", "src/index.js", "test.js"]);
await git(["commit", "-m", "Initial sample repo"]);

console.log(`Sample repo ready: ${repoPath}`);

async function git(args: string[]): Promise<void> {
  await execa("git", args, { cwd: repoPath });
}
