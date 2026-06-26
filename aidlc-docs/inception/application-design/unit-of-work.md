# Units of Work — Symphony Orchestrator MVP (Walking Skeleton)

> Scope: the MVP walking-skeleton slice (`requirements.md` §6.1.1). One deployable Node.js daemon;
> units are logical TypeScript modules. Deferred (post-MVP) behaviors are listed per unit so each
> module has a clear growth path to full Core Conformance without rework.

## Code Organization Strategy (Greenfield)

Single TypeScript package, one process. Suggested layout (finalized in Construction):

```
symphony/
├── WORKFLOW.md                 # repo-owned policy + runtime config (Notion variant)
├── package.json  tsconfig.json
└── src/
    ├── index.ts                # CLI entrypoint / host lifecycle            (U1)
    ├── domain/                 # shared types: Issue, Config, RuntimeState  (U1)
    ├── config/                 # WORKFLOW.md loader + typed config + $VAR    (U1)
    ├── tracker/                # Notion adapter via MCP (read-only)          (U2)
    ├── orchestrator/           # poll loop, eligibility, dispatch, reconcile (U3)
    ├── workspace/              # sanitized workspace + safety invariants     (U4)
    ├── agent/                  # Claude Code runner + prompt render          (U4)
    └── obs/                    # structured logging + terminal status        (U5)
```

- Modules depend only "downward" through explicit interfaces (tracker/agent are interfaces the
  orchestrator consumes), keeping the spec's layer boundaries (§3.2) intact and backends swappable.
- No database. All scheduler state is in-memory in the orchestrator (NFR-RECOVERY).

---

## U1 — Bootstrap, CLI & Config
**Layer**: Policy/Config + Host lifecycle · **Spec**: §5, §6, §12 (template), §17.7

**Responsibilities**
- CLI: accept positional `path-to-WORKFLOW.md`; default `./WORKFLOW.md`; error on missing explicit
  path or missing default; clean startup-failure surface; exit codes. (FR-CLI-1)
- Workflow Loader: read `WORKFLOW.md`, split optional YAML front matter from the trimmed prompt
  body; non-map front matter is an error. (FR-WL-1,2)
- Config Layer: typed getters with defaults; `$VAR` indirection only for values that reference it;
  `~`/relative path resolution for path fields; the adapted Notion front-matter schema
  (`requirements.md` §7). (FR-WL-3,7)
- Startup + per-tick dispatch **preflight validation** (workflow loads; `tracker.kind=notion`
  supported; Notion auth present after `$`; Notion database id present; agent command present). (FR-WL-6)
- Shared **domain types**: `Issue`, blocker ref, `ServiceConfig`, `OrchestratorRuntimeState`. (§4)
- Strict prompt template parsing primitive (Liquid-compatible) reused by U4. (FR-WL-5, FR-PR-1)

**Provides**: `loadWorkflow()`, typed `Config`, `Issue`/state types, `renderPrompt()`, `validateDispatchConfig()`.
**Deferred (post-MVP)**: dynamic `WORKFLOW.md` watch/reload (FR-WL-4).

## U2 — Notion Tracker (read) via MCP
**Layer**: Integration · **Spec**: §11 (adapted), §4.1.1, §11.3

**Responsibilities**
- Connect to the **Notion MCP** server using configured Notion auth (no raw token reads). (FR-TR-2)
- `fetchCandidateIssues()`: read pages of the configured Notion database in `active_states`;
  paginate; preserve order. (FR-TR-1,4)
- `fetchIssueStatesByIds(ids)`: minimal state refresh for reconciliation. (FR-TR-1)
- Normalize Notion pages → `Issue` (§4.1.1): Status property → `state`; relation "blocked by" →
  `blocked_by[]`; labels lowercased; priority → int|null; ISO timestamps parsed. (FR-TR-3, FR-DM-1)
- Error taxonomy + behavior: candidate-fetch failure ⇒ log + skip tick. (FR-TR-5)
- **Boundary**: read-only. Ticket writes are done by the Claude Code agent via its own Notion MCP
  tools, not here. (FR-TR-6)

**Provides**: `TrackerClient` interface impl (consumed by U3).
**Deferred**: `fetchIssuesByStates()` for startup terminal cleanup (FR-OR-10 / FR-TR-1 terminal).

## U3 — Orchestrator Core
**Layer**: Coordination · **Spec**: §7, §8, §16

