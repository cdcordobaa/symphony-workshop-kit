Bridge AI-DLC working units into the `docs/tasks/task-package.yaml` format that
`convert-tasks-to-linear` publishes to Linear.

Read the full skill at `.agents/skills/aidlc-to-tasks/SKILL.md` for the field-mapping table and the
validator-gated process.

Inputs (must already exist from AI-DLC Units Generation):
- `aidlc-docs/inception/application-design/unit-of-work.md`
- `aidlc-docs/inception/application-design/unit-of-work-dependency.md`
- `aidlc-docs/inception/application-design/unit-of-work-story-map.md`
- `aidlc-docs/inception/requirements/requirements.md`

Process:
1. Read the AI-DLC artifacts + `spec/reading-guide.md`; build the unit list.
2. Derive milestones from AI-DLC phases; assign `SYM-NNN` ids in order.
3. Write `docs/tasks/task-package.yaml`.
4. (Optional) scaffold stubs: `python3 .agents/skills/aidlc-to-tasks/scripts/scaffold_tasks.py --manifest docs/tasks/task-package.yaml`
5. Fill each task file per the mapping table; write `docs/tasks/milestones.md`.
6. Validate (the gate): `uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py validate --manifest docs/tasks/task-package.yaml` — loop generate→validate→fix until it exits 0.

After generating, use `/convert-tasks-to-linear` to publish to Linear.

$ARGUMENTS
