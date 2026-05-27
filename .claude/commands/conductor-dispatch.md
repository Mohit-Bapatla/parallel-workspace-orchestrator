You are running the conductor-dispatch workflow.

Follow the skill instructions in `.claude/skills/conductor-dispatch/SKILL.md`.

Turn the user's grand spec into a reviewed batched AWO plan, write the approved plan to `.awo/plans`, ask for approval before dispatch, then dispatch the approved batch with `npm run conductor:dispatch`.

If the user did not provide a grand spec, ask for one before planning.
