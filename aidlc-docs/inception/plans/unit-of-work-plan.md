# Unit-of-Work Plan — MVP Walking Skeleton

> Units Generation Part 1 (Planning). Per the user's minimalism directive, decomposition decisions
> were resolved directly from PRD §5.2 (MVP scope) + §6 (component map) + spec §3.2 (layers) — **no
> open [Answer]: questions**. This file records the approved plan; Part 2 (Generation) executed the
> checkboxes below in the same pass.

## Decomposition decisions (resolved, not asked)

- **Granularity:** one working unit per spec §3.2 layer/component, except prompt rendering (§12) is
  folded into the Agent Runner (1.5) per PRD §5.2, and CLI/host is folded into the Orchestrator spine
  (1.7). → **7 units**.
- **Milestone:** single `Phase 1: MVP Walking Skeleton` (Q1 = B). Deferred set = later `Phase 2`.
- **Ordering:** ports/domain first (1.1), then config + observability (1.2, 1.6), then the three
  swappable adapters (1.3, 1.4, 1.5), then the integrating orchestrator (1.7).

## Generation checklist (Part 2)

- [x] Generate `application-design/unit-of-work.md` (unit definitions + responsibilities + greenfield
  code organization + embedded component map).
- [x] Generate `application-design/unit-of-work-dependency.md` (acyclic dependency matrix + waves).
- [x] Generate `application-design/unit-of-work-story-map.md` (FR → unit, with safety-invariant
  checkboxes).
- [x] Validate unit boundaries and dependencies (DAG confirmed; topological order exists).
- [x] Ensure all FRs (FR1–FR21) are assigned to a unit (coverage table in story-map).