**Responsibilities**
- Single authoritative in-memory state: `running`, `claimed`, `completed`, effective interval +
  concurrency. (FR-DM-3, FR-OR-1)
- Poll tick: basic reconcile → preflight (U1) → `fetchCandidateIssues` (U2) → sort → dispatch while
  global slots remain → reschedule. (FR-OR-2, §16.2)
- Eligibility: has id/identifier/title/state; state active & not terminal; not running/claimed;
  global slot free; `Todo` blocked by non-terminal blocker ⇒ ineligible. (FR-OR-3)
- Sort: priority asc (null last) → created_at oldest → identifier. (FR-OR-4)
- Global concurrency only. (FR-OR-5 global)
- Dispatch one issue → spawn worker (U4), record running entry, set claimed. (§16.4)
- Basic reconcile: refresh running issue states (U2); terminal ⇒ stop worker + request workspace
  cleanup (U4); still-active ⇒ update snapshot; refresh failure ⇒ keep workers. (FR-OR-8 Part B)
- Worker exit: remove running entry; MVP re-picks on next poll (no retry timer). (FR-OR — simplified)

**Provides**: the daemon loop tying U2/U4/U5 together.
**Deferred**: retry/backoff + continuation retries (FR-OR-6,7), per-state concurrency (FR-OR-5),
stall detection (FR-OR-8 Part A), multi-turn continuation (FR-OR-9), startup cleanup (FR-OR-10).

## U4 — Workspace & Agent Runner
**Layer**: Execution · **Spec**: §9, §10 (adapted), §12

**Responsibilities**
- Workspace Manager: `workspace_key` = sanitize(identifier) to `[A-Za-z0-9._-]`; path
  `<root>/<key>`; create if missing / reuse if present; `created_now` flag. (FR-WS-1)
- **Safety invariants (MANDATORY, each an acceptance check)**: (a) agent launches only with
  `cwd == workspace_path`; (b) `workspace_path` contained within normalized absolute
  `workspace_root` (reject escapes); (c) sanitized key. (FR-WS-3 a/b/c)
- Optional `before_run`/`after_run` hooks with `hooks.timeout_ms`, workspace as cwd. (FR-WS-2 partial)
- Agent Runner (abstract interface; **Claude Code** concrete adapter): launch Claude Code headless
  via `bash -lc <agent.command>` in workspace cwd; **high-trust** (auto-approve commands + file
  changes; user-input-required ⇒ hard failure). (FR-AG-1,2,6)
- Build the per-turn prompt via U1's strict renderer (`issue` + `attempt`); run **one turn**;
  derive session/thread/turn ids, emit `session_id`; forward basic events (`session_started`,
  `turn_completed`, `turn_failed`, `startup_failed`); map errors. (FR-AG-3,4,5; FR-PR-1,2)
- On any error, fail the attempt (orchestrator handles it). (FR-AG-7, §10.7)

**Provides**: `AgentRunner` interface impl + `WorkspaceManager` (consumed by U3).
**Deferred**: multi-turn continuation loop (FR-OR-9/§16.5), `after_create`/`before_remove` hooks,
workspace population (FR-WS-4), token/rate-limit extraction (FR-OB-3).

## U5 — Observability
**Layer**: Observability · **Spec**: §13.1–§13.4 (trimmed)

**Responsibilities**
- Structured logger: stable `key=value`; REQUIRED context fields `issue_id`, `issue_identifier`
  (issue logs) and `session_id` (session logs); outcome + concise failure reason; never log
  secrets; truncate hook/agent output. (FR-OB-1, NFR-SECRETS, NFR-HOOK-SAFETY)
- Operator-visible startup/validation/dispatch failures; sink failure should not crash. (FR-OB-2)
- **Simple terminal status surface** drawn from orchestrator state only (running issues, counts);
  not required for correctness. **No HTTP/JSON/dashboard.** (FR-OB-4)

**Provides**: `log` + `renderStatus(state)` (consumed by U1/U3/U4).
**Deferred**: token/runtime accounting + rate-limit tracking (FR-OB-3).

---

## Boundary & Validation Notes
- All 5 units belong to one deployable process; no inter-service contracts, only TS interfaces.
- Tracker (U2) and Agent Runner (U4) are consumed by the orchestrator (U3) through interfaces →
  Notion/Claude Code backends remain swappable (NFR-PORTABILITY).
- Every MVP FR in `requirements.md` §6.1.1 is assigned to exactly one owning unit (see story map).
- The 3 safety invariants live in U4 and are explicit acceptance checks.
