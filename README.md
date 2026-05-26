# Automated Parallel Workspace Orchestrator

## Overview

Automated Parallel Workspace Orchestrator, or AWO, is a local TypeScript CLI that executes structured batched implementation plans across isolated Git worktrees. Parts inside a batch run in parallel, then their branches merge back sequentially before the next batch begins.

The current MVP is built for local review and experimentation. It can run entirely in dry-run mode, so no Claude Code, Conductor, or external agent service is required.

## Problem

The workflow AWO automates is familiar when using coding agents on a larger implementation plan:

- A human creates an implementation plan.
- The plan is split into ordered batches.
- Parts inside a batch are independent enough to run at the same time.
- Later batches depend on the previous batch being merged.
- A human manually creates workspaces, launches agents, waits, tests, merges, and repeats.

AWO turns that process into a resumable CLI flow backed by Git worktrees and durable state.

## What This MVP Implements

- YAML plan parsing and validation.
- Sequential batch execution.
- Parallel part execution within each batch.
- Isolated Git worktrees and branches per part.
- Dry-run agent runner.
- Shell-command agent runner.
- Optional Claude Code runner adapter.
- Per-part prompt files and logs.
- Durable `.awo/state.json`.
- Resume behavior for completed, merged, and retryable parts.
- Merge and test gating.
- Conservative conflict handling.
- `status` command and watch mode.

## Quick Start

```bash
npm install
npm run demo
npm run demo:status
```

`npm run demo` creates `.demo/sample-repo`, initializes it as a Git repo, and runs the example plan in dry-run mode. The dry-run runner writes documentation files, commits them in isolated worktrees, merges them by batch, and runs the sample repo tests after each merge batch.

## CLI Usage

Validate a plan:

```bash
npm run dev -- validate examples/plan.yaml
```

Run a plan against a target repo:

```bash
npm run dev -- run examples/plan.yaml --repo .demo/sample-repo --agent dry-run --new-run
```

Show current run state:

```bash
npm run dev -- status --repo .demo/sample-repo
```

Watch current run state:

```bash
npm run dev -- status --repo .demo/sample-repo --watch
```

Command-agent mode can run any local command in each part worktree:

```bash
npm run dev -- run examples/plan.yaml --repo path/to/repo --agent command --agent-command "node path/to/agent.mjs"
```

Claude mode is available when `claude` is installed and selected explicitly:

```bash
npm run dev -- run examples/plan.yaml --repo path/to/repo --agent claude
```

## Plan Format

Plans are YAML files with a base branch, optional agent/test/merge settings, and ordered batches:

```yaml
version: 1
name: demo-parallel-workspace-orchestration
base_branch: main
agent:
  type: dry-run
  timeout_minutes: 5
tests:
  post_merge: npm test
merge:
  strategy: no-ff
  auto_resolve: []
batches:
  - id: batch-1
    parts:
      - id: alpha
        title: Create alpha documentation
        files:
          - docs/generated/alpha.md
        brief: Create alpha documentation for the sample repository.
        acceptance:
          - docs/generated/alpha.md exists
```

Validation checks include unique batch IDs, globally unique part IDs, non-empty briefs, non-empty batches, and same-batch file overlap warnings. Strict mode turns same-batch file overlap warnings into errors.

## Architecture

The CLI is split into small modules:

- `src/plan.ts` parses YAML, applies defaults, validates plans, and computes stable plan hashes.
- `src/state.ts` stores durable run state in `<repo>/.awo/state.json` and creates log/prompt folders.
- `src/git.ts` wraps Git operations with `execa`, including worktrees, commits, tests, and merges.
- `src/agent.ts` defines the runner abstraction and implements dry-run, command, and optional Claude runners.
- `src/orchestrator.ts` coordinates batches, parallel parts, commits, tests, merges, halts, and resume behavior.
- `src/status.ts` renders a plain terminal status table.
- `src/cli.ts` wires the commands with Commander.

## Runtime Files

AWO stores state and run artifacts in the target repo:

- `.awo/state.json`
- `.awo/logs/<part>.log`
- `.awo/prompts/<part>.md`

Worktrees are created outside the target repo:

```text
<parent-of-repo>/.awo-worktrees/<repo-folder>/<run-id>/<part-id>
```

The target repo's `.git/info/exclude` is updated so `.awo/` does not dirty the working tree when the target repo has a normal `.git` directory.

## Resume Model

If a run halts, rerun the same command after fixing the issue. AWO reuses existing state unless `--new-run` is passed.

- Completed batches are skipped.
- Merged parts are skipped.
- Completed but unmerged parts proceed to merge.
- Failed, test-failed, worktree-created, and running parts are retryable.
- Worktrees are not deleted by the MVP.

## Merge And Test Gating

Every part runs in a branch named `awo/<runId>/<partId>`. After a part finishes, AWO auto-commits dirty changes with a local bot identity, verifies the branch has commits ahead of the batch base SHA, and optionally runs per-part tests.

After all parts in a batch complete, branches merge into the base branch sequentially. Post-merge tests run after each batch when configured. Merge conflict handling is conservative: AWO only auto-resolves conflicts when every conflicted file matches an explicit policy in the plan.

## Tradeoffs And Current Limits

- This is a local CLI MVP, not a hosted service.
- Claude Code support is adapter-level and optional.
- There is no direct Conductor integration.
- Worktree cleanup is left to the user for now.
- Conflict recovery is intentionally conservative.
- The dry-run runner writes deterministic sample docs; it is for testing the orchestration flow, not for real implementation work.
- Command-agent mode assumes the provided command knows how to use the `AWO_*` environment variables.

## Development

```bash
npm test
npm run build
npm run typecheck
npm run dev -- validate examples/plan.yaml
```

Useful demo commands:

```bash
npm run demo:setup
npm run demo
npm run demo:status
```
