---
id: SYM-005
title: Orchestrator Core — Poll, Dispatch And Reconcile
milestone: "M3: Orchestration Core"
priority: 2
estimate: 5
blockedBy: ["SYM-001", "SYM-002", "SYM-003", "SYM-004"]
blocks: []
parent: null
---

## Summary

Implement the coordination layer that turns the pieces into a runnable walking skeleton: a
single-authority poll loop that fetches Notion candidates, selects an eligible issue, dispatches a
Claude Code worker in a sanitized workspace, and reconciles on terminal state. This is the
integrating unit (U3) — completing it yields the end-to-end MVP.

## Scope

### In scope

- Single authoritative in-memory state: `running`, `claimed`, `completed`, effective poll interval,
  global concurrency. (FR-DM-3, FR-OR-1)
- Poll tick: basic reconcile → preflight validation (U1) → `fetchCandidateIssues` (U2) → sort →
  dispatch while global slots remain → render status (U2/U5) → reschedule at `polling.interval_ms`;
  immediate first tick at startup. (FR-OR-2, NFR-PERF, §16.2)
- Eligibility: has id/identifier/title/state; state ∈ active and ∉ terminal; not already
  running/claimed; global slot free; `Todo` with a non-terminal blocker is ineligible. (FR-OR-3)
- Dispatch sort: priority ascending (null last) → `created_at` oldest → `identifier`. (FR-OR-4)
- Global concurrency: `available = max(max_concurrent_agents - running, 0)`. (FR-OR-5 global)
- Dispatch one issue → spawn worker (U4 Agent Runner + Workspace Manager), record running entry, set
  claimed. (§16.4)
- Basic reconciliation: refresh running issue states (U2); terminal ⇒ stop worker + request
  workspace cleanup; still-active ⇒ update snapshot; refresh failure ⇒ keep workers. (FR-OR-8 Part B)
- Worker exit: remove running entry; MVP simply lets the issue be re-picked on the next poll (no
  retry timer). Graceful degradation: validation failure ⇒ skip dispatch, keep reconciling; tracker
  failure ⇒ skip tick. (NFR-RELIABILITY, NFR-RECOVERY)

### Out of scope

- Exponential retry/backoff, retry queue, continuation retries (deferred FR-OR-6, FR-OR-7).
- Per-state concurrency caps (deferred FR-OR-5 per-state).
- Stall detection (deferred FR-OR-8 Part A).
- Multi-turn continuation up to `max_turns` (deferred FR-OR-9).
- Startup terminal workspace cleanup (deferred FR-OR-10).

## Deliverables

- `src/orchestrator/state.ts` (runtime state model + single-authority mutations).
- `src/orchestrator/loop.ts` (poll tick, eligibility, sort, dispatch, reconcile).
- Wiring in `src/index.ts` to start the daemon end-to-end.

## Acceptance Criteria

- [ ] Startup schedules an immediate first tick, then repeats every `polling.interval_ms`. (FR-OR-2,
      NFR-PERF)
- [ ] Each tick reconciles running issues before dispatch; a per-tick validation failure skips
      dispatch but still reconciles. (FR-OR-2, NFR-RELIABILITY)
- [ ] Eligibility excludes running/claimed issues, terminal/non-active states, and `Todo` issues with
      a non-terminal blocker. (FR-OR-3)
- [ ] Dispatch order is priority → oldest `created_at` → `identifier`. (FR-OR-4)
- [ ] No more than `max_concurrent_agents` workers run concurrently; state mutation is
      single-authority (no duplicate dispatch of the same issue). (FR-OR-5, NFR-CONCURRENCY)
- [ ] On reconcile, a now-terminal running issue stops its worker and cleans its workspace; a
      still-active issue updates the snapshot; a refresh failure keeps workers running. (FR-OR-8)
- [ ] End-to-end: with a fixture Notion candidate, the daemon creates a sanitized workspace, launches
      Claude Code once (high-trust), and logs the outcome. (MVP success criterion)

## Test Plan

- `npm test`: eligibility + blocker rule; sort order; global slot accounting + no duplicate
  dispatch; reconcile transitions (terminal/active/refresh-failure); tick scheduling with a fake
  clock; end-to-end with mocked TrackerClient (U2) + fake AgentRunner (U4).
- `npm run build` passes.
- (Manual) run the daemon against a test Notion board + a throwaway workspace root and observe one
  full poll→dispatch→reconcile cycle in the terminal status + logs.

## Context

- Read `spec/SYMPHONY-SPEC.md` §7 (state machine), §8 (polling/scheduling/reconciliation), §16
  (reference algorithms 16.2–16.4).
- Read `aidlc-docs/inception/requirements/requirements.md` §4.4 and §6.1.1 (MVP slice).
- Read `aidlc-docs/inception/application-design/unit-of-work.md` → U3 and
  `unit-of-work-dependency.md` (this is the final integration unit).
- Depends on U1 (state/config/validation), U2 tracker (`SYM-003`), U4 workspace+agent (`SYM-004`),
  U5 observability (`SYM-002`). Repo path: `src/orchestrator/`.

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- This unit deliberately omits the retry queue; the deferred retry/backoff/continuation/stall items
  (FR-OR-6,7,9 / FR-OR-8 Part A) extend this module on the path to full Core Conformance.
- "Clean workspace on terminal" reuses U4's workspace removal; full startup terminal sweep
  (FR-OR-10) is deferred.
