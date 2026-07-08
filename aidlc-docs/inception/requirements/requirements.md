# Requirements — Symphony Orchestrator (Run 2, MVP-first)

> **Stage:** INCEPTION → Requirements Analysis (Standard depth)
> **Sources:** `spec/SYMPHONY-SPEC.md` (canonical) + `spec/PRD.md` (locked variant decisions D1–D8).
> **Scope decision (Q1 = B):** decompose & publish **only the MVP walking skeleton** this pass;
> the Deferred / full Core Conformance set (PRD §5.3) is re-run through INCEPTION later.

## 1. Intent analysis

- **User request:** "Start the AI-DLC INCEPTION specification using the PRD as input; make as few
  questions as possible and follow the spec as closely as possible; go with backlog option B and
  generate the first work units to progress on ASAP."
- **Request type:** New Project (greenfield).
- **Scope estimate:** System-wide (a single long-running daemon, 8 components across 6 layers).
- **Complexity estimate:** Moderate–Complex (concurrency, subprocess control, filesystem safety),
  but de-risked because the PRD locks the stack and the MVP slice is explicitly enumerated.

## 2. Locked variant decisions (constraints, not under discussion — PRD §3 / D1–D8)

| # | Decision | Choice |
|---|---|---|
| D1 | Conformance target | Core Conformance only; **MVP walking skeleton first** |
| D2 | Observability | Structured logs + simple terminal status (no HTTP/JSON/web) |
| D3 | Tracker | Notion databases via the Notion MCP server |
| D4 | Agent | Claude Code headless behind an abstract Agent Runner |
| D5 | Approval posture | High-trust (auto-approve; user-input-required = hard failure) |
| D6 | Language | TypeScript / Node.js |
| D7 | Security extension | Opted OUT (safety invariants §9.5/§15.2 remain REQUIRED) |
| D8 | Pipeline | All-Notion; Linear bridge & Rust engine out of *target* scope |

## 3. MVP scope (this pass) — derived from PRD §5.2

**IN (happy path only):** CLI + `WORKFLOW.md` loader + minimal typed config (defaults + `$VAR`);
read-only Notion tracker via MCP (candidate fetch + simple state-refresh, normalized to the §4 issue
model); simple orchestrator (one fixed-interval poll loop, eligibility on active-state/not-running/
global-concurrency, sort priority→created_at, dispatch, in-memory state); Workspace Manager (per-issue
sanitized dir, create/reuse, **3 safety invariants**); Agent Runner (Claude Code headless, high-trust,
launch in workspace cwd, strict prompt render with `issue`+`attempt`, one turn, success/failure map,
basic event forwarding); observability (structured logs + status line); reconciliation (terminal-state
stop only).

**OUT (this pass — deferred to PRD §5.3 / re-run):** dynamic `WORKFLOW.md` watch/reload; exponential
retry/backoff + continuation retries + retry queue; per-state concurrency caps; stall detection;
multi-turn continuation up to `max_turns`; startup terminal workspace cleanup; token/runtime/rate-limit
accounting; `after_create`/`before_remove` hooks + workspace population. **Permanently out (PRD §5.4):**
Linear tracker, the kit's `/convert-tasks-to-linear` as a *target* feature, the Rust engine/Codex,
HTTP server / JSON REST API / web dashboard, `linear_graphql`, SSH Worker Extension, persistent DBs,
orchestrator tracker-write APIs, non-Notion trackers, any GUI.

## 4. Functional requirements (MVP)

Each FR cites the SPEC section it derives from and is mapped to a working unit in
`../application-design/unit-of-work-story-map.md`.

