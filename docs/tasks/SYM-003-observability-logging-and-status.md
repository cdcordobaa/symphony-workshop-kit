---
id: SYM-003
title: Observability — Structured Logging And Terminal Status
milestone: "M1: MVP Walking Skeleton"
priority: 2
estimate: 2
blockedBy: ["SYM-001"]
blocks: ["SYM-004", "SYM-005", "SYM-006", "SYM-007"]
parent: null
---

## Summary

Provide the structured logger and a simple terminal status surface (Unit 1.6) implementing the §13
observability subset — structured logs with required context fields and a status line. No HTTP/JSON
per D2.

## Scope

### In scope

- Structured logger implementing the SYM-001 `Logger` port; every record can carry the required
  context fields `issue_id`, `issue_identifier`, `session_id`.
- Simple terminal status surface (status line) implementing the `StatusSurface` port, reflecting
  currently active runs.
- Redaction discipline: never emit secret values (collaborates with FR21).

### Out of scope

- HTTP server / JSON API / web dashboard (permanently out — D2/§5.4).
- Token/runtime/rate-limit accounting (deferred — PRD §5.3).

## Deliverables

- `src/observability/` — logger + status surface implementing the SYM-001 ports.

## Acceptance Criteria

- [ ] Log records include `issue_id`, `issue_identifier`, and `session_id` context fields. [FR18]
- [ ] Output is structured (machine-parseable, e.g. JSON lines) and human-readable in a terminal.
- [ ] A status line reflects the set of currently active runs. [FR19]
- [ ] No secret values appear in any log output. [FR21]
- [ ] A failing observability sink does not throw into callers (sink failures must not crash callers).

## Test Plan

- `npm test` — unit tests asserting context fields are present, secret redaction, and status-line
  rendering for N active runs.
- `npm run build` — compiles cleanly.

## Context

- Read `spec/SYMPHONY-SPEC.md` §13 (Logging, Status, Observability) — Core rows only.
- Source working unit: `aidlc-docs/inception/application-design/unit-of-work.md` → Unit 1.6.
- Repo paths: `src/observability/`; implements `Logger`/`StatusSurface` ports from SYM-001.

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Implements FR18, FR19. Foundational and small; lands early so the tracker, workspace, agent, and
  orchestrator units can log against a real `Logger`.
