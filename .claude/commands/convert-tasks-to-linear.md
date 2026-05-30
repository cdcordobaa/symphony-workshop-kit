Convert a docs/tasks/task-package.yaml planning wave to Linear milestones, issues, sub-issues, and blocker relations.

Read the full skill at `.agents/skills/convert-tasks-to-linear/SKILL.md` for the task package contract and conversion behavior.

Preferred script workflow:

```bash
# Validate
uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py \
  validate --manifest docs/tasks/task-package.yaml

# Preview without writes
uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py \
  dry-run --manifest docs/tasks/task-package.yaml

# Publish
uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py \
  apply --manifest docs/tasks/task-package.yaml --project-slug <slug>
```

$ARGUMENTS
