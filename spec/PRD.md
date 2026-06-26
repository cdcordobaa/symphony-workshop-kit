# PRD — Symphony Orchestrator (Notion + Claude Code + TypeScript)

> **Status:** Restart seed (Run 2). **Owner:** workshop participant. **Date:** 2026-06-26.
> **Canonical source of truth:** [`spec/SYMPHONY-SPEC.md`](./SYMPHONY-SPEC.md) (OpenAI Symphony, Draft v1).
> **Prior run preserved on branch:** `archive/inception-run-1-notion-mvp`.

## 0. How to use this document

This PRD is the **kickoff seed** for restarting the workshop **from scratch**. It frames *what we are
building and why* at the product level, and it **locks in the technology variant** so AI-DLC
INCEPTION can move straight to decomposition instead of re-deciding the stack.

The PRD does **not** replace the spec or pre-write the working units. The flow is:

```
spec/SYMPHONY-SPEC.md  +  spec/PRD.md (this file)
        │
        ▼  AI-DLC INCEPTION  (Requirements → Workflow Planning → Units Generation)
aidlc-docs/inception/...   working units
        │
        ▼  /aidlc-to-tasks
docs/tasks/task-package.yaml + task files
        │
        ▼  /convert-tasks-to-linear apply
Linear milestones + issues + sub-issues + blockers
        │
        ▼  hand off to OpenSymphony engine (Phase 2)
```

When you start INCEPTION, point it at **`spec/reading-guide.md`** first, then this PRD for the locked
decisions, then the spec sections the reading guide maps to working units.

## 1. Problem statement (spec §1)

Engineering teams accumulate well-specified, self-contained tickets that a coding agent could execute
unattended, but no lightweight component continuously watches the issue board, picks eligible work,
runs an agent in an isolated workspace, and reconciles the result back against the board. We are
building **that orchestrator**: a single long-running daemon that turns "ready" tickets into agent
runs, safely and repeatably, with no human in the loop on the happy path.

We are building **our own** Symphony-spec orchestrator. OpenSymphony (the Rust engine in `engine/`)
is **only the driver** that launches the agents which implement this build — it is not the target.

## 2. Goals and non-goals (spec §2)

**Goals**
- Continuously poll an issue board, select eligible tickets, and dispatch a coding agent per ticket.
- Keep agent execution **isolated and safe** (per-issue workspaces, enforced filesystem invariants).
- Be **resilient**: transient failures recover; bad config or tracker hiccups never crash the daemon.
- Stay **swappable** across tracker and agent backends via clean layer boundaries.
- Reach **Core Conformance (spec §18.1)** — fastest via an MVP walking skeleton (see §5).

**Non-goals**
- No GUI, no HTTP server, no JSON REST API, no web dashboard (terminal + logs only).
- No durable database; scheduler state is in-memory and recovered from tracker + filesystem.
- No SSH worker extension (spec Appendix A), no `linear_graphql` client tool.
- The orchestrator is a **reader/scheduler**, not a ticket-writer — state transitions and comments
  are performed by the **agent** via its own tools, not by orchestrator business logic (spec §11.5).

## 3. Locked-in variant decisions (carried from Run 1)

These are **fixed for Run 2**. INCEPTION refines requirements within these; it does not re-open them.

| # | Decision | Choice | Spec ref |
|---|---|---|---|
| D1 | Conformance target | **Core Conformance only** (§18.1), trimmed ultra-lightweight | §17, §18.1 |
| D2 | Observability | **Structured logs** + **simple terminal status surface**; no HTTP/JSON/web | §13.1–§13.7 |
| D3 | Tracker | **Notion** databases via the **Notion MCP** server (replaces Linear) | §11 (adapted) |
| D4 | Agent | **Claude Code** headless, behind an abstract Agent Runner (replaces Codex) | §10 (adapted) |
| D5 | Approval posture | **High-trust**: auto-approve commands/file changes; user-input-required = hard failure | §10.5, §15.1 |
| D6 | Language | **TypeScript / Node.js** | — |
| D7 | Security extension | **Opted out** (workshop-grade); §9.5/§15.2 safety invariants still REQUIRED | §15 |
| D8 | Pipeline | **All-Notion**; kit's Linear bridge & bundled Rust engine are out of the *target* scope | — |

> The spec's portability clause is the license for D3/D4: *"A non-Linear implementation MAY change
> transport details, but the normalized outputs MUST match the domain model in Section 4."*

## 4. Users and personas

