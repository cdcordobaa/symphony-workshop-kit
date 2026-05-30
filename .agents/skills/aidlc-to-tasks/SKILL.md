---
name: aidlc-to-tasks
description: |
  Bridge AI-DLC Units Generation output into the deterministic
  docs/tasks/task-package.yaml + task-file format consumed by
  convert-tasks-to-linear. Use after AI-DLC INCEPTION has produced
  working units (aidlc-docs/inception/application-design/unit-of-work*.md)
  and before publishing to Linear.
---

# AI-DLC → Task Package Bridge

## Purpose

AI-DLC's *Units Generation* stage produces semi-structured working units in `aidlc-docs/`. Those
units describe **what to build**, but they are not in a shape any tool can publish to Linear.
`convert-tasks-to-linear` requires a strict `docs/tasks/task-package.yaml` manifest plus one
Markdown file per task with required frontmatter and body sections.

This skill is the missing bridge. It reads the AI-DLC artifacts and emits a valid task package,
then uses the existing `convert-tasks-to-linear` validator as the correctness gate. It introduces
**no new validation logic** — the converter's `validate` command is the source of truth.

```
aidlc-docs/inception/application-design/unit-of-work.md
aidlc-docs/inception/application-design/unit-of-work-dependency.md
aidlc-docs/inception/application-design/unit-of-work-story-map.md
aidlc-docs/inception/requirements/requirements.md
            │
            ▼  (this skill)
docs/tasks/task-package.yaml + docs/tasks/SYM-NNN-*.md + docs/tasks/milestones.md
            │
            ▼  (/convert-tasks-to-linear)
Linear milestones + issues + sub-issues + blocker relations
```

## When to use

Run this **once** after the user has approved AI-DLC Units Generation, when these inputs exist:

- `aidlc-docs/inception/application-design/unit-of-work.md` — the working units.
- `aidlc-docs/inception/application-design/unit-of-work-dependency.md` — the dependency matrix.
- `aidlc-docs/inception/application-design/unit-of-work-story-map.md` — FR → unit mapping.
- `aidlc-docs/inception/requirements/requirements.md` — scope, tech stack, NFRs.

If any are missing, stop and tell the user to complete AI-DLC Units Generation first.

## Required output (the contract you must satisfy)

The target format is defined authoritatively by
`.agents/skills/create-implementation-plan/SKILL.md`. Conform to it exactly. In short:

`docs/tasks/task-package.yaml`:

```yaml
planningWave: symphony-from-scratch
tasksDir: docs/tasks
milestones:
  - "M1: Foundation And Contracts"
  - "M2: Integration And Environment"
tasks:
  - id: SYM-001
    file: docs/tasks/SYM-001-project-init-and-domain-models.md
```

Each task file frontmatter:

```yaml
---
id: SYM-001
title: Project Initialization And Core Domain Models
milestone: "M1: Foundation And Contracts"
priority: 2
estimate: 3
blockedBy: []
blocks: ["SYM-002"]
parent: null
---
```

Each task file body MUST contain these sections (see create-implementation-plan for the template):
`## Summary`, `## Scope` (In/Out), `## Deliverables`, `## Acceptance Criteria`, `## Test Plan`,
`## Context`, `## Definition of Ready`, `## Notes`.

## Field-mapping table (AI-DLC → task package)

Apply these deterministic rules. Where a source value is missing, infer conservatively from the
SPEC section the unit implements and note the inference in `## Notes`.

