---
id: SYM-004
title: Workspace Manager And Claude Code Agent Runner
milestone: "M2: Integration And Execution"
priority: 2
estimate: 5
blockedBy: ["SYM-001", "SYM-002"]
blocks: ["SYM-005"]
parent: null
---

## Summary

Implement the execution layer: a Workspace Manager that creates sanitized per-issue workspaces with
the spec's mandatory filesystem-safety invariants, and an Agent Runner that launches Claude Code
(headless, high-trust) in that workspace and runs a single turn. Replaces the spec's Codex
app-server (§10) behind an abstract `AgentRunner` interface.

## Scope

### In scope

- Workspace Manager: `workspace_key` = sanitize(identifier) to `[A-Za-z0-9._-]`; path
  `<workspace.root>/<key>`; create if missing / reuse if present; `created_now` flag. (FR-WS-1)
- Mandatory safety invariants (each an explicit acceptance check): (a) agent launches only with
  `cwd == workspace_path`; (b) `workspace_path` is contained within the normalized absolute
  `workspace_root` (reject escapes); (c) sanitized workspace key. (FR-WS-3 a/b/c, NFR-SAFETY)
- Optional `before_run` / `after_run` hooks with `hooks.timeout_ms`, workspace as cwd; `before_run`
  failure aborts the attempt, `after_run` failure is logged and ignored. (FR-WS-2 partial)
- Agent Runner (abstract interface; Claude Code concrete adapter): launch Claude Code headless via
  `bash -lc <agent.command>` in workspace cwd. (FR-AG-1, FR-AG-2)
- High-trust posture: auto-approve command execution and file changes for the session; treat
  user-input-required as a hard failure; unsupported tool calls fail without stalling. (FR-AG-6)
- Build the per-turn prompt via U1's strict renderer (`issue` + `attempt`); run a single turn;
  derive session/thread/turn ids, emit `session_id`; forward basic events (`session_started`,
  `turn_completed`, `turn_failed`, `startup_failed`); map errors to normalized categories.
  (FR-AG-3, FR-AG-4, FR-AG-5, FR-PR-1, FR-PR-2)
- On any error, fail the attempt and let the orchestrator handle it. (§10.7)

### Out of scope

- Multi-turn continuation up to `max_turns` (deferred FR-OR-9 / §16.5) — MVP runs one turn.
- `after_create` / `before_remove` hooks and workspace population (deferred FR-WS-2 rest, FR-WS-4).
- Token/rate-limit extraction from agent events (deferred FR-OB-3).

## Deliverables

- `src/workspace/manager.ts` (create/reuse, sanitization, containment checks, hooks).
- `src/agent/runner.ts` (abstract `AgentRunner` + Claude Code adapter, single-turn execution).
- Event types forwarded to the orchestrator.

## Acceptance Criteria

- [ ] Workspace path is `<root>/<sanitized_identifier>`; created when missing, reused when present;
      `created_now` reflects fresh creation. (FR-WS-1)
- [ ] **Invariant (a):** the agent subprocess is launched only when `cwd === workspace_path`;
      otherwise the attempt fails. (FR-WS-3a)
- [ ] **Invariant (b):** a `workspace_path` that resolves outside `workspace_root` is rejected before
      launch. (FR-WS-3b)
- [ ] **Invariant (c):** identifiers with characters outside `[A-Za-z0-9._-]` are sanitized to `_`.
      (FR-WS-3c)
- [ ] Claude Code is launched headless via `bash -lc <agent.command>` in the workspace; high-trust
      auto-approves commands/file-changes; user-input-required ⇒ hard failure. (FR-AG-1, FR-AG-6)
- [ ] Prompt is rendered with `issue` + `attempt`; a render failure fails the attempt. (FR-PR-1,2)
- [ ] One turn runs; `session_id = <thread_id>-<turn_id>` is emitted; success/failure/timeout map to
      the correct outcome and forwarded events. (FR-AG-3, FR-AG-4)
- [ ] `before_run` failure aborts the attempt; `after_run` failure is logged and ignored. (FR-WS-2)

## Test Plan

- `npm test`: workspace sanitization + containment rejection (path traversal cases); `created_now`
  semantics; high-trust launch builds the expected `bash -lc` invocation with cwd; single-turn
  success/failure/timeout mapping; prompt-render-failure path; hook failure semantics. Use a fake
  agent process for determinism.
- `npm run build` passes.

## Context

- Read `spec/SYMPHONY-SPEC.md` §9 (Workspace + safety invariants), §10 (Agent Runner protocol),
  §12 (prompt), §15.2 (filesystem safety).
- Read `aidlc-docs/inception/requirements/requirements.md` §4.5–§4.6 and §6.1.1 (MVP slice).
- Read `aidlc-docs/inception/application-design/unit-of-work.md` → U4.
- Depends on U1 (`AgentRunner`/`WorkspaceManager` interfaces, renderer, config) and U2 (logger).
  Repo paths: `src/workspace/`, `src/agent/`.

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- The three safety invariants are non-negotiable and remain in scope even though the SECURITY
  extension was opted out (spec §9.5/§15.2 are core, not extension).
- Inference: Claude Code headless flags for non-interactive + auto-approve are resolved at
  implementation time; keep them behind `agent.command` / config so they are not hard-coded.
