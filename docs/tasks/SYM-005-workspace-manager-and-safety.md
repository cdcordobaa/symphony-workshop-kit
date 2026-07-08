---
id: SYM-005
title: Workspace Manager And Safety Invariants
milestone: "M1: MVP Walking Skeleton"
priority: 2
estimate: 5
blockedBy: ["SYM-002", "SYM-003"]
blocks: ["SYM-006", "SYM-007"]
parent: null
---

## Summary

Implement the Workspace Manager (Unit 1.4): per-issue sanitized directories under `workspace.root`,
create/reuse, with the **three mandatory safety invariants** enforced (SPEC §9, §15.2). Implements the
SYM-001 `WorkspaceManager` port (Execution layer). These invariants are REQUIRED even though the
Security extension is opted out (D7).

## Scope

### In scope

- Create or reuse a per-issue directory rooted at the normalized absolute `workspace.root`.
- Enforce the three safety invariants as explicit, individually testable checks:
  - **A** — agent subprocess `cwd == workspace path` (asserted before launch; re-checked in SYM-006).
  - **B** — workspace path is contained within the normalized absolute root; reject path escapes.
  - **C** — workspace key sanitized to `[A-Za-z0-9._-]`.

### Out of scope

- `after_create` / `before_remove` hooks + workspace population (deferred — PRD §5.3).
- Startup terminal-workspace cleanup sweep (deferred — PRD §5.3).
- Launching the agent (SYM-006) — this unit only prepares and guards the workspace.

## Deliverables

- `src/workspace/` — manager + the three invariant checks implementing `WorkspaceManager`.

## Acceptance Criteria

- [ ] A per-issue directory is created under `workspace.root`, or reused if it already exists. [FR10]
- [ ] **Safety A:** the resolved workspace path used as agent `cwd` equals the workspace path. [FR11]
- [ ] **Safety B:** a key/path that would escape the normalized absolute root is rejected. [FR12]
- [ ] **Safety C:** a workspace key with characters outside `[A-Za-z0-9._-]` is rejected/sanitized. [FR13]
- [ ] Each invariant has its own unit test (a passing case and a violating case).

## Test Plan

- `npm test` — unit tests per invariant (A/B/C) with positive and negative cases; create-vs-reuse.
- `npm run build` — compiles cleanly.

## Context

- Read `spec/SYMPHONY-SPEC.md` §9 (Workspace Management and Safety) and §15.2.
- PRD §7 (safety MANDATORY despite D7) and §8 (`workspace.root`).
- Source working unit: `aidlc-docs/inception/application-design/unit-of-work.md` → Unit 1.4.
- Repo paths: `src/workspace/`; depends on `ServiceConfig` (SYM-002) and `Logger` (SYM-003).

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Implements FR10–FR13. The three safety invariants are the single most important correctness
  requirement of the MVP gate (PRD §9); keep them as explicit, named checks, not incidental behavior.
