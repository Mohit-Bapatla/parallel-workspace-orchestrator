# conductor-dispatch

## Purpose

This skill turns a grand implementation spec into a reviewed batched AWO plan. It can dispatch an approved batch into Conductor workspaces using this repo's `conductor:dispatch` command. It keeps a human in the loop before dispatch and before merge.

## When to use

Use this skill when:

- A broad feature or spec should be split into independent work units.
- Parts in a batch can run in separate Conductor workspaces.
- Later batches depend on previous batches being reviewed and merged.

## Required inputs

Ask for or infer:

- Target repo path.
- Grand spec.
- Base branch, defaulting to `main`.
- Desired batch shape if provided.
- First batch to dispatch.
- Submit key: `enter` or `cmd-enter`, defaulting to `enter`.

Also ask the user to confirm:

- Conductor is installed.
- `conductor://` links work.
- Terminal/Cursor has Accessibility permission if auto-submit is needed.
- The desired Conductor provider/model is selected manually in the Conductor app before dispatching.

Important provider wording:

- Do not claim this skill can force Claude vs Codex provider selection.
- Provider selection is handled in Conductor's model/provider picker.
- If the user wants Codex, tell them to select Codex in Conductor before dispatch.
- If the user wants Claude Code, tell them to select Claude Code in Conductor before dispatch.

## Workflow

1. Read the grand spec.
2. Inspect the repo if needed.
3. Produce a batched plan with `base_branch`, ordered batches, parts, unique ids, titles, files/scope, self-contained briefs, context, and acceptance criteria.
4. Show the plan to the human for review.
5. Ask for approval before writing or dispatching.
6. Save the approved plan to `.awo/plans/conductor-dispatch-<timestamp>.yaml`. Create `.awo/plans` first if needed.
7. Ask which batch to dispatch first.
8. Confirm the desired Conductor provider is manually selected in the app.
9. Run:
   `npm run conductor:dispatch -- <planPath> --repo <repoPath> --batch <batchId>`
10. If the user says Conductor sends with Cmd+Enter, run:
   `npm run conductor:dispatch -- <planPath> --repo <repoPath> --batch <batchId> --submit-key cmd-enter`
11. After dispatch, produce a runbook/checklist for review, testing, debugging, merging, and the next batch.

## Plan YAML template

```yaml
version: 1
name: feature-name
base_branch: main
agent:
  type: dry-run
  timeout_minutes: 30
tests:
  post_merge: npm test
merge:
  strategy: no-ff
  auto_resolve: []
batches:
  - id: batch-1
    parts:
      - id: part-id
        title: Part title
        files:
          - path/to/file.ts
        brief: |
          Self-contained task brief.
        context: |
          Relevant context.
        acceptance:
          - Acceptance criterion
```

## Dispatch command examples

```bash
npm run conductor:dispatch -- .awo/plans/conductor-dispatch-YYYYMMDD-HHMMSS.yaml --repo /absolute/path/to/repo --batch batch-1
```

With Cmd+Enter:

```bash
npm run conductor:dispatch -- .awo/plans/conductor-dispatch-YYYYMMDD-HHMMSS.yaml --repo /absolute/path/to/repo --batch batch-1 --submit-key cmd-enter
```

Dry run:

```bash
npm run conductor:dispatch -- .awo/plans/conductor-dispatch-YYYYMMDD-HHMMSS.yaml --repo /absolute/path/to/repo --batch batch-1 --dry-run
```

## Conductor provider/model selection

This repo dispatches prompts into Conductor workspaces. It does not force the app to use Claude vs Codex. Before dispatch, manually choose Claude Code or Codex in Conductor's model/provider picker.

The skill should remind the user to make that selection before dispatch.

## Post-dispatch runbook

- Watch each Conductor workspace.
- Review diffs.
- Run tests/checks in each workspace.
- Ask the workspace agent to fix failures.
- Human verifies behavior.
- Merge approved branches.
- Only after merge, dispatch the next dependent batch.
- If conflicts appear, resolve and retest before continuing.

## Safety rules

- Never dispatch without human approval of the plan.
- Never claim provider selection was forced.
- Keep parts in the same batch independent.
- Avoid overlapping file scopes in the same batch unless intentionally reviewed.
- Keep merge decisions human-approved unless the user explicitly asks to automate fallback merge flow.