| FR | Requirement | SPEC |
|----|-------------|------|
| FR1 | Select a workflow path from the CLI and load `WORKFLOW.md` (YAML front matter + Markdown prompt body). | §5 |
| FR2 | Parse typed config with defaults; resolve `$VAR` indirection; normalize paths (`workspace.root` supports `~`/`$VAR`/relative). | §6 |
| FR3 | Notion tracker `fetch_candidate_issues()` returns issues currently in an active state. | §11 (adapted) |
| FR4 | Notion tracker simple state-refresh re-reads the current state of a known issue. | §11 (adapted) |
| FR5 | Normalize a Notion row into the §4 Issue model: `id, identifier, title, state, priority, labels, blocked_by`. | §4, §11 |
| FR6 | Orchestrator runs one poll loop at `polling.interval_ms` (default 30000) with an **immediate first tick**. | §8 |
| FR7 | Eligibility: issue is in an active state, is **not already running**, and global concurrency cap not exceeded. | §7, §8 |
| FR8 | Candidate ordering: sort by `priority` then `created_at`. | §8 |
| FR9 | Dispatch via **single-authority state mutation** (no duplicate dispatch); scheduler state is in-memory. | §7.4, §8.3 |
| FR10 | Workspace Manager creates/reuses a per-issue directory under the normalized `workspace.root`. | §9 |
| FR11 | **Safety invariant A** — agent subprocess `cwd == workspace path` (explicit check before every launch). | §9.5, §15.2 |
| FR12 | **Safety invariant B** — workspace path is contained within the normalized absolute workspace root (reject escapes). | §9.5, §15.2 |
| FR13 | **Safety invariant C** — workspace key sanitized to `[A-Za-z0-9._-]`. | §9.5, §15.2 |
| FR14 | Agent Runner launches Claude Code headless via `bash -lc` in the workspace cwd, high-trust (auto-approve). | §10 (adapted), D4/D5 |
| FR15 | Strict prompt rendering binds `issue` + `attempt` context; missing bindings fail loudly. | §12 |
| FR16 | Agent Runner runs one turn, maps success/failure, forwards basic events; derives `session_id = "<thread_id>-<turn_id>"`. | §10 |
| FR17 | Reconciliation stops a run when its issue reaches a terminal state (no stall detection in MVP). | §8 |
| FR18 | Structured logs include required context fields: `issue_id`, `issue_identifier`, `session_id`. | §13 |
| FR19 | Simple terminal status surface (status line) reflects active runs. | §13 |
| FR20 | CLI entrypoint `symphony ./WORKFLOW.md` + host lifecycle (startup, immediate tick, graceful shutdown). | §5, §16 |
| FR21 | Secrets handling: `$VAR` indirection; never log tokens/secret values; validate presence without printing. | §15.3 |

## 5. Non-functional requirements (cross-cutting — PRD §7)

- **Safety (MANDATORY despite D7):** FR11–FR13 enforced before *every* agent launch; each an explicit
  acceptance checkbox in the owning unit.
- **Secrets:** FR21 — `$VAR` indirection, never log secret values.
- **Reliability:** transient tracker/refresh failures degrade gracefully (skip tick / keep workers);
  dispatch-validation failures keep the daemon alive; observability-sink failures never crash it.
- **Recovery:** in-memory scheduler state only; restart recovery is tracker- + filesystem-driven
  (fresh polling, re-dispatch). Retry timers / live sessions not restored. *(Full startup cleanup is
  deferred — PRD §5.3.)*
- **Concurrency:** bounded **global** only in MVP (per-state caps deferred); single-authority state
  mutation prevents duplicate dispatch.
- **Performance:** fixed poll cadence (`polling.interval_ms`, default 30000); immediate first tick.
- **Portability/simplicity:** keep tracker and agent backends behind interfaces so deferred items and
  alternate backends slot in without rework (preserve §3.2 layer boundaries).

## 6. Configuration contract (Notion variant — PRD §8)

`tracker.kind: notion`; `tracker.database` (Notion board database/data-source id); `tracker.api_key`
(literal or `$VAR`); `tracker.active_states` (default `["Todo","In Progress"]`);
`tracker.terminal_states` (default `["Closed","Cancelled","Canceled","Duplicate","Done"]`);
`polling.interval_ms` (30000); `workspace.root` (`<system-temp>/symphony_workspaces`);
`hooks.*` + `hooks.timeout_ms` (60000, **defined but unused in MVP**); `agent.command` (Claude Code
headless via `bash -lc`); `agent.max_concurrent_agents` (10), `agent.max_turns` (20, **MVP runs 1
turn**), `agent.max_retry_backoff_ms` (300000, **deferred**), `agent.max_concurrent_agents_by_state`
(`{}`, **deferred**), `agent.turn_timeout_ms` (3600000), `agent.read_timeout_ms` (5000),
`agent.stall_timeout_ms` (300000, **deferred**).

## 7. Assumptions resolved from PRD/spec (no questions asked, per user directive)

- Active/terminal **state values** = PRD §8 defaults, operator-overridable in `WORKFLOW.md`.
- `blocked_by` is normalized from a Notion "blocked by" relation; the exact board property name is a
  Construction detail (MVP may treat it as empty if the board has no such relation).
- Notion id binding (data-source vs database id) and Claude Code headless flag specifics are resolved
  in Construction (PRD §10 open questions).
- Build tooling / test framework / final project layout chosen in Construction (PRD §10).
- **Security Baseline extension = disabled** (PRD D7); safety invariants FR11–FR13 remain hard.

## 8. Definition of Done (MVP gate — PRD §9)

A real Notion ticket in an active state is picked up; a Claude Code agent runs in a correctly-confined
per-issue workspace; the run completes; reconciliation stops it when the ticket reaches a terminal
state — all visible in structured logs + the status line; the three safety invariants pass as explicit
checkboxes.