| Source (AI-DLC artifact) | → | Target field / section |
|---|---|---|
| Each working unit (e.g. "Unit 2.1 Workspace Manager") | → | one task file + one `tasks:` entry. `id: SYM-NNN` in unit order (Phase.Unit → sequential). |
| Unit title | → | `title:` (Title Case, no "Unit N.N" prefix). |
| AI-DLC phase heading (e.g. "Phase 2: Integration & Environment") | → | `milestone:` value AND an entry in top-level `milestones:`. Use `"M<phase#>: <Phase Name>"`. |
| Unit ordering within a phase + cross-phase deps | → | `priority:` (1=Urgent for foundational/blocking units, 2=High for core path, 3=Normal otherwise). |
| Unit size / complexity in `unit-of-work.md` | → | `estimate:` (story points: 1/2/3/5/8). |
| `unit-of-work-dependency.md` matrix ("X depends on Y") | → | `blockedBy:` on X includes Y; mirror as `blocks:` on Y. Keep the graph acyclic. |
| Unit "is a sub-component of" relationship (if any) | → | `parent:` (else `null`). Most units are top-level. |
| Unit responsibilities / description | → | `## Summary` + `## Scope` (In scope = listed responsibilities; Out of scope = explicitly deferred items / non-goals from SPEC §2). |
| Unit "key symbols" / deliverable artifacts | → | `## Deliverables`. |
| `unit-of-work-story-map.md` rows (FR → this unit) + BDD specs | → | `## Acceptance Criteria` (one measurable checkbox per FR/behavior). Add a checkbox for each relevant SPEC safety invariant (e.g. §9 cwd confinement). |
| `requirements.md` tech stack + chosen test framework | → | `## Test Plan` (concrete build/test commands, e.g. `npm test`, `cargo test`) and `## Context` (repo paths, the SPEC section to read). |
| SPEC section the unit implements | → | cite in `## Context` (e.g. "Read `spec/SYMPHONY-SPEC.md` §9 Workspace Management"). |
| Always | → | `## Definition of Ready` (the 3 standard checkboxes) and `## Notes` (record any inference you made). |

## Process

1. **Read** all four AI-DLC inputs and `spec/reading-guide.md`. Build an in-memory list of units
   with: id, title, phase/milestone, dependencies, responsibilities, mapped FRs, SPEC section.
2. **Derive milestones** from the AI-DLC phases, in order. Write the `milestones:` list.
3. **Assign `SYM-NNN` ids** in phase-then-unit order (SYM-001, SYM-002, …). Keep a unit→id map so
   dependency edges resolve to ids.
4. **Write `docs/tasks/task-package.yaml`** with the manifest (planningWave, tasksDir, milestones,
   tasks).
5. **(Optional) Scaffold stubs** to save typing — generates empty task files with correct
   frontmatter + section headers from the manifest:
   ```bash
   python3 .agents/skills/aidlc-to-tasks/scripts/scaffold_tasks.py --manifest docs/tasks/task-package.yaml
   ```
   The script never overwrites an existing task file. It only creates missing stubs.
6. **Fill every task file** body using the mapping table. Acceptance criteria must be measurable;
   Test Plan must name real commands for the chosen stack.
7. **Write `docs/tasks/milestones.md`** (human index) using the same milestone names.
8. **Validate (the gate).** Run the converter's validator and fix every error before proceeding:
   ```bash
   uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py \
     validate --manifest docs/tasks/task-package.yaml
   ```
   Loop *generate → validate → fix* until it exits 0 (unique ids, all refs resolve, no cycles,
   all required sections present).
9. **Dry-run** to preview the Linear projection:
   ```bash
   uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py \
     dry-run --manifest docs/tasks/task-package.yaml
   ```
10. **Hand off.** Tell the user to review `task-package.yaml` + `milestones.md`, then run
    `/convert-tasks-to-linear` to publish.

## Rules

- Do **not** invent units that have no basis in the AI-DLC artifacts or the SPEC. One working unit
  → one task (split only if a unit clearly contains two independently-shippable deliverables, and
  record the split in `## Notes`).
- Keep the dependency graph acyclic. If the AI-DLC matrix implies a cycle, break it and flag it for
  the user.
- The validator is authoritative. Never report success while `validate` is failing.
- Update `aidlc-docs/aidlc-state.md` BRIDGE checkboxes and append an `audit.md` entry when done.

## Next step

`/convert-tasks-to-linear` — validate, dry-run, and `apply --project-slug <slug>` to publish the
wave to Linear. Then start the OpenSymphony engine (see `engine/engine-setup.md`).
