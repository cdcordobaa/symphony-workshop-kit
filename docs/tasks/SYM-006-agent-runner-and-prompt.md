---
id: SYM-006
title: Agent Runner (Claude Code) And Prompt Rendering
milestone: "M1: MVP Walking Skeleton"
priority: 2
estimate: 5
blockedBy: ["SYM-002", "SYM-005", "SYM-003"]
blocks: ["SYM-007"]
parent: null
---

## Summary

Implement the Agent Runner (Unit 1.5): render a strict prompt from `issue` + `attempt`, launch Claude
Code headless (high-trust) in the workspace cwd, run one turn, map success/failure, and forward basic
events. Implements the SYM-001 `AgentRunner` port (Execution layer; D4/D5, SPEC §10 + §12).

## Scope

### In scope

- Strict prompt rendering binding `issue` + `attempt` context; a missing binding fails loudly.
- Launch Claude Code headless via `bash -lc` using `agent.command`, with `cwd` = the SYM-005
  workspace path; re-assert safety invariant A (cwd) immediately before spawn.
- High-trust posture: auto-approve commands/file changes; a user-input-required prompt is a **hard
  failure** (D5).
- Run exactly one turn; map process result to success/failure; forward basic events to observability;
  derive `session_id = "<thread_id>-<turn_id>"`.

### Out of scope

- Multi-turn continuation up to `max_turns`, continuation retries, retry queue/backoff (deferred — §5.3).
- Stall detection, token/runtime/rate-limit accounting (deferred — §5.3).
- Tracker writes (the agent performs state/comment updates via its own tools — spec §11.5).

## Deliverables

- `src/agent/` — prompt renderer + Claude Code subprocess runner implementing `AgentRunner`.

## Acceptance Criteria

- [ ] Prompt renders with `issue` + `attempt` bound; a missing binding raises (no silent blanks). [FR15]
- [ ] Agent launches via `bash -lc` with `cwd` equal to the workspace path. [FR14]
- [ ] **Safety A re-checked:** launch is refused if `cwd` ≠ workspace path. [FR11]
- [ ] High-trust auto-approve is applied; a user-input-required condition maps to a hard failure. [FR14/D5]
- [ ] Exactly one turn runs; result maps to success or failure. [FR16]
- [ ] `session_id = "<thread_id>-<turn_id>"` is derived and forwarded to logs. [FR16]

## Test Plan

- `npm test` — unit tests with a stubbed subprocess: prompt binding (success + missing-binding raise),
  cwd assertion, success/failure mapping, `session_id` derivation, user-input-required → hard fail.
- `npm run build` — compiles cleanly.

## Context

- Read `spec/SYMPHONY-SPEC.md` §10 (Agent Runner Protocol — adapt Codex→Claude Code) and §12 (Prompt
  Construction). PRD §10 (headless flags) and D4/D5.
- Source working unit: `aidlc-docs/inception/application-design/unit-of-work.md` → Unit 1.5.
- Repo paths: `src/agent/`; depends on `ServiceConfig` (SYM-002), `WorkspaceManager` (SYM-005),
  `Logger` (SYM-003), and domain types (SYM-001).

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Implements FR14, FR15, FR16; re-checks FR11 at launch. Exact Claude Code headless flags (non-
  interactive + auto-approve) and event-stream shape for `session_id` derivation resolved at
  implementation (PRD §10), kept behind the `AgentRunner` port.
