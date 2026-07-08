# Units of Work — Symphony Orchestrator (Run 2)

> **Stage:** INCEPTION → Units Generation.
> **Milestone (this pass):** `Phase 1: MVP Walking Skeleton` → publishes as Linear milestone
> **M1: MVP Walking Skeleton**. (Backlog option **B** — MVP only; the Deferred set in PRD §5.3
> becomes `Phase 2: Core Conformance Completion` on a later INCEPTION re-run.)
> **Source of truth:** `spec/SYMPHONY-SPEC.md`; scope from `spec/PRD.md` §5.2.

## Component map (embedded Application Design — PRD §6 / spec §3.2)

Eight components across six layers, kept behind interfaces so deferred items and alternate backends
slot in without rework:

```
Policy Layer        : WORKFLOW.md prompt body + team rules
Configuration Layer : typed front-matter config (defaults, $VAR, path normalization)
Coordination Layer  : Orchestrator (poll loop, eligibility, concurrency, reconciliation)
Execution Layer     : Workspace Manager + Agent Runner (Claude Code subprocess)
Integration Layer   : Notion tracker adapter (via Notion MCP)
Observability Layer : structured logs + simple terminal status surface
```

## Greenfield code organization (TypeScript / Node.js — D6)

One package, layered modules (one module per unit). Final tooling/test-framework choice is a
Construction decision (PRD §10); paths below are the contract the units share.

```
package.json            tsconfig.json
src/
  domain/               # Unit 1.1 — §4 domain types (Issue, WorkflowDefinition, ServiceConfig,
                        #            Workspace, RunAttempt, OrchestratorState) + port interfaces
  config/               # Unit 1.2 — WORKFLOW.md loader + typed config + $VAR + path normalization
  observability/        # Unit 1.6 — structured logger + terminal status surface
  tracker/              # Unit 1.3 — Notion MCP client + row→Issue normalization
  workspace/            # Unit 1.4 — Workspace Manager + 3 safety invariants
  agent/                # Unit 1.5 — Agent Runner (Claude Code) + strict prompt rendering
  orchestrator/         # Unit 1.7 — poll loop, eligibility, dispatch, reconciliation
  cli.ts                # Unit 1.7 — `symphony ./WORKFLOW.md` entrypoint + host lifecycle
test/                   # per-unit unit tests + one e2e happy-path slice
WORKFLOW.md             # sample workflow used by the e2e slice
```

> **Ports first:** Unit 1.1 defines the interfaces (`TrackerClient`, `AgentRunner`,
> `WorkspaceManager`, `Logger`) so adapter units depend on abstractions, preserving spec §3.2
> boundaries and the swappability goal (PRD §2).

---

## Unit definitions

Order = recommended build order. `priority` hints feed the bridge (1=Urgent, 2=High, 3=Normal).

### Unit 1.1 — Project Initialization & Core Domain Models
- **Layer:** Configuration/Coordination foundation. **Priority:** 1. **Size:** 3 pts.
- **SPEC:** §4 Core Domain Model.
- **Responsibilities:**
  - TypeScript project scaffold (package.json, tsconfig, lint/test wiring placeholders).
  - Define §4 domain types: `Issue` (`id, identifier, title, state, priority, labels, blocked_by`),
    `WorkflowDefinition`, `ServiceConfig`, `Workspace`, `RunAttempt`, `OrchestratorState`.
  - Define port interfaces consumed by later units: `TrackerClient`, `WorkspaceManager`,
    `AgentRunner`, `Logger`, `StatusSurface`.
- **Deliverables:** `src/domain/*` types + interfaces; compiling project skeleton; `npm run build`
  and `npm test` wired (even if tests are placeholders).
- **Implements FRs:** FR5 (Issue model type).

### Unit 1.2 — Workflow Loader & Typed Config
- **Layer:** Configuration. **Priority:** 1. **Size:** 5 pts.
- **SPEC:** §5 Workflow Specification, §6 Configuration; PRD §8 Notion variant.
- **Responsibilities:**
  - Load `WORKFLOW.md`: split YAML front matter from the Markdown prompt body.
  - Build typed `ServiceConfig` with defaults; resolve `$VAR` indirection from env.
  - Normalize paths (`workspace.root` supports `~`, `$VAR`, relative → absolute).
  - Validate required-for-dispatch fields (`tracker.kind`, `tracker.database`, resolved
    `tracker.api_key`); secrets validated for presence **without printing** (FR21).
- **Deliverables:** `src/config/*` (loader + schema + defaults + `$VAR`/path resolution).
- **Implements FRs:** FR1, FR2, FR21.

### Unit 1.6 — Observability: Structured Logging & Terminal Status
- **Layer:** Observability. **Priority:** 2. **Size:** 2 pts.
- **SPEC:** §13.1–§13.7 (logs + terminal status subset; no HTTP/JSON per D2).
- **Responsibilities:**
  - Structured logger emitting required context fields `issue_id`, `issue_identifier`, `session_id`.
  - Never log secret values (FR21 collaboration).
  - Simple terminal status surface (status line) reflecting active runs.
