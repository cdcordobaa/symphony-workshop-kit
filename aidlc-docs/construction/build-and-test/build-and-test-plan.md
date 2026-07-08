# Build & Test Plan — Symphony Orchestrator (Run 2, MVP Walking Skeleton)

> **Stage:** CONSTRUCTION → Build & Test definition. **Branch:** `construction-run-2`.
> **Scope:** how the 7 MVP units (SYM-001…007, Linear ARK-49…55) get built, verified, and
> demonstrated as a *working product at each step*. Closes the five construction gaps G1–G5.
> **Source of truth:** `spec/SYMPHONY-SPEC.md` + `spec/PRD.md`; backlog in
> `docs/tasks/` + Linear milestone **M1: MVP Walking Skeleton**.

## Locked decisions (this plan)

| # | Decision | Choice |
|---|----------|--------|
| B1 | **Build orchestrator** | **Engine + Linear only.** The OpenSymphony engine drives all 7 units (waves 0–4) off Linear; a Claude Code agent implements each ticket. *The dogfood capstone (product orchestrates its own Phase-2 completion) is **DEFERRED** — see §5.2.* |
| B2 | **Per-step verification** | **Build + unit tests green + a per-ticket smoke** that shows the unit doing its real job; a real-Notion end-to-end run at SYM-007 = the MVP gate. |
| B3 | **Test harness (G1)** | **vitest** for unit + integration; `tsc` for build. Pinned in SYM-001 so every ticket shares one contract. |
| B4 | **Integration substrate (G3/G4)** | **Real Notion + MCP is REQUIRED for verification** — the product's value *is* the Notion connection, so we prove it against a live board. Unit tests mock Notion for speed/determinism; **SYM-004 and SYM-007 additionally carry required integration/e2e tests that hit a real Notion "Symphony Dev Board" via MCP.** Not deferred. |

> **Two separate axes — don't conflate them:**
> - *Implementation* is driven entirely from **OpenSymphony + Linear** (the engine builds every unit;
>   there is **no** product-drives-itself/dogfood step — that stays deferred, §5.2).
> - *Verification* is **not** mock-only. Because a Symphony orchestrator that can't actually read/drive
>   its tracker is not a working product, the MVP gate is proven against a **real Notion board via MCP**
>   (§4, required). Only the dogfood capstone is paused.

---

## 1. Test harness & shared contract (G1)

Pinned in **SYM-001** so no later ticket re-litigates it. Every unit codes to this contract:

```jsonc
// package.json scripts (the shared green-bar contract)
{
  "build":   "tsc -p tsconfig.json",           // must compile clean
  "test":    "vitest run",                       // unit always; integration when creds present
  "test:watch": "vitest",
  "test:integration": "vitest run --project integration",  // real Notion MCP + real agent turn
  "smoke:config":        "tsx smoke/config.ts ./WORKFLOW.md",
  "smoke:observability": "tsx smoke/observability.ts",
  "smoke:tracker":       "tsx smoke/tracker.ts",        // hits the real Notion Dev Board via MCP (§4)
  "smoke:workspace":     "tsx smoke/workspace.ts",
  "smoke:agent":         "tsx smoke/agent.ts",
  "smoke:e2e":           "node dist/cli.js ./WORKFLOW.md --once",  // SYM-007, real Notion board (§4)
  "verify":  "npm run build && npm test"         // the gate a ticket must pass before Done
}
```

- **Testing pyramid.**
  - **Unit** (mocked deps, always run) — fast, deterministic; every unit.
  - **Integration (REQUIRED, credential-gated):** real **Notion MCP** read/normalize (SYM-004) and a
    real **Claude Code headless** turn (SYM-006). Gated on creds — but the engine gives those agents the
    creds, so the gate is *satisfied*, not skipped. A run with no creds must fail loudly for SYM-004/007,
    never silently pass.
  - **E2E (SYM-007):** the CLI against the **real Notion Dev Board** = the MVP gate.
  - *Dogfood capstone* — deferred (§5.2).
- vitest "projects" separate `unit` from `integration` so unit+smoke stay fast while the required
  real-Notion integration runs on the agents that have `NOTION_API_KEY`.

## 2. Per-ticket Definition of Done (G2) — "working at each step"

