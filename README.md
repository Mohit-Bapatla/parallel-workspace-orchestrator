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
npm run demo:command
npm run demo:command:status
```

`npm run demo` creates `.demo/sample-repo`, initializes it as a Git repo, and runs the example plan in dry-run mode. The dry-run runner writes documentation files, commits them in isolated worktrees, merges them by batch, and runs the sample repo tests after each merge batch.

`npm run demo:command` verifies shell-command agent mode using `examples/fake-agent.mjs`. Neither demo requires Claude Code or Conductor.

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

<<<<<<< HEAD
For local testing against a trusted repository, you can bypass Claude's interactive permission prompts:

```bash
npm run dev -- run examples/plan.yaml --repo path/to/repo --agent claude --claude-skip-permissions
```

> **Warning:** `--claude-skip-permissions` passes `--dangerously-skip-permissions` to `claude`. Only use this on repos you own and trust. Never use it against unknown or shared codebases.
=======
Dispatch one batch into Conductor workspaces:

```bash
npm run conductor:dispatch -- examples/plan.yaml --repo /absolute/path/to/repo --batch batch-1
```

Preview the Conductor prompts without opening the app:

```bash
npm run conductor:dispatch -- examples/plan.yaml --repo /absolute/path/to/repo --batch batch-1 --dry-run
```
>>>>>>> b7a9e9b (add Claude Code conductor dispatch skill)

## Agent Runners

- `dry-run`: verified end-to-end. It creates deterministic sample changes in each worktree and does not require Claude.
- `command`: verified end-to-end. It runs an arbitrary shell command or script in each worktree. The command demo uses `examples/fake-agent.mjs` and the `AWO_*` environment variables.
- `claude`: implemented as an adapter around local `claude -p`. It requires Claude Code to be installed, authenticated, and available on the reviewer's `PATH`.

Claude mode is intentionally optional and was not claimed as locally verified unless a reviewer runs it in an environment with Claude Code available.

## Integration Status

**Verified end-to-end:**

- Dry-run runner.
- Command runner.
- Git worktree orchestration.
- Batched parallel execution.
- Durable state/resume.
- Merge/test gating.
- Status reporting.

**Implemented but environment-dependent:**

- Claude Code runner via local `claude -p`. This requires Claude Code to be installed, authenticated, and available on the reviewer's `PATH`.

**Not directly implemented:**

- Direct Conductor API/CLI integration. This MVP uses raw Git worktrees as the default execution layer because Conductor's workspace model is worktree-based. The workspace and agent layers are modular so a future Conductor adapter can replace raw worktree creation if Conductor exposes a stable scripting interface.

## Claude Code Slash Command / Skill

Inside Claude Code, invoke:

```text
/conductor-dispatch
```

The slash command points Claude to `.claude/skills/conductor-dispatch/SKILL.md`. That skill helps turn a grand spec into a reviewed batched AWO plan, writes the approved plan to `.awo/plans`, dispatches an approved batch to Conductor workspaces, and produces a review/test/merge runbook.

The workflow keeps a human in the loop before dispatch and before merge. It uses the existing `npm run conductor:dispatch` command so the user does not have to manually type every terminal command.

If `.awo/plans` does not exist yet, create it before writing the approved plan.

## Conductor Setup

- Open this repo in Conductor.
- Let `conductor.json` run setup with `npm install` and run verification with `npm run verify`.
- Make sure `conductor://` links open Conductor on your machine.
- If auto-submit is blocked on macOS, enable Accessibility permission for Terminal/Cursor.
- Choose Claude Code or Codex manually in Conductor's model/provider picker before dispatch.
- This project does not force provider selection through deep links.
- `npm run conductor:dispatch` can preview prompts with `--dry-run`; without `--dry-run`, it opens Conductor deep links for the selected batch.

## Claude vs Codex

Conductor supports Claude Code and Codex workspaces. AWO's dispatcher opens/submits prompts into Conductor; actual provider/model selection is controlled by Conductor's app/model picker.

If you want Codex workspaces, select Codex in Conductor before running `/conductor-dispatch` or `npm run conductor:dispatch`.

If you want Claude Code workspaces, select Claude Code in Conductor before dispatch.

If Conductor later exposes provider selection in deep links or a stable API, it can be wired into the dispatch layer. This repo does not currently claim to force Claude or Codex provider selection.

## Requirements Coverage