- **Deliverables:** `src/observability/*` (logger + status surface implementing the 1.1 `Logger`/
  `StatusSurface` ports).
- **Implements FRs:** FR18, FR19.

### Unit 1.3 — Notion Tracker Client (read-only) via MCP
- **Layer:** Integration. **Priority:** 2. **Size:** 5 pts.
- **SPEC:** §11 Issue Tracker Integration (adapted to Notion); §4 normalization.
- **Responsibilities:**
  - `fetch_candidate_issues()` — query the Notion board (via Notion MCP) for rows in active states.
  - Simple state-refresh — re-read current state of a known issue.
  - Normalize Notion rows → §4 `Issue` (`id, identifier, title, state, priority, labels,
    blocked_by`); map the "blocked by" relation (empty if board lacks one — see Notes).
- **Deliverables:** `src/tracker/*` implementing the 1.1 `TrackerClient` port.
- **Implements FRs:** FR3, FR4, FR5.

### Unit 1.4 — Workspace Manager & Safety Invariants
- **Layer:** Execution. **Priority:** 2. **Size:** 5 pts.
- **SPEC:** §9 Workspace Management and Safety; §15.2.
- **Responsibilities:**
  - Create/reuse a per-issue directory under the normalized `workspace.root`.
  - Enforce the **three safety invariants** as explicit, testable checks:
    - **A:** agent subprocess `cwd == workspace path` (FR11).
    - **B:** workspace path contained within the normalized absolute root; reject escapes (FR12).
    - **C:** workspace key sanitized to `[A-Za-z0-9._-]` (FR13).
- **Deliverables:** `src/workspace/*` implementing the 1.1 `WorkspaceManager` port.
- **Implements FRs:** FR10, FR11, FR12, FR13.

### Unit 1.5 — Agent Runner (Claude Code, high-trust) & Prompt Rendering
- **Layer:** Execution. **Priority:** 2. **Size:** 5 pts.
- **SPEC:** §10 Agent Runner Protocol; §12 Prompt Construction; PRD D4/D5.
- **Responsibilities:**
  - Strict prompt rendering binding `issue` + `attempt` context; missing bindings fail loudly (FR15).
  - Launch Claude Code headless via `bash -lc` in the workspace cwd, high-trust auto-approve (FR14);
    re-assert safety invariant A (cwd) before launch.
  - Run one turn; map success/failure; forward basic events; derive
    `session_id = "<thread_id>-<turn_id>"` (FR16).
- **Deliverables:** `src/agent/*` implementing the 1.1 `AgentRunner` port.
- **Implements FRs:** FR14, FR15, FR16 (and re-checks FR11 at launch).

### Unit 1.7 — Orchestrator, Reconciliation & CLI/Host (integrating spine)
- **Layer:** Coordination + entrypoint. **Priority:** 2. **Size:** 8 pts.
- **SPEC:** §7 State Machine, §8 Polling/Scheduling/Reconciliation, §16 Reference Algorithms.
- **Responsibilities:**
  - One poll loop at `polling.interval_ms` (default 30000) with an **immediate first tick** (FR6).
  - Eligibility: active state, not already running, global concurrency cap (FR7); sort priority→
    created_at (FR8); dispatch via single-authority state mutation; in-memory state (FR9).
  - Reconciliation: stop a run when its issue reaches a terminal state (FR17).
  - CLI `symphony ./WORKFLOW.md` + host lifecycle: startup, immediate tick, graceful shutdown (FR20).
  - Reliability: tracker/refresh failures skip the tick / keep workers; observability-sink failures
    never crash the daemon (NFR §5).
- **Deliverables:** `src/orchestrator/*` + `src/cli.ts`; a sample `WORKFLOW.md` and the e2e happy-path
  slice proving the MVP gate (PRD §9).
- **Implements FRs:** FR6, FR7, FR8, FR9, FR17, FR20.

## Coverage check

All MVP FRs (FR1–FR21) are assigned to a unit; see `unit-of-work-story-map.md`. The seven units cover
all eight PRD §6 components (Workflow Loader→1.2, Config→1.2, Notion Tracker→1.3, Orchestrator→1.7,
Workspace Manager→1.4, Agent Runner→1.5, Status Surface→1.6, Logging→1.6).

## Notes / inferences

- **Application Design folded** into this document (component map above) per the user's minimalism
  directive; method-level design is a Construction concern (per-unit Functional Design).
- **`blocked_by` mapping:** normalized from a Notion "blocked by" relation; if the operator's board
  has no such relation, MVP treats it as empty (deferred enrichment is in PRD §5.3). Recorded so the
  bridge carries it into `## Notes`.
- **Test framework** unresolved at INCEPTION (PRD §10); units name `npm run build` / `npm test` as the
  contract and finalize the runner (e.g. vitest or `node:test`) in Construction.