- **Operator** — runs `symphony ./WORKFLOW.md` in a terminal, watches structured logs + the status
  line, edits `WORKFLOW.md` to tune cadence/concurrency/states. Needs failures to be legible without
  a debugger and the daemon to stay up through transient errors.
- **Coding agent (Claude Code)** — launched per ticket inside a confined workspace; reads the
  rendered prompt, does the work, and updates the Notion ticket through its own MCP tools.
- **Board author** — curates the Notion database (Status, priority, "blocked by" relations) so
  tickets become eligible candidates.

## 5. Scope

### 5.1 In scope — Core Conformance (spec §18.1, adapted)
Workflow path selection; `WORKFLOW.md` loader (front matter + prompt body); typed config + `$VAR`
resolution; dynamic watch/reload; polling orchestrator with single-authority state; **Notion** tracker
client (candidate fetch + state refresh + terminal fetch) via Notion MCP; sanitized per-issue
workspaces; workspace lifecycle hooks + timeout; **Claude Code** agent-runner subprocess + streaming;
strict prompt rendering with `issue`/`attempt`; exponential retry queue + continuation retries with
backoff cap; reconciliation (stall detection + terminal/non-active stop); workspace cleanup (startup
sweep + active transition); structured logs with required context fields; simple terminal status
surface; CLI/host lifecycle.

### 5.2 MVP walking skeleton — BUILD THIS FIRST
The first deliverable is a **happy-path walking skeleton**: the thinnest end-to-end slice that takes a
real Notion ticket and produces a real Claude Code run, with the safety invariants enforced. It is
intentionally below Core Conformance; deferred items (§5.3) are tracked, not dropped.

**IN for the MVP (happy path only):**
- CLI + `WORKFLOW.md` loader + minimal typed config with defaults and `$VAR` resolution.
- **Notion tracker (read-only) via MCP**: `fetch_candidate_issues()` + simple state-refresh,
  normalized to the §4 issue model (id, identifier, title, state, priority, labels, blocked_by).
- **Orchestrator (simple)**: one poll loop at fixed interval; eligibility (active state, not running,
  global concurrency only); sort (priority → created_at); dispatch; in-memory state.
- **Workspace Manager**: per-issue sanitized dir, create/reuse, with the **3 safety invariants kept**.
- **Agent Runner (Claude Code headless, high-trust)**: launch in workspace cwd, render strict prompt
  (`issue` + `attempt`), run one turn, map success/failure, forward basic events.
- **Observability**: structured logs (`issue_id` / `issue_identifier` / `session_id`) + status line.
- **Reconciliation**: basic terminal-state stop only (no stall detection).

### 5.3 Deferred (post-MVP — fill these to reach full Core Conformance)
Dynamic `WORKFLOW.md` watch/reload; exponential retry/backoff + continuation retries + retry queue;
per-state concurrency caps; stall detection; multi-turn continuation on the same thread up to
`max_turns`; startup terminal workspace cleanup; token/runtime accounting + rate-limit tracking;
`after_create`/`before_remove` hooks + optional workspace population.

> **Core Conformance = MVP + every deferred item re-enabled.** The MVP must keep the spec §3.2 layer
> boundaries intact so deferred items slot in without rework.

### 5.4 Out of scope
Linear tracker and the kit's `/convert-tasks-to-linear` bridge as a *target* feature; the bundled
OpenSymphony Rust engine / Codex agent; HTTP server, JSON REST API (`/api/v1/*`), web dashboard;
`linear_graphql` tool extension; SSH Worker Extension (Appendix A); persistent retry/session DB
across restarts; first-class orchestrator tracker-write APIs; trackers beyond Notion; any GUI.

## 6. Capabilities (component map, spec §3)

Layered architecture (spec §3.2), kept clean so backends stay swappable:

```
Policy Layer        : WORKFLOW.md prompt body + team rules
Configuration Layer : typed front-matter config (defaults, $VAR, path normalization)
Coordination Layer  : Orchestrator (poll loop, eligibility, concurrency, retries, reconciliation)
Execution Layer     : Workspace Manager + Agent Runner (Claude Code subprocess)
Integration Layer   : Notion tracker adapter (via Notion MCP)
Observability Layer : structured logs + simple terminal status surface
```

Eight components: **Workflow Loader**, **Config Layer**, **Notion Tracker Client**, **Orchestrator**,
**Workspace Manager**, **Agent Runner (Claude Code)**, **Status Surface (terminal)**, **Logging**.

## 7. Non-functional requirements (cross-cutting)

