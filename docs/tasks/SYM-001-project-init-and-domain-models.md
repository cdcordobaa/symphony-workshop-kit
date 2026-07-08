---
id: SYM-001
title: Project Initialization And Core Domain Models
milestone: "M1: MVP Walking Skeleton"
priority: 1
estimate: 3
blockedBy: []
blocks: ["SYM-002", "SYM-003"]
parent: null
---

## Summary

Scaffold the TypeScript/Node.js project and define the SPEC §4 core domain model plus the port
interfaces every later unit depends on. This is the unblocked root of the MVP walking skeleton
(Unit 1.1) — nothing else can build until the types and ports exist.

## Scope

### In scope

- TypeScript project scaffold: `package.json`, `tsconfig.json`, lint/format placeholders, and a
  `build` + `test` script wiring (tests may be placeholders that run green).
- SPEC §4 domain types in `src/domain/`:
  - `Issue` — `{ id, identifier, title, state, priority, labels, blocked_by }`.
  - `WorkflowDefinition`, `ServiceConfig`, `Workspace`, `RunAttempt`, `OrchestratorState`.
- Port interfaces consumed by adapter/coordination units: `TrackerClient`, `WorkspaceManager`,
  `AgentRunner`, `Logger`, `StatusSurface`.

### Out of scope

- Any concrete implementation behind the ports (delivered by SYM-002…SYM-007).
- Deferred §5.3 model fields (retry entries, live-session accounting) — added on the later
  Core Conformance pass.
- Test-framework finalization (vitest vs `node:test`) — a Construction decision (PRD §10).

## Deliverables

- `package.json`, `tsconfig.json` with `npm run build` and `npm test` working.
- `src/domain/` types for the eight §4 entities.
- `src/domain/ports.ts` (or equivalent) with the five port interfaces above.

## Acceptance Criteria

- [ ] `npm run build` compiles with no type errors.
- [ ] `npm test` runs and exits 0 (placeholder tests acceptable).
- [ ] `Issue` exposes exactly `id, identifier, title, state, priority, labels, blocked_by`.
- [ ] All five port interfaces (`TrackerClient`, `WorkspaceManager`, `AgentRunner`, `Logger`,
      `StatusSurface`) are exported and reference only domain types (no concrete deps).
- [ ] No business logic lives in `src/domain/` — types and interfaces only.

## Test Plan

- `npm run build` — TypeScript compiles cleanly.
- `npm test` — green (placeholder ok at this stage).
- Type-level check: a throwaway file importing each port + `Issue` compiles.

## Context

- Read `spec/SYMPHONY-SPEC.md` §4 (Core Domain Model) and §3.2 (layer boundaries).
- Source working unit: `aidlc-docs/inception/application-design/unit-of-work.md` → Unit 1.1.
- Requirements: `aidlc-docs/inception/requirements/requirements.md` (FR5; D6 TypeScript/Node).
- Repo paths to create: `src/domain/`, `package.json`, `tsconfig.json`.

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Ports-first so adapter units depend on abstractions, preserving §3.2 boundaries and the
  swappability goal (PRD §2). Implements FR5 (the `Issue` type); Notion→`Issue` normalization is
  SYM-004's responsibility.
