---
id: SYM-007
title: Orchestrator, Reconciliation And CLI/Host
milestone: "M1: MVP Walking Skeleton"
priority: 2
estimate: 8
blockedBy: ["SYM-004", "SYM-005", "SYM-006", "SYM-003"]
blocks: []
parent: null
---

## Summary

Implement the integrating spine (Unit 1.7): a single fixed-interval poll loop with eligibility,
sorting, single-authority dispatch, in-memory state, terminal-state reconciliation, and the
`symphony ./WORKFLOW.md` CLI + host lifecycle. Wires together config, tracker, workspace, agent, and
observability into the end-to-end MVP walking skeleton (SPEC §7, §8, §16).

## Scope

### In scope

- One poll loop at `polling.interval_ms` (default 30000) with an **immediate first tick**.
- Eligibility: issue in an active state, **not already running**, within `agent.max_concurrent_agents`
  (global cap only).
- Candidate sort: `priority` then `created_at`.
- Dispatch via single-authority state mutation (no duplicate dispatch); scheduler state in-memory.
- Reconciliation: stop a run when its issue reaches a terminal state.
- CLI entrypoint `symphony ./WORKFLOW.md` + host lifecycle: startup, immediate tick, graceful shutdown.
- Reliability: tracker/refresh failures skip the tick / keep workers; observability-sink failures never
  crash the daemon.

### Out of scope

- Exponential retry/backoff + continuation retries + retry queue (deferred — §5.3).
- Per-state concurrency caps, stall detection (deferred — §5.3).
- Startup terminal-workspace cleanup sweep (deferred — §5.3).
- Persistent scheduler/session DB across restarts (permanently out — §5.4).

## Deliverables

- `src/orchestrator/` — poll loop, eligibility, sort, dispatch, in-memory state, reconciliation.
- `src/cli.ts` — `symphony ./WORKFLOW.md` entrypoint + host lifecycle.
- A sample `WORKFLOW.md` and an end-to-end happy-path slice proving the MVP gate.

## Acceptance Criteria

- [ ] Poll loop runs at `polling.interval_ms`; the first tick fires immediately at startup. [FR6]
- [ ] An active, not-running issue dispatches only while under the global concurrency cap. [FR7]
- [ ] Candidates are processed in `priority` then `created_at` order. [FR8]
- [ ] The same issue is never dispatched twice concurrently (single-authority state). [FR9]
- [ ] A run is stopped once its issue reaches a `terminal_states` value. [FR17]
- [ ] `symphony ./WORKFLOW.md` starts the daemon, ticks immediately, and shuts down gracefully. [FR20]
- [ ] An induced tracker failure skips the tick and the daemon survives. [NFR reliability]
- [ ] **MVP gate:** a real (or fixture) active issue → confined per-issue workspace → one Claude Code
      run → reconciliation stops it at a terminal state — all visible in logs + status line. [PRD §9]

## Test Plan

- `npm test` — unit tests: immediate-first-tick, eligibility, sort order, single-authority dispatch,
  terminal-state reconciliation, tracker-failure-skips-tick.
- End-to-end happy-path slice (fixtures/stubs for Notion + Claude Code) exercising the MVP gate.
- `npm run build` — compiles cleanly.

## Context

- Read `spec/SYMPHONY-SPEC.md` §7 (State Machine), §8 (Polling/Scheduling/Reconciliation), §16
  (Reference Algorithms — startup, tick loop, reconciliation, dispatch map nearly 1:1).
- Source working unit: `aidlc-docs/inception/application-design/unit-of-work.md` → Unit 1.7.
- Repo paths: `src/orchestrator/`, `src/cli.ts`; depends on SYM-002 (config), SYM-004 (tracker),
  SYM-005 (workspace), SYM-006 (agent), SYM-003 (observability).

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Implements FR6, FR7, FR8, FR9, FR17, FR20. This is the largest unit (8 pts) and the last to unblock;
  it is where the walking skeleton becomes demonstrable against the PRD §9 MVP gate.
