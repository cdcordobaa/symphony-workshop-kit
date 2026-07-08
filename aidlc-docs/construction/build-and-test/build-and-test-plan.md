# Build & Test Plan — Symphony Orchestrator (Run 2, MVP Walking Skeleton)

> **Stage:** CONSTRUCTION → Build & Test definition. **Branch:** `construction-run-2`.
> **Scope:** how the 7 MVP units (SYM-001…007, Linear ARK-49…55) get built, verified, and
> demonstrated as a *working product at each step*. Closes the five construction gaps G1–G5.
> **Source of truth:** `spec/SYMPHONY-SPEC.md` + `spec/PRD.md`; backlog in
> `docs/tasks/` + Linear milestone **M1: MVP Walking Skeleton**.

## Locked decisions (this plan)

| # | Decision | Choice |
|---|----------|--------|
| B1 | **Build orchestrator** | **Hybrid** — OpenSymphony engine drives waves 0–4 off Linear; the finished TS product dogfoods its own Phase-2 completion (capstone). |
| B2 | **Per-step verification** | **Build + unit tests green + a per-ticket smoke** that shows the unit doing its real job; full real-Notion e2e at SYM-007 = the MVP gate. |
| B3 | **Test harness (G1)** | **vitest** for unit + integration; `tsc` for build. Pinned in SYM-001 so every ticket shares one contract. |
| B4 | **Integration substrate (G3/G4)** | A throwaway **Notion "Symphony Dev Board"** with seed tickets; Notion MCP wired for **both** the orchestrator (read) and the Claude Code agent (ticket writes). |

---

## 1. Test harness & shared contract (G1)

Pinned in **SYM-001** so no later ticket re-litigates it. Every unit codes to this contract:

```jsonc
// package.json scripts (the shared green-bar contract)
{
  "build":   "tsc -p tsconfig.json",           // must compile clean
  "test":    "vitest run",                       // unit + (env-gated) integration
  "test:watch": "vitest",
  "smoke:config":        "tsx smoke/config.ts ./WORKFLOW.md",
  "smoke:observability": "tsx smoke/observability.ts",
  "smoke:tracker":       "tsx smoke/tracker.ts",        // real Notion if NOTION_API_KEY set, else mock
  "smoke:workspace":     "tsx smoke/workspace.ts",
  "smoke:agent":         "tsx smoke/agent.ts",
  "smoke:e2e":           "node dist/cli.js ./WORKFLOW.md --once",  // SYM-007
  "verify":  "npm run build && npm test"         // the gate a ticket must pass before Done
}
```

- **Testing pyramid.** Unit (mocked deps, always run) → Integration (real Notion MCP / real Claude
  Code headless, **env-gated**: skip unless `NOTION_API_KEY` / agent creds present) → E2E (SYM-007
  CLI against the Dev Board) → Dogfood capstone (§5).
- vitest "projects" (or tag filters) separate `unit` from `integration` so CI can run unit-only fast
  and integration on demand.

## 2. Per-ticket Definition of Done (G2) — "working at each step"

Every SYM ticket's agent MUST satisfy this before transitioning the ticket to **Done** (the state
that unblocks its dependents). This is added to each task file's acceptance section and surfaced to
the agent via the target repo's build contract (§6).

```
Definition of Done (per ticket)
  [ ] npm run build   — compiles clean (no TS errors)
  [ ] npm test        — this unit's vitest suite is green
  [ ] npm run smoke:<unit>  — prints evidence the unit does its REAL job (see matrix §3)
  [ ] FR acceptance criteria in the task file are all checked
  [ ] (1.4 / 1.5 only) the three safety invariants pass as explicit checks
  [ ] smoke output / test summary pasted into the Linear ticket as the completion comment
```

The engine only unblocks a dependent when its blocker reaches **Done**; the DoD makes "Done" mean
"a verified, runnable increment," not just "code merged."

## 3. Per-unit smoke matrix (G2) — what each step proves runnable

| Unit | Ticket | Smoke command | Proves (the working increment) |
|------|--------|---------------|--------------------------------|
| 1.1 Domain & ports | SYM-001 | `npm run build` | Types + port interfaces compile; project skeleton + `verify` script run. |
| 1.2 Loader & config | SYM-002 | `smoke:config ./WORKFLOW.md` | Parses a real `WORKFLOW.md`, prints the resolved `ServiceConfig` with **secrets redacted**; a missing `$VAR` is reported. |
| 1.6 Observability | SYM-003 | `smoke:observability` | Emits a structured log line carrying `issue_id`/`issue_identifier`/`session_id` and renders one status line. |
| 1.3 Notion tracker | SYM-004 | `smoke:tracker` | Lists candidate issues from the **real Notion Dev Board** (falls back to mock if no key), normalized to the §4 `Issue` model. |
| 1.4 Workspace + safety | SYM-005 | `smoke:workspace` | Creates a per-issue dir under `workspace.root` and prints **A/B/C invariants = pass** (cwd, root-containment, key-sanitization). |
| 1.5 Agent runner | SYM-006 | `smoke:agent` | Renders a prompt for a sample issue and launches a **trivial Claude Code turn** in a temp workspace (or dry-run render if agent creds absent). |
| 1.7 Orchestrator + CLI | SYM-007 | `smoke:e2e` | **MVP gate:** `symphony ./WORKFLOW.md --once` picks a real Dev-Board ticket → confines a workspace → runs the agent → reconciles on terminal state — all visible in logs + status line. |

