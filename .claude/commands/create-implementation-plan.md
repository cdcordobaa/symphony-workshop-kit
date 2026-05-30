Generate a structured implementation plan from project requirements with decomposed tasks, milestones, dependencies, and acceptance criteria.

Read the full skill at `.agents/skills/create-implementation-plan/SKILL.md` for the complete process, file structure, and task package contract.

Process:
1. Gather context (docs, PRDs, research, repo conventions)
2. Generate/update shared context (AGENTS.md, README.md, docs/architecture.md)
3. Create `docs/tasks/task-package.yaml` manifest
4. Generate one Markdown task file per issue with frontmatter and body sections
5. Generate `docs/tasks/milestones.md` human index
6. Validate completeness (unique IDs, valid references, no cycles, measurable criteria)

After generating, use `/convert-tasks-to-linear` to publish to Linear.

$ARGUMENTS