- **Safety (MANDATORY, even with §15 opted out):** before *every* agent launch —
  (a) agent subprocess cwd **==** workspace path; (b) workspace path contained within the normalized
  absolute workspace root (reject escapes); (c) workspace key sanitized to `[A-Za-z0-9._-]`. Each is
  an explicit acceptance checkbox. (§9.5, §15.2)
- **Secrets:** `$VAR` indirection; never log tokens/secret env values; validate presence without
  printing. (§15.3)
- **Reliability:** transient failures recover via backoff; dispatch-validation failures keep the
  daemon alive with reconciliation active; tracker/refresh failures degrade gracefully (skip tick /
  keep workers); observability sink failures never crash the daemon. (§14.2)
- **Recovery:** in-memory scheduler state only; restart recovery is tracker- + filesystem-driven
  (startup terminal cleanup, fresh polling, re-dispatch). Retry timers / live sessions not restored.
- **Concurrency:** bounded global and per-state; single-authority state mutation prevents duplicate
  dispatch. (§7.4, §8.3)
- **Performance:** fixed poll cadence (`polling.interval_ms`, default 30000), dynamically adjustable;
  immediate first tick at startup. (§8.1)
- **Portability / simplicity:** favor the smallest implementation satisfying Core Conformance; keep
  tracker and agent backends behind interfaces. (§3.2)

## 8. Configuration contract — adapted `WORKFLOW.md` front matter (Notion variant)

Replaces the Linear `tracker` block (§5.3.1); other blocks keep spec semantics; `codex.*` → `agent.*`.

- `tracker.kind: notion` (REQUIRED for dispatch)
- `tracker.database` — Notion board database / data-source id (REQUIRED for dispatch)
- `tracker.api_key` — literal or `$VAR` (e.g. `$NOTION_API_KEY`); empty after resolution ⇒ missing
- `tracker.active_states` — default `["Todo", "In Progress"]`
- `tracker.terminal_states` — default `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`
- `polling.interval_ms` — default `30000`
- `workspace.root` — default `<system-temp>/symphony_workspaces`; `~`/`$VAR`/relative resolution
- `hooks.{after_create,before_run,after_run,before_remove}` + `hooks.timeout_ms` (default `60000`)
- `agent.command` — default Claude Code headless invocation, launched via `bash -lc`
- `agent.max_concurrent_agents` (10), `agent.max_turns` (20), `agent.max_retry_backoff_ms` (300000),
  `agent.max_concurrent_agents_by_state` ({})
- `agent.turn_timeout_ms` (3600000), `agent.read_timeout_ms` (5000), `agent.stall_timeout_ms` (300000)

## 9. Success metrics / Definition of Done (spec §17, §18.1)

- **MVP gate:** a real Notion ticket in an active state is picked up, a Claude Code agent runs in a
  correctly-confined per-issue workspace, the run completes, and reconciliation stops it when the
  ticket reaches a terminal state — all visible in structured logs + the status line.
- **Core Conformance gate:** the §18.1 checklist passes against the Notion + Claude Code adapters;
  §17.1–§17.7 Core rows pass (§17.3/§17.5 validated against Notion/Claude Code; §17.6 limited to logs
  + terminal status). The three safety invariants pass as explicit checkboxes. Extension rows (HTTP
  server, `linear_graphql`, SSH) are **N/A**.
- **Reliability evidence:** induced tracker failure → skipped dispatch, daemon survives; induced bad
  reload → last-known-good config retained, operator-visible error; induced agent failure → retry per
  backoff policy.

## 10. Risks and open questions (for INCEPTION to resolve)

- Notion data-source binding: database id vs data-source id, and exact MCP client wiring.
- Claude Code headless invocation specifics: non-interactive + auto-approve flags, event stream shape
  for `session_id = "<thread_id>-<turn_id>"` derivation.
- Mapping Notion "blocked by" relation kinds → `blocked_by[]` reliably across board schemas.
- Project layout, build tooling, and test framework (TS) — chosen in Construction.

## 11. Restart plan (what to do after this PRD)

1. Re-run **AI-DLC INCEPTION** from the spec + this PRD: Requirements Analysis → Workflow Planning →
   Units Generation under `aidlc-docs/inception/application-design/`.
2. **Bridge:** `/aidlc-to-tasks` → `docs/tasks/task-package.yaml` + task files (validator-gated).
3. **Publish:** `/convert-tasks-to-linear apply --project-slug <slug>`.
4. **Hand off** to the OpenSymphony engine — see `engine/engine-setup.md` and `RUNBOOK.md` Phase 2.