## 4. Notion integration substrate & MCP wiring (G3/G4)

The walking skeleton is only "working" if it moves a **real** ticket. Set up once, reused by
`smoke:tracker`, `smoke:e2e`, and integration tests.

### 4.1 Notion "Symphony Dev Board" (throwaway)
A Notion database with the properties the tracker normalizer expects:

- **Status** (select): `Todo`, `In Progress`, `In Review`, `Done`, `Cancelled`
  — active = `["Todo","In Progress"]`, terminal = `["Done","Cancelled"]` (PRD §8 defaults).
- **Priority** (number or select → coerced to int|null).
- **Title** (title), **Labels** (multi-select, lowercased on normalize).
- **Blocked by** (relation → same DB) → `blocked_by[]`; absent ⇒ `[]`.
- **Seed rows:** 2–3 dummy tickets, at least one in `Todo` whose prompt is a trivial, safe task
  (e.g. "create `HELLO.md` saying hi") so the e2e agent can complete it and drive the ticket to a
  terminal state without touching anything real.

### 4.2 MCP wiring — two consumers
- **Orchestrator (read):** reaches Notion via the **Notion MCP server**; `tracker.api_key: $NOTION_API_KEY`
  (resolved from env, never logged, FR21). Used for `fetch_candidate_issues()` + state-refresh.
- **Claude Code agent (write):** the engine launches the agent with Notion MCP configured in its
  workspace (`.mcp.json` or Claude settings) so the agent transitions the ticket / comments **via its
  own tools** — the orchestrator never writes ticket state (PRD §2, spec §11.5).
- **Secrets:** `NOTION_API_KEY` (and any agent creds) live in `.env` / env only; `$VAR` indirection;
  presence-validated without printing.

## 5. Hybrid build orchestration (G5)

### Phase 2a — Engine builds the MVP (waves 0→4)
The **OpenSymphony engine** (`engine/`) polls Linear (M1, ARK-49…55) and launches a Claude Code agent
per ticket, in a workspace clone of this repo. Per ticket the agent implements the unit, runs
`npm run verify` + the unit's smoke (§3), pastes evidence into the ticket, and sets it **Done** —
which unblocks the next wave via the existing blocker relations:

```
Wave 0: SYM-001                     (harness + domain + ports)
Wave 1: SYM-002  SYM-003            (config, observability)
Wave 2: SYM-004  SYM-005            (tracker, workspace+safety)
Wave 3: SYM-006                     (agent runner)
Wave 4: SYM-007   ← MVP GATE        (orchestrator + CLI; real-Notion e2e green)
```

### Phase 2b — Dogfood capstone (the product orchestrates itself)
Once SYM-007 lands and `symphony ./WORKFLOW.md` runs, prove the "working product" claim recursively:

1. Create a Notion board seeded with the **Phase-2 / Core Conformance completion** tickets (PRD §5.3
   deferred set: retry/backoff, continuation turns, stall detection, dynamic reload, startup cleanup,
   token accounting).
2. Point the **built TS Symphony** at that board (`symphony ./WORKFLOW.md`).
3. The product now polls Notion, confines workspaces, and drives **Claude Code** to implement its own
   deferred features — the same role the engine played in 2a.

**Capstone success = the product picks a Phase-2 ticket, runs a confined agent, and reconciles it to
Done, visible in structured logs + the status line.** That is the literal "Symphony as the
orchestrator of its own build."

> Why hybrid, not dogfood-from-the-start: waves 0→3 have no working orchestrator yet, so a reliable
> driver (the engine) is required to reach the first runnable product. Dogfooding becomes possible
> exactly at SYM-007 — so that's where it's introduced, as the capstone proof.

## 6. Surfacing the contract to the engine's agents

The engine-launched agents read the **target repo**, not this `aidlc-docs/` tree. So the build
contract must live where an agent will see it:

- Add a distilled **`BUILD-CONTRACT.md`** at the target repo root (created in SYM-001) containing:
  the `package.json` script contract (§1), the per-ticket DoD (§2), and the safety invariants.
- Reference it from the target repo's `CLAUDE.md` / the `WORKFLOW.md` prompt body so every per-ticket
  agent loads it.
- Mirror the per-ticket DoD into each Linear issue description (or the SYM task files, then re-publish)
  so "Done" has the same meaning on the board and in the repo.

## 7. Definition of Done — for THIS plan

- [x] Test harness pinned (vitest + tsc) — B3/G1.
- [x] Per-ticket DoD + smoke matrix defined — B2/G2.
- [x] Notion Dev Board + MCP wiring for both consumers specified — B4/G3/G4.
- [x] Hybrid orchestration (engine → dogfood capstone) defined — B1/G5.
- [ ] **Actions to execute (need approval):**
  - [ ] Add harness + `BUILD-CONTRACT.md` + smoke-script stubs to **SYM-001** (and re-publish the
        issue, or edit ARK-49 directly).
  - [ ] Add the DoD + smoke line to **SYM-002…007** acceptance sections (+ Linear).
  - [ ] Stand up the Notion "Symphony Dev Board" + seed tickets; put `NOTION_API_KEY` in `.env`.
  - [ ] Confirm the engine is configured to run Claude Code with Notion MCP in the workspace.
  - [ ] Start the engine on ARK-49 (Wave 0) — RUNBOOK Phase 2.
