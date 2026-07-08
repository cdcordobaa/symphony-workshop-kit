---
id: SYM-004
title: Notion Tracker Client (Read-Only) Via MCP
milestone: "M1: MVP Walking Skeleton"
priority: 2
estimate: 5
blockedBy: ["SYM-002", "SYM-003"]
blocks: ["SYM-007"]
parent: null
---

## Summary

Implement the read-only Notion tracker adapter (Unit 1.3): fetch candidate issues and refresh issue
state via the Notion MCP server, normalizing Notion rows into the SPEC §4 `Issue` model. Implements
the SYM-001 `TrackerClient` port (the Integration layer; D3).

## Scope

### In scope

- `fetch_candidate_issues()` — query the configured Notion board for rows whose Status is in
  `tracker.active_states`.
- Simple state-refresh — re-read the current state of a known issue id.
- Normalization: Notion row → `Issue` (`id, identifier, title, state, priority, labels, blocked_by`).
- Map a Notion "blocked by" relation into `blocked_by[]`; if the board has no such relation, set
  `blocked_by = []` (see Notes).

### Out of scope

- Any tracker **writes** — orchestrator is reader/scheduler only; state/comment writes are the
  agent's job via its own tools (PRD §2, spec §11.5).
- "Running" candidate queries / per-state logic beyond active fetch (deferred — PRD §5.3).
- Non-Notion trackers, `linear_graphql` (permanently out — §5.4).

## Deliverables

- `src/tracker/` — Notion MCP client + row→`Issue` normalizer implementing `TrackerClient`.

## Acceptance Criteria

- [ ] `fetch_candidate_issues()` returns only rows whose Status ∈ `tracker.active_states`. [FR3]
- [ ] State-refresh returns the current state for a known issue id. [FR4]
- [ ] A Notion row normalizes to an `Issue` with all §4 fields populated. [FR5]
- [ ] A "blocked by" relation maps to `blocked_by[]`; absence yields `[]`. [FR5]
- [ ] A transient Notion/MCP failure surfaces as a recoverable error (no crash) so the orchestrator
      can skip the tick. [NFR reliability]
- [ ] `tracker.api_key` is read from resolved config and never logged. [FR21]

## Test Plan

- `npm test` — unit tests with mocked Notion MCP responses: active-state filtering, state-refresh,
  full normalization, blocked-by mapping (present + absent), and error surfacing.
- `npm run build` — compiles cleanly.

## Context

- Read `spec/SYMPHONY-SPEC.md` §11 (Issue Tracker Integration — adapt Linear→Notion) and §4.
- PRD §8 (`tracker.*` config), §10 (data-source vs database id is a Construction detail), D3.
- Source working unit: `aidlc-docs/inception/application-design/unit-of-work.md` → Unit 1.3.
- Repo paths: `src/tracker/`; depends on `ServiceConfig` (SYM-002) and `Logger` (SYM-003).

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Implements FR3, FR4, FR5. The exact Notion "blocked by" property name and the data-source-vs-database
  binding are resolved at implementation time (PRD §10) — keep them behind the `TrackerClient` port so
  the choice does not leak upward.