| Requirement | Status | Notes |
| --- | --- | --- |
| YAML plan input | Verified | Parsed with `yaml`, validated with `zod`, and covered by plan tests. |
| repo path input | Verified | `run`, `status`, and demo commands accept `--repo`. |
| ordered batches | Verified | Batches execute sequentially in plan order. |
| parallel parts within batch | Verified | Parts in a batch run with `Promise.all` after isolated worktrees are prepared. |
| sequential batches | Verified | The next batch starts only after the previous batch merges and post-merge tests pass. |
| isolated git worktrees | Verified | Each part gets its own branch and worktree outside the target repo. |
| agent prompt with part slice + full plan | Verified | Prompts include batch/part IDs, title, file scope, brief, context, acceptance criteria, instructions, and full plan text. |
| dry-run runner | Verified | Covered by tests and `npm run demo`. |
| command runner | Verified | Covered by tests and `npm run demo:command` using `examples/fake-agent.mjs`. |
| Claude runner adapter | Implemented / environment-dependent | Uses local `claude -p`; requires Claude Code installed, authenticated, and on `PATH`. |
| merge/test gating | Verified | Requires commits ahead, supports per-part tests, and runs post-merge tests. |
| safe conflict handling | Verified | Merge conflicts halt unless every conflicted file matches an explicit auto-resolve policy. |
| halt/report failures | Verified | Agent, test, no-commit, and merge failures halt with state/log details. |
| status/watch surface | Verified | `status` renders run metadata plus batch/part/status/branch/log table; `--watch` re-renders. |
| resumable state | Verified | Durable `.awo/state.json`; completed batches and merged parts are skipped on resume. |
| Conductor compatibility | Adapter point / not directly implemented | Raw Git worktrees are the default execution layer; a future Conductor adapter can replace workspace creation. |
| direct Conductor API integration | Adapter point / not directly implemented | No direct Conductor API/CLI calls are made in this MVP. |

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
- Crash recovery is deterministic but conservative: mid-agent parts are retried unless their branch already has commits ahead of the batch base; mid-merge conflict cleanup is left to the user before rerunning.

## Merge And Test Gating

Every part runs in a branch named `awo/<runId>/<partId>`. After a part finishes, AWO auto-commits dirty changes with a local bot identity, verifies the branch has commits ahead of the batch base SHA, and optionally runs per-part tests.

After all parts in a batch complete, branches merge into the base branch sequentially. Post-merge tests run after each batch when configured. Merge conflict handling is conservative: AWO only auto-resolves conflicts when every conflicted file matches an explicit policy in the plan.

## Tradeoffs And Current Limits

- This is a local CLI MVP, not a hosted service.
- Claude Code support is adapter-level and optional.
- There is no direct Conductor API/CLI integration; Conductor dispatch uses deep links and keeps provider selection manual.
- Worktree cleanup is left to the user for now.
- Conflict recovery is intentionally conservative.
- The dry-run runner writes deterministic sample docs; it is for testing the orchestration flow, not for real implementation work.
- Command-agent mode assumes the provided command knows how to use the `AWO_*` environment variables.

## Open Questions Answered

### Does Conductor expose a stable scripting interface?

This MVP does not assume one. It uses raw Git worktrees as the fallback/default execution layer. The code is structured so a future Conductor adapter can be added around workspace creation if a stable CLI/API exists.

### How should the orchestrator decide an agent is done?

The current MVP uses process exit code, branch commits ahead of the batch base SHA, and optional tests. Agent runners also support a done marker path. A future Claude-specific version could add structured final-message parsing or JSON output validation.

### What about overlapping files in parallel parts?

Plan validation warns on same-batch exact file overlap, and strict validation can treat overlaps as errors. Merge-time conflict handling still exists as a backstop. Auto-resolution only happens for explicit safe policies; otherwise the run halts and reports conflicted files.

## Conductor App Dispatch

The `conductor:dispatch` command dispatches prompts into the actual Conductor app using `conductor://` deep links and AppleScript auto-submit.

**Requirements:**

- macOS (this command will fail on other platforms)
- Conductor installed and `conductor://` links working
- Terminal or Cursor granted Accessibility permission for AppleScript auto-submit (System Settings → Privacy & Security → Accessibility)

**Behavior:**

This command opens a Conductor workspace prompt for each part in the selected batch. It does not wait for Conductor to finish or merge the resulting changes. The existing raw git orchestrator remains the fully automated wait/merge/resume fallback unless a stable Conductor completion/merge API is available.

**Examples:**

Dispatch batch-1 from a plan:

```bash
npm run conductor:dispatch -- examples/plan.yaml --repo /Users/loganwoo/parallel-workspace-orchestrator --batch batch-1
```

If Conductor uses Cmd+Enter to submit:

```bash
npm run conductor:dispatch -- examples/plan.yaml --repo /Users/loganwoo/parallel-workspace-orchestrator --batch batch-1 --submit-key cmd-enter
```

Dry run (prints prompts and URLs without opening Conductor):

```bash
npm run conductor:dispatch -- examples/plan.yaml --repo /Users/loganwoo/parallel-workspace-orchestrator --batch batch-1 --dry-run
```

**Options:**

| Option | Default | Description |
| --- | --- | --- |
| `--repo <repo>` | required | Absolute or relative path to target repository |
| `--batch <batchId>` | first batch | Batch id to dispatch |
| `--submit-key <enter\|cmd-enter>` | `enter` | AppleScript keystroke used to submit the prompt |
| `--delay-ms <number>` | `2000` | Milliseconds to wait between parts |
| `--dry-run` | off | Print prompts and URLs without opening Conductor |

## Development

```bash
npm test
npm run build
npm run typecheck
npm run dev -- validate examples/plan.yaml
```

## Final Verification

```bash
npm test
npm run build
npm run typecheck
npm run demo
npm run demo:status
npm run demo:command
npm run demo:command:status
npm run verify
```

`npm run verify` runs the main test, build, typecheck, dry-run demo, and command-runner demo checks. Claude mode remains environment-dependent because it requires a local authenticated Claude Code installation.

Useful demo commands:

```bash
npm run demo:setup
npm run demo
npm run demo:status
npm run demo:command
npm run demo:command:status
npm run verify
```
