# Unit-of-Work Story Map — FR → Unit (MVP Walking Skeleton)

> Maps each MVP functional requirement (`requirements.md` §4) to the unit that delivers it, with the
> SPEC section and an acceptance behavior the bridge turns into a checkbox. Safety invariants
> (FR11–FR13) are called out as explicit acceptance checkboxes per PRD §7 / spec §9.5.

## FR → Unit table

| FR | Requirement (short) | Unit | SPEC | Acceptance behavior (→ checkbox) |
|----|--------------------|------|------|----------------------------------|
| FR1 | Load `WORKFLOW.md` (front matter + prompt body) | 1.2 | §5 | Given a valid `WORKFLOW.md`, front matter and prompt body are parsed into a `WorkflowDefinition`. |
| FR2 | Typed config + `$VAR` + path normalization | 1.2 | §6 | Defaults apply; `$VAR` resolves from env; `workspace.root` `~`/`$VAR`/relative → absolute. |
| FR21 | Secrets: `$VAR` indirection, never logged | 1.2 | §15.3 | Missing `tracker.api_key` after resolution is reported as missing; no secret value is ever logged. |
| FR5 | Issue model type (§4) | 1.1 | §4 | `Issue` type exposes `id, identifier, title, state, priority, labels, blocked_by`. |
| FR5 | Notion row → `Issue` normalization | 1.3 | §4, §11 | A Notion row maps to a normalized `Issue`; unknown "blocked by" relation ⇒ `blocked_by = []`. |
| FR3 | `fetch_candidate_issues()` | 1.3 | §11 | Returns only rows whose Status is in `tracker.active_states`. |
| FR4 | Simple state-refresh | 1.3 | §11 | Re-reads and returns the current state of a known issue id. |
| FR6 | Poll loop + immediate first tick | 1.7 | §8 | Loop runs at `polling.interval_ms`; first tick fires immediately at startup. |
| FR7 | Eligibility (active / not running / global cap) | 1.7 | §7, §8 | An active, not-running issue dispatches only while under `agent.max_concurrent_agents`. |
| FR8 | Sort priority → created_at | 1.7 | §8 | Candidates are ordered by priority, then created_at. |
| FR9 | Single-authority dispatch, in-memory state | 1.7 | §7.4, §8.3 | The same issue is never dispatched twice concurrently; state held in memory. |
| FR10 | Per-issue workspace create/reuse | 1.4 | §9 | A per-issue dir is created under `workspace.root`, or reused if present. |
| **FR11** | **Safety A: cwd == workspace** | 1.4 / 1.5 | §9.5, §15.2 | **☐ Before every launch, agent subprocess `cwd` equals the workspace path.** |
| **FR12** | **Safety B: path within root** | 1.4 | §9.5, §15.2 | **☐ Workspace path is within the normalized absolute root; escapes are rejected.** |
| **FR13** | **Safety C: key sanitized** | 1.4 | §9.5, §15.2 | **☐ Workspace key matches `[A-Za-z0-9._-]`; other chars are rejected/sanitized.** |
| FR14 | Launch Claude Code headless, high-trust | 1.5 | §10, D4/D5 | Agent launches via `bash -lc` in the workspace cwd with auto-approve; user-input-required = hard fail. |
| FR15 | Strict prompt rendering (issue + attempt) | 1.5 | §12 | Prompt renders with `issue` + `attempt` bound; a missing binding raises, not silently blanks. |
| FR16 | One turn; success/failure map; events; session_id | 1.5 | §10 | One turn runs; result maps to success/failure; `session_id = "<thread_id>-<turn_id>"` is derived. |
| FR17 | Reconciliation: terminal-state stop | 1.7 | §8 | When an issue reaches a `terminal_states` value, its run is stopped. |
| FR18 | Structured logs with context fields | 1.6 | §13 | Log records carry `issue_id`, `issue_identifier`, `session_id`. |
| FR19 | Terminal status surface | 1.6 | §13 | A status line reflects currently active runs. |
| FR20 | CLI + host lifecycle | 1.7 | §5, §16 | `symphony ./WORKFLOW.md` starts the daemon, ticks immediately, shuts down gracefully. |

## Unit → FR rollup (completeness)

| Unit | FRs owned |
|------|-----------|
| 1.1 | FR5 (type) |
| 1.2 | FR1, FR2, FR21 |
| 1.3 | FR3, FR4, FR5 (normalization) |
| 1.4 | FR10, FR11, FR12, FR13 |
| 1.5 | FR14, FR15, FR16 (+ re-checks FR11 at launch) |
| 1.6 | FR18, FR19 |
| 1.7 | FR6, FR7, FR8, FR9, FR17, FR20 |

All FR1–FR21 are covered. The MVP-gate end-to-end behavior (PRD §9) is verified by the e2e slice in
Unit 1.7.