Every SYM ticket's agent MUST satisfy this before transitioning the ticket to its review/terminal
state (which unblocks its dependents). Added to each task file's acceptance section and surfaced to
the agent via the target repo's build contract (§6).

```
Definition of Done (per ticket)
  [ ] npm run build   — compiles clean (no TS errors)
  [ ] npm test        — this unit's vitest suite is green
  [ ] npm run smoke:<unit>  — prints evidence the unit does its REAL job (see matrix §3)
  [ ] FR acceptance criteria in the task file are all checked
  [ ] (SYM-004, SYM-007) the REQUIRED real-Notion integration/e2e test passes against the Dev Board
  [ ] (1.4 / 1.5 only) the three safety invariants pass as explicit checks
  [ ] smoke output / test summary pasted into the Linear ticket as the completion comment
```

The engine only unblocks a dependent when its blocker is done; the DoD makes "done" mean "a verified,
runnable increment," not just "code merged."

## 3. Per-unit smoke matrix (G2) — what each step proves runnable

| Unit | Ticket | Smoke command | Proves (the working increment) |
|------|--------|---------------|--------------------------------|
| 1.1 Domain & ports | SYM-001 | `npm run build` | Types + port interfaces compile; project skeleton + `verify` script run. |
| 1.2 Loader & config | SYM-002 | `smoke:config ./WORKFLOW.md` | Parses a real `WORKFLOW.md`, prints the resolved `ServiceConfig` with **secrets redacted**; a missing `$VAR` is reported. |
| 1.6 Observability | SYM-003 | `smoke:observability` | Emits a structured log line carrying `issue_id`/`issue_identifier`/`session_id` and renders one status line. |
| 1.3 Notion tracker | SYM-004 | `smoke:tracker` | Lists candidate issues from the **real Notion Dev Board via MCP**, normalized to the §4 `Issue` model, filtered by active state. Unit tests mock; a **required** integration test hits the live board. |
| 1.4 Workspace + safety | SYM-005 | `smoke:workspace` | Creates a per-issue dir under `workspace.root` and prints **A/B/C invariants = pass** (cwd, root-containment, key-sanitization). |
| 1.5 Agent runner | SYM-006 | `smoke:agent` | Renders a prompt for a sample issue and launches a **real trivial Claude Code turn** in a temp workspace. |
| 1.7 Orchestrator + CLI | SYM-007 | `smoke:e2e` | **MVP gate:** `symphony ./WORKFLOW.md --once` reads a **real** `Todo` ticket from the Notion Dev Board via MCP → confines a workspace → runs the Claude Code agent → reconciles when the ticket reaches a **real terminal state** — all visible in logs + status line. |

> The SYM-007 e2e runs against the **real Notion Dev Board** (§4) — that is what guarantees we built a
> *working* product, not a mockable stand-in. A fast in-memory fixture may also exist for CI speed, but
> the MVP gate is the real-Notion run.

## 4. Notion integration substrate & MCP wiring (G3/G4) — REQUIRED

The product's value is the Notion connection, so verification runs against a **real** board. Set up
once; reused by `smoke:tracker`, `smoke:e2e`, and the required integration tests.

### 4.1 Notion "Symphony Dev Board" (throwaway)
A Notion database with the properties the tracker normalizer expects:
- **Status** (select): `Todo`, `In Progress`, `In Review`, `Done`, `Cancelled`
  (active = `["Todo","In Progress"]`, terminal = `["Done","Cancelled"]`, PRD §8 defaults).
- **Priority**, **Title**, **Labels** (multi-select), **Blocked by** (relation → `blocked_by[]`).
- 2–3 seed rows, ≥1 in `Todo` whose task is a trivial, safe, self-contained instruction, so a real
  e2e can drive a real ticket without touching anything of consequence.

### 4.2 MCP wiring — two consumers (both required for the MVP gate)
- **Orchestrator (read):** reaches Notion via the **Notion MCP server**; `tracker.api_key: $NOTION_API_KEY`
  (resolved from env, never logged, FR21). Used for `fetch_candidate_issues()` + state-refresh.
