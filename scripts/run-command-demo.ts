import path from "node:path";
import { execa } from "execa";

const fakeAgentPath = path.resolve("examples", "fake-agent.mjs");
const agentCommand = `node ${quoteShellArg(fakeAgentPath)}`;

await execa("npm", ["run", "demo:setup"], { stdio: "inherit" });
await execa(
  "tsx",
  [
    "src/cli.ts",
    "run",
    "examples/plan.yaml",
    "--repo",
    ".demo/sample-repo",
    "--agent",
    "command",
    "--agent-command",
    agentCommand,
    "--new-run",
  ],
  { stdio: "inherit" },
);

function quoteShellArg(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
