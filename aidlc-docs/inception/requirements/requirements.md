# Requirements — Symphony Orchestrator (Ultra-Lightweight, Notion + Claude Code, TypeScript)

> **Source of truth:** `spec/SYMPHONY-SPEC.md` (Draft v1). This document records the requirements
> for a workshop-sized, spec-conformant orchestrator, adapted per the decisions in
> `requirement-verification-questions.md`. Where this variant diverges from the spec's Linear/Codex
> assumptions, the divergence is explicit and the spec's portability clause is cited
> ("A non-Linear implementation MAY change transport details, but the normalized outputs MUST match
> the domain model in Section 4").

## 1. Intent Analysis

- **User request:** Build an ultra-lightweight Symphony orchestrator. Terminal-only (no GUI). Use
  Notion databases as the issue board/tracker, connected via the Notion MCP server (not Linear).
  Use Claude Code as the implementation agent (not Codex app-server). All code in TypeScript.
- **Request type:** New Project (greenfield).
- **Scope estimate:** System-wide (a multi-component long-running daemon).
- **Complexity estimate:** Moderate–Complex (concurrency, retry/backoff, reconciliation, subprocess
  agent integration, MCP tracker integration) — but deliberately trimmed to **Core Conformance only**.

## 2. Key Decisions (from Requirements Verification)

| # | Decision | Choice | Spec ref |
|---|---|---|---|
| D1 | Conformance target | **Core Conformance only** (§18.1), trimmed for ultra-lightweight | §17, §18.1 |
| D2 | Observability | **Structured logs** (required) + **simple terminal status surface**; no HTTP server / JSON API / web dashboard | §13.1–§13.4 |
| D3 | Tracker | **Notion** (Notion databases) via **Notion MCP** server — replaces Linear | §11 (adapted) |
| D4 | Agent | **Claude Code** (headless), behind an abstract Agent Runner — replaces Codex app-server | §10 (adapted) |
| D5 | Approval/sandbox posture | **High-trust**: auto-approve commands & file changes; user-input-required = hard failure | §10.5, §15.1 |
| D6 | Language | **TypeScript / Node.js** | — |
| D7 | Security extension | **Opted out** (workshop-grade). Spec §9.5/§15.2 safety invariants still REQUIRED | §15 |
| D8 | Pipeline | **All-Notion**: kit's Linear bridge (`/convert-tasks-to-linear`) and bundled OpenSymphony Rust engine are **out of scope** | — |

## 3. System Context (adapted from §3)

Layered architecture (spec §3.2), retained:

```
Policy Layer        : WORKFLOW.md prompt body + team rules
Configuration Layer : typed front-matter config (defaults, $VAR, path normalization)
Coordination Layer  : Orchestrator (poll loop, eligibility, concurrency, retries, reconciliation)
Execution Layer     : Workspace Manager + Agent Runner (Claude Code subprocess)
Integration Layer   : Notion tracker adapter (via Notion MCP)
Observability Layer : structured logs + simple terminal status surface
```

Component map (spec §3.1), adapted:

1. **Workflow Loader** — reads `WORKFLOW.md`, splits YAML front matter + prompt body.
2. **Config Layer** — typed getters, defaults, `$VAR` resolution, validation, dynamic reload.
3. **Notion Tracker Client** — replaces the Linear client; fetches candidate/terminal/by-id issue
   states from Notion databases via the Notion MCP server; normalizes to the §4 domain model.
4. **Orchestrator** — single-authority in-memory state; dispatch/retry/reconcile/stop/release.
5. **Workspace Manager** — per-issue workspace dirs, lifecycle hooks, sanitization, cleanup.
6. **Agent Runner** — launches **Claude Code** (headless) in the workspace, builds prompt from
   template + issue, streams agent events back to the orchestrator.
7. **Status Surface (simple terminal)** — human-readable terminal status drawn from orchestrator
   state only; MUST NOT be required for correctness.
8. **Logging** — structured logs to stderr/file sink(s).

## 4. Functional Requirements

IDs map to spec sections so Units Generation and the Test Plan can trace each one.

### 4.1 Workflow Loader & Config (§5, §6)
- **FR-WL-1** Resolve `WORKFLOW.md` path: explicit runtime/CLI path first, else `./WORKFLOW.md` in cwd. (§5.1, §17.7)
- **FR-WL-2** Parse optional YAML front matter (delimited by `---`); remainder is the trimmed prompt body; absent front matter ⇒ empty config + whole file as prompt. Non-map front matter is an error. (§5.2)
- **FR-WL-3** Typed Config Layer with defaults, and `$VAR_NAME` indirection resolved **only** for values that explicitly reference an env var; `~` home expansion and relative-path resolution (relative to the `WORKFLOW.md` dir) for path fields. (§6.1)
- **FR-WL-4** **Dynamic reload (REQUIRED):** detect `WORKFLOW.md` changes and re-read/re-apply config + prompt without restart (poll cadence, concurrency, active/terminal states, agent settings, workspace paths/hooks, prompt for future runs). Invalid reloads MUST NOT crash; keep last-known-good config and emit an operator-visible error. (§6.2)
- **FR-WL-5** Strict prompt template rendering (Liquid-compatible semantics): unknown variables/filters MUST fail rendering; inputs are the normalized `issue` object and the `attempt` integer/null. (§5.4, §12)
- **FR-WL-6** Dispatch preflight validation at startup and per tick: workflow loads/parses; `tracker.kind` present & supported; tracker auth present after `$` resolution; required tracker target (Notion database identifier) present; agent launch command present. Startup failure fails startup; per-tick failure skips dispatch but keeps reconciliation. (§6.3)
- **FR-WL-7** Front matter schema is adapted for this variant (see §7 below): `tracker.kind: notion`, Notion DB identifier + auth, `polling`, `workspace`, `hooks`, `agent`. Unknown keys ignored for forward-compat. (§5.3)

### 4.2 Domain Model (§4)
- **FR-DM-1** Normalize every issue to the §4.1.1 model: `id`, `identifier`, `title`, `description`, `priority`, `state`, `branch_name`, `url`, `labels` (lowercased), `blocked_by[]` (`{id, identifier, state}`), `created_at`, `updated_at`. (§4.1.1, §11.3)
- **FR-DM-2** Identifier/normalization rules: workspace key = `issue.identifier` with any char outside `[A-Za-z0-9._-]` replaced by `_`; state comparison after lowercasing; session id composed from the agent's thread/turn identities as `<thread_id>-<turn_id>`. (§4.2)
- **FR-DM-3** Maintain the single authoritative Orchestrator Runtime State (§4.1.8): `poll_interval_ms`, `max_concurrent_agents`, `running`, `claimed`, `retry_attempts`, `completed`, `codex_totals` (token + runtime aggregates; named generically as agent totals here), `rate_limits`.

### 4.3 Notion Tracker Client (§11, adapted)
- **FR-TR-1** Implement the three REQUIRED adapter operations against Notion: `fetch_candidate_issues()` (active-state pages in the configured Notion database), `fetch_issues_by_states(states)` (startup terminal cleanup), `fetch_issue_states_by_ids(ids)` (reconciliation). (§11.1)
- **FR-TR-2** Connect via the **Notion MCP** server as the integration transport; reuse configured Notion auth; do not require the agent or orchestrator to read raw tokens from disk beyond `$VAR` resolution. (§11.2 adapted, §15.3)
- **FR-TR-3** Map Notion structures to the domain model: a configured Notion **database** is the project/board; **pages** are issues; a **Status** select property maps to `state`; `active_states`/`terminal_states` are configurable name lists; **relation** properties of a "blocked by" kind populate `blocked_by[]`; multi-select/labels lowercased; priority coerced to integer-or-null; ISO-8601 timestamps parsed. (§11.3 adapted)
- **FR-TR-4** Paginate candidate fetches; preserve ordering across pages; apply a network timeout. (§11.2)
- **FR-TR-5** Error taxonomy + orchestrator behavior: candidate-fetch failure ⇒ log and skip dispatch this tick; running-state-refresh failure ⇒ log and keep workers running; startup terminal-cleanup failure ⇒ log warning and continue startup. (§11.4, §14.2)
- **FR-TR-6** **Tracker writes boundary:** the orchestrator remains a reader/scheduler. Ticket state transitions/comments are performed by the **Claude Code agent** using its Notion MCP tools, not by orchestrator business logic. A successful run MAY end at a workflow-defined handoff state, not necessarily the terminal state. (§1, §11.5)

### 4.4 Orchestrator: Poll / Dispatch / Reconcile / Retry (§7, §8, §16)
- **FR-OR-1** Orchestration states `Unclaimed → Claimed → {Running | RetryQueued} → Released`, mutated by a single authority. `claimed`/`running` checks REQUIRED before launching a worker. (§7.1, §7.4)
- **FR-OR-2** Poll tick sequence: reconcile running issues → preflight validation → fetch candidates → sort → dispatch while slots remain → notify observers; reschedule next tick at effective interval. (§8.1, §16.2)
- **FR-OR-3** Candidate eligibility: has `id/identifier/title/state`; state ∈ active and ∉ terminal; not already running/claimed; global and per-state slots available; for `Todo` state, no non-terminal blocker. (§8.2)
- **FR-OR-4** Dispatch sort order: `priority` ascending (null last) → `created_at` oldest first → `identifier` lexicographic. (§8.2)
- **FR-OR-5** Concurrency: global `available = max(max_concurrent_agents - running, 0)`; per-state cap `max_concurrent_agents_by_state[state]` (normalized key) else global. (§8.3)
- **FR-OR-6** Retry & backoff: clean exit ⇒ short continuation retry (~1000 ms, attempt 1); failure ⇒ `delay = min(10000 * 2^(attempt-1), agent.max_retry_backoff_ms)`. Cancel any existing timer for the issue before scheduling; retry entry stores `attempt/identifier/error/due_at_ms/timer_handle`. (§8.4, §16.6)
- **FR-OR-7** Retry handling: re-fetch active candidates; if issue missing ⇒ release claim; if found & eligible & slot free ⇒ dispatch (preserving attempt); else requeue with `no available orchestrator slots`; if found but no longer active ⇒ release. (§8.4, §16.6)
- **FR-OR-8** Reconciliation each tick — Part A stall detection: `elapsed` since last agent event (else `started_at`) > `stall_timeout_ms` ⇒ kill worker + schedule retry; disabled if `stall_timeout_ms <= 0`. Part B tracker refresh: terminal ⇒ stop worker + clean workspace; active ⇒ update snapshot; neither ⇒ stop worker without cleanup; refresh failure ⇒ keep workers and retry next tick. (§8.5, §16.3)
- **FR-OR-9** Continuation semantics: after a normal turn, re-check tracker state; if still active and `turn_number < max_turns`, run another turn on the **same live agent thread/session** in the same workspace; first turn uses the full rendered prompt, continuation turns send only continuation guidance. After worker exits normally, schedule the short continuation retry. (§7.1, §16.5)
- **FR-OR-10** Startup terminal cleanup: query terminal-state issues, remove their workspace dirs; on fetch failure, warn and continue. (§8.6)

### 4.5 Workspace Manager & Safety (§9)
- **FR-WS-1** Per-issue workspace at `<workspace.root>/<sanitized_identifier>`; create if missing, reuse if present; `created_now` true only on fresh creation; successful runs do not auto-delete. (§9.1, §9.2)
- **FR-WS-2** Hooks `after_create` (only on new dir; failure fatal to creation), `before_run` (failure fatal to attempt), `after_run` (failure logged/ignored), `before_remove` (failure logged/ignored); all run with workspace as cwd via `sh -lc`/`bash -lc`, bounded by `hooks.timeout_ms` (default 60000). (§9.4)
- **FR-WS-3 (MANDATORY SAFETY INVARIANTS — each becomes an acceptance checkbox):**
  - (a) Agent subprocess launches only with `cwd == workspace_path`. (§9.5-1, §15.2)
  - (b) `workspace_path` MUST be contained within the normalized absolute `workspace_root`; reject any path that escapes root. (§9.5-2, §15.2)
  - (c) Workspace key sanitized to `[A-Za-z0-9._-]` (others ⇒ `_`). (§9.5-3, §15.2)
- **FR-WS-4** Optional workspace population is implementation-defined via hooks; population failure fails the attempt; reused workspaces are not destructively reset on failure. (§9.3)

### 4.6 Agent Runner: Claude Code (§10, adapted)
- **FR-AG-1** Launch **Claude Code** (headless/non-interactive) as a subprocess in the per-issue workspace, via a configurable launch command (e.g. `agent.command`, default a Claude Code headless invocation), invoked through `bash -lc`. (§10.1 adapted)
- **FR-AG-2** Abstract Agent Runner interface so the agent backend is swappable; Claude Code is the one concrete adapter. The runner: creates/reuses workspace → builds prompt → starts agent session → forwards events to orchestrator → on any error fails the attempt (orchestrator retries). (§10.7)
- **FR-AG-3** Session model: derive stable session/thread/turn identifiers from the agent invocation; emit `session_id = "<thread_id>-<turn_id>"`; reuse the same thread for continuation turns within one worker run. (§10.2 adapted)
- **FR-AG-4** Streaming turn processing with completion/failure/cancel/timeout mapping; keep the agent process alive across continuation turns, stop it when the worker run ends; separate protocol stream from diagnostic stderr. (§10.3)
- **FR-AG-5** Emit structured runtime events upstream (e.g. `session_started`, `turn_completed`, `turn_failed`, `turn_cancelled`, `notification`, `startup_failed`, `malformed`) with timestamp and optional token usage. (§10.4)
- **FR-AG-6** **High-trust approval posture (D5):** auto-approve command-execution and file-change approvals for the session; treat user-input-required turns as hard failure; unsupported dynamic tool calls return a failure without stalling the session. A run MUST NOT stall indefinitely. (§10.5)
- **FR-AG-7** Timeouts: request/response read timeout, total turn timeout, and orchestrator-enforced stall timeout; normalized error categories (e.g. `agent_not_found`, `invalid_workspace_cwd`, `response_timeout`, `turn_timeout`, `turn_failed`, `turn_cancelled`, `turn_input_required`). (§10.6)

### 4.7 Prompt Construction (§12)
- **FR-PR-1** Render `workflow.prompt_template` with the normalized `issue` and optional `attempt`; strict variable/filter checking; preserve nested arrays/maps (labels, blockers); stringify keys for template compatibility. (§12.1–§12.2)
- **FR-PR-2** `attempt` distinguishes first run (null/absent) vs continuation vs retry, so the template can branch. Rendering failure fails the attempt immediately. (§12.3–§12.4)
- **FR-PR-3** Fallback minimal prompt allowed only when the prompt body is empty; read/parse failures are config errors, not silent fallbacks. (§5.4)

### 4.8 Observability (§13, trimmed per D2)
- **FR-OB-1** Structured logs with REQUIRED context fields: `issue_id`, `issue_identifier` on issue logs; `session_id` on agent-session logs; stable `key=value` phrasing with action outcome and concise failure reason; avoid logging large raw payloads or secrets. (§13.1, §15.3)
- **FR-OB-2** Operator-visible startup/validation/dispatch failures without a debugger; one or more sinks; a failing sink SHOULD NOT crash the service. (§13.2)
- **FR-OB-3** Token & runtime accounting in orchestrator state: prefer absolute thread totals, track deltas vs last reported to avoid double-counting; aggregate runtime seconds (cumulative ended + active elapsed at snapshot). Track latest rate-limit payload if the agent provides one. (§13.5)
- **FR-OB-4** **Simple terminal status surface** drawn from orchestrator state/metrics only (running sessions w/ `turn_count`, retry queue + delays, token/runtime totals). MUST NOT be required for correctness. **No HTTP server, no JSON API, no web dashboard.** (§13.3–§13.4; §13.7 explicitly OUT)

### 4.9 CLI & Host Lifecycle (§17.7)
- **FR-CLI-1** Accept a positional `path-to-WORKFLOW.md`; default to `./WORKFLOW.md`; error on a nonexistent explicit path or missing default; surface startup failure cleanly; exit 0 on normal start/shutdown, non-zero on startup failure/abnormal exit. (§17.7)

## 5. Non-Functional Requirements

- **NFR-SAFETY** The three filesystem-safety invariants (FR-WS-3 a/b/c) are mandatory and verified before every agent launch — in scope even though the SECURITY extension is opted out. (§9.5, §15.2)
- **NFR-SECRETS** Support `$VAR` indirection; never log API tokens/secret env values; validate secret presence without printing. (§15.3)
- **NFR-RELIABILITY** Transient failures recover via exponential backoff; dispatch-validation failures keep the service alive and reconciliation active; tracker/refresh failures degrade gracefully (skip tick / keep workers); observability failures never crash the orchestrator. (§14.2)
- **NFR-RECOVERY** In-memory scheduler state only (no durable DB). Restart recovery is tracker- + filesystem-driven: startup terminal cleanup, fresh polling, re-dispatch. Retry timers / live sessions are not restored. (§2.1, §14.3)
- **NFR-CONCURRENCY** Bounded global and per-state concurrency; single-authority state mutation prevents duplicate dispatch. (§7.4, §8.3)
- **NFR-PERF** Fixed poll cadence (`polling.interval_ms`, default 30000), dynamically adjustable; immediate first tick at startup. (§8.1)
- **NFR-PORTABILITY / SIMPLICITY** Keep layers (§3.2) cleanly separated so the tracker and agent backends stay swappable. Favor the smallest implementation that satisfies Core Conformance (D1). (§3.2)
- **NFR-HOOK-SAFETY** Hooks are trusted config, run in the workspace dir, output truncated in logs, bounded by timeouts. (§15.4)
- **NFR-LANG** TypeScript/Node.js; idiomatic project layout and tooling chosen in Construction. (D6)

## 6. Scope

### 6.1 In Scope (Core Conformance §18.1, adapted)
Workflow path selection; `WORKFLOW.md` loader; typed config + `$` resolution; dynamic watch/reload;
polling orchestrator with single-authority state; **Notion** tracker client (candidate + state
refresh + terminal fetch) via Notion MCP; sanitized per-issue workspaces; workspace lifecycle hooks
+ timeout; **Claude Code** agent-runner subprocess client + streaming; strict prompt rendering with
`issue`/`attempt`; exponential retry queue + continuation retries; configurable backoff cap;
reconciliation that stops runs on terminal/non-active states; workspace cleanup (startup sweep +
active transition); structured logs with required context fields; operator-visible observability;
**simple terminal status surface**; CLI/host lifecycle.

### 6.1.1 MVP Walking-Skeleton Slice (SELECTED — build this first)

Per the user's "fastest experimental MVP" decision, the **first build target is a happy-path
walking skeleton**, a strict subset of §6.1. Below Core Conformance on purpose; the deferred items
are explicitly tracked for a later iteration, not dropped.

**IN for the MVP (happy path only):**
- CLI + `WORKFLOW.md` loader (front matter + prompt body split) + **minimal typed config** with
  defaults and `$VAR` resolution. (FR-WL-1,2,3,5,7 — minimal)
- **Notion tracker (read-only) via Notion MCP**: `fetch_candidate_issues()` + a simple
  state-refresh, normalized to the §4 issue model (id, identifier, title, state, priority, labels,
  blocked_by). (FR-TR-1,2,3 — minimal)
- **Orchestrator (simple)**: single poll loop at a fixed interval; eligibility (active state, not
  already running, global concurrency only); sort (priority → created_at); dispatch; in-memory
  state. (FR-OR-2,3,4,5 — global only)
- **Workspace Manager**: per-issue sanitized dir, create/reuse, with the **3 safety invariants
  (FR-WS-3 a/b/c) — KEPT**. `before_run`/`after_run` hooks optional. (FR-WS-1, FR-WS-3)
- **Agent Runner (Claude Code headless, high-trust)**: launch in workspace cwd, render prompt
  (strict, `issue` + `attempt`), run one turn, map success/failure, forward basic events.
  (FR-AG-1,2,3,4,6 partial; FR-PR-1)
- **Observability**: structured logs with `issue_id`/`issue_identifier`/`session_id` + a simple
  terminal status line. (FR-OB-1, FR-OB-4 minimal)
- Reconciliation = **basic terminal-state stop only** (no stall detection). (FR-OR-8 partial)

**DEFERRED to post-MVP (NOT in the first slice):**
- Dynamic `WORKFLOW.md` watch/reload (FR-WL-4).
- Exponential retry/backoff + continuation retries + retry queue (FR-OR-6,7) — MVP just lets a
  failed attempt be re-picked on the next poll.
- Per-state concurrency caps (FR-OR-5 per-state).
- Stall detection (FR-OR-8 Part A).
- Multi-turn continuation on the same thread up to `max_turns` (FR-OR-9) — MVP runs a single turn.
- Startup terminal workspace cleanup (FR-OR-10).
- Token/runtime accounting + rate-limit tracking (FR-OB-3).
- `after_create`/`before_remove` hooks (FR-WS-2 partial), optional workspace population (FR-WS-4).

> Reaching full §6.1 Core Conformance = MVP + re-enabling every DEFERRED item above. The MVP keeps
> the layer boundaries (§3.2) intact so deferred items slot in without rework.

### 6.2 Out of Scope
- Linear tracker and the kit's `/convert-tasks-to-linear` bridge (D3, D8).
- The bundled OpenSymphony Rust engine / Codex app-server agent (D4, D8).
- OPTIONAL HTTP server, JSON REST API (`/api/v1/*`), and web dashboard (§13.7, D2).
- `linear_graphql` client-side tool extension (§10.5, D3).
- SSH Worker Extension (Appendix A).
- Persistent retry/session DB across restarts; first-class orchestrator tracker-write APIs;
  pluggable trackers beyond Notion (§18.2 TODOs).
- Any GUI.

## 7. Adapted `WORKFLOW.md` Front Matter (Notion variant)

Replaces the Linear-specific `tracker` block (§5.3.1); all other blocks (`polling`, `workspace`,
`hooks`, `agent`) keep their spec semantics. `codex.*` is renamed/repurposed to `agent.*` for the
Claude Code runner.

- `tracker.kind`: `notion` (REQUIRED for dispatch)
- `tracker.database` / data-source identifier for the Notion board (REQUIRED for dispatch)
- `tracker.api_key`: literal or `$VAR` (canonical env e.g. `NOTION_API_KEY`); empty after resolution ⇒ missing
- `tracker.active_states`: default `["Todo", "In Progress"]`
- `tracker.terminal_states`: default `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`
- `polling.interval_ms`: default `30000`
- `workspace.root`: default `<system-temp>/symphony_workspaces`, `~`/`$VAR`/relative resolution
- `hooks.{after_create,before_run,after_run,before_remove}` + `hooks.timeout_ms` (default `60000`)
- `agent.command`: default Claude Code headless invocation, launched via `bash -lc`
- `agent.max_concurrent_agents` (10), `agent.max_turns` (20), `agent.max_retry_backoff_ms` (300000),
  `agent.max_concurrent_agents_by_state` ({})
- `agent.turn_timeout_ms` (3600000), `agent.read_timeout_ms` (5000), `agent.stall_timeout_ms` (300000)
- High-trust approval/sandbox posture documented as the implementation default (D5).

## 8. Acceptance / Conformance Target

Target the **Core Conformance** rows of spec §17.1–§17.7 and the §18.1 checklist, with these
substitutions: §17.3/§17.5 are validated against the **Notion tracker** and **Claude Code agent**
adapters respectively rather than Linear/Codex; §17.6 HTTP/snapshot rows are limited to logs + the
simple terminal status surface. The three safety invariants (FR-WS-3) are explicit acceptance
checkboxes. Extension-conformance rows (HTTP server, `linear_graphql`, SSH) are **N/A**.

## 9. Open Items for Later Stages
- Exact Notion data-source binding (database id vs data-source id) and MCP client wiring → design.
- Claude Code headless invocation specifics (flags for non-interactive + auto-approve) → design.
- Project layout, build tooling, and test framework (TS) → NFR/Construction.
