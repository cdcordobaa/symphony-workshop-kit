---
id: SYM-002
title: Observability — Structured Logs And Terminal Status
milestone: "M1: Foundation And Contracts"
priority: 2
estimate: 2
blockedBy: ["SYM-001"]
blocks: ["SYM-003", "SYM-004", "SYM-005"]
parent: null
---

## Summary

Provide the observability primitives every other unit depends on: a structured logger with the
spec-required context fields and a simple terminal status surface rendered from orchestrator state.
No HTTP server, no JSON API, no web dashboard.

## Scope

### In scope

- Structured logger: stable `key=value` phrasing; REQUIRED context fields `issue_id` and
  `issue_identifier` on issue logs, `session_id` on session-lifecycle logs; include action outcome
  (`completed`/`failed`/`stopped`) and concise failure reason. (FR-OB-1)
- Never log API tokens or secret env values; truncate hook/agent output in logs. (NFR-SECRETS,
  NFR-HOOK-SAFETY)
- Operator-visible startup/validation/dispatch failures without a debugger; a failing log sink
  should not crash the service. (FR-OB-2)
- Simple terminal status surface (`renderStatus(state)`) drawn from orchestrator state only (running
  issues + counts); MUST NOT be required for correctness. (FR-OB-4)

### Out of scope

- Token/runtime accounting + rate-limit tracking (deferred FR-OB-3).
- HTTP server, JSON REST API, web dashboard (out of scope, §13.7).

## Deliverables

- `src/obs/log.ts` (structured logger + sink abstraction).
- `src/obs/status.ts` (`renderStatus` terminal surface).

## Acceptance Criteria

- [ ] Issue logs always include `issue_id` and `issue_identifier`; session logs include
      `session_id`. (FR-OB-1)
- [ ] Secret values and tokens never appear in log output; long hook/agent output is truncated.
      (NFR-SECRETS)
- [ ] Startup/validation/dispatch failures are emitted to an operator-visible sink. (FR-OB-2)
- [ ] A sink that throws does not crash the process; the service continues via remaining sink(s).
      (FR-OB-2)
- [ ] `renderStatus` produces a readable terminal summary purely from passed-in orchestrator state.
      (FR-OB-4)

## Test Plan

- `npm test` (logger emits required context fields; secret redaction; sink-failure resilience;
  `renderStatus` snapshot of a sample state).
- `npm run build` passes.

## Context

- Read `spec/SYMPHONY-SPEC.md` §13.1–§13.4 and §15.3 (secret handling).
- Read `aidlc-docs/inception/application-design/unit-of-work.md` → U5.
- Depends on U1 domain/state types (`SYM-001`). Repo path: `src/obs/`.

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Kept small and foundational so U2/U3/U4 can log from the start. Token/rate-limit accounting
  (FR-OB-3) is deferred and will extend `src/obs/` later.