- **Claude Code agent (write):** launched with Notion MCP in its workspace so it transitions the
  ticket / comments via its own tools — the orchestrator never writes ticket state (PRD §2 / spec §11.5).

> **Closing the loop end to end:** make the seed `Todo` ticket's task be *"use your Notion tools to
> move this ticket to Done"* (plus a trivial file write). That single e2e exercises **both** MCP paths:
> the agent-write path transitions the real ticket, and the orchestrator observes the real terminal
> state and reconciles. That is the strongest cheap proof that the product actually works.

## 5. Build orchestration

### 5.1 Engine builds the MVP off Linear (waves 0→4) — B1
The **OpenSymphony engine** (`engine/`) polls Linear (M1, ARK-49…55) and launches a Claude Code agent
per ticket, in a workspace clone of the target repo. Per ticket the agent implements the unit, runs
`npm run verify` + the unit's smoke (§3), pastes evidence into the ticket, opens a PR, and moves the
issue to review — which unblocks the next wave via the existing blocker relations:

```
Wave 0: SYM-001                     (harness + domain + ports)
Wave 1: SYM-002  SYM-003            (config, observability)
Wave 2: SYM-004  SYM-005            (tracker[REAL Notion via MCP], workspace+safety)
Wave 3: SYM-006                     (agent runner, real Claude Code turn)
Wave 4: SYM-007   ← MVP GATE        (orchestrator + CLI; REAL-Notion e2e green)
```

> The agents building **SYM-004** and **SYM-007** (and SYM-006) must be given `NOTION_API_KEY` +
> Notion MCP (and agent creds) **in their workspace**, or their required integration/e2e tests cannot
> pass. This is an engine-wiring prerequisite (§7), not an optional extra.

### 5.2 DEFERRED (post-demo) — Dogfood capstone
Once SYM-007 lands and `symphony ./WORKFLOW.md` runs, the recursion becomes possible: seed a tracker
board with the Phase-2 / Core Conformance tickets (PRD §5.3) and point the **built product** at it so
it drives Claude Code to implement its own deferred features. **Paused** — implementation stays on
OpenSymphony + Linear for now; reintroduce after the MVP gate.

## 6. Surfacing the contract to the engine's agents

The engine-launched agents read the **target repo**, not this `aidlc-docs/` tree. So the build
contract must live where an agent will see it:

- Add a distilled **`BUILD-CONTRACT.md`** at the target repo root (created in SYM-001): the
  `package.json` script contract (§1), the per-ticket DoD (§2), the safety invariants, and the
  real-Notion integration requirement for SYM-004/007.
- Reference it from the target repo's `CLAUDE.md` / the `WORKFLOW.md` prompt body so every per-ticket
  agent loads it.
- Mirror the per-ticket DoD into each Linear issue description (or the SYM task files, then re-publish)
  so "done" means the same on the board and in code.

## 7. Definition of Done — for THIS plan

- [x] Test harness pinned (vitest + tsc) — B3/G1.
- [x] Per-ticket DoD + smoke matrix defined — B2/G2.
- [x] Verification substrate = **real Notion + MCP required** (unit tests mock; SYM-004/007 hit a live board) — B4/G3/G4.
- [x] Orchestration = engine + Linear only; dogfood capstone deferred — B1/G5.
- [ ] **Actions to execute (engine + Linear):**
  - [ ] Stand up the **Notion "Symphony Dev Board"** + seed tickets; put `NOTION_API_KEY` in `.env` (§4). **Required.**
  - [ ] Add harness + `BUILD-CONTRACT.md` + smoke-script stubs to **SYM-001** (edit ARK-49 / re-publish).
  - [ ] Add the DoD + smoke line to **SYM-002…007**; give **SYM-004 + SYM-007** the required real-Notion integration/e2e criteria (+ Linear).
  - [ ] Ensure the engine gives the **SYM-004 / SYM-006 / SYM-007** agents `NOTION_API_KEY` + Notion MCP (and agent creds) in their workspace.
  - [ ] Wire the engine (`engine/WORKFLOW.md`: project slug + target-repo clone URL) — RUNBOOK §2.1.
  - [ ] Start the engine on ARK-49 (Wave 0) — RUNBOOK §2.3.
- [ ] **Deferred (post-demo):** dogfood capstone (§5.2).
