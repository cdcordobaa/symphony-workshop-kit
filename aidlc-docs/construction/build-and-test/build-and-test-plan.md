# Build & Test Plan — Symphony Orchestrator (Run 2, MVP Walking Skeleton)

> **Stage:** CONSTRUCTION → Build & Test definition. **Branch:** `construction-run-2`.
> **Scope:** how the 7 MVP units (SYM-001…007, Linear ARK-49…55) get built, verified, and
> demonstrated as a *working product at each step*. Closes the five construction gaps G1–G5.
> **Source of truth:** `spec/SYMPHONY-SPEC.md` + `spec/PRD.md`; backlog in
> `docs/tasks/` + Linear milestone **M1: MVP Walking Skeleton**.

## Locked decisions (this plan)

| # | Decision | Choice |
|---|----------|--------|
| B1 | **Build orchestrator** | **Engine + Linear only (demo path).** The OpenSymphony engine drives all 7 units (waves 0–4) off Linear; a Claude Code agent implements each ticket. *The dogfood capstone (product orchestrates its own Phase-2 completion) is **DEFERRED** — see §5.* |
| B2 | **Per-step verification** | **Build + unit tests green + a per-ticket smoke** that shows the unit doing its real job; an end-to-end walking-skeleton run at SYM-007 = the MVP gate. |
| B3 | **Test harness (G1)** | **vitest** for unit + integration; `tsc` for build. Pinned in SYM-001 so every ticket shares one contract. |
| B4 | **Integration substrate (G3/G4)** | **Mocked Notion MCP for the demo.** Tracker + e2e run against an in-memory/mocked tracker so the build needs no live Notion. *A real Notion "Symphony Dev Board" + live MCP wiring is **DEFERRED** — see §4.* |

> **Demo posture:** everything is driven from **OpenSymphony + Linear**. No live Notion board, no
> product-drives-itself step is required to reach the MVP gate. The deferred items (§4, §5) are kept
> here verbatim as the reference for the next iteration — they are *paused, not dropped*.

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
  "smoke:tracker":       "tsx smoke/tracker.ts",        // mocked Notion for the demo (real MCP deferred, §4)
  "smoke:workspace":     "tsx smoke/workspace.ts",
  "smoke:agent":         "tsx smoke/agent.ts",
  "smoke:e2e":           "node dist/cli.js ./WORKFLOW.md --once",  // SYM-007, mocked tracker fixture
  "verify":  "npm run build && npm test"         // the gate a ticket must pass before Done
}
```

- **Testing pyramid.** Unit (mocked deps, always run) → Integration (env-gated; real Notion MCP / real
  Claude Code headless only when creds are present — **off for the demo**) → E2E (SYM-007 CLI against a
  mocked tracker fixture) → *Dogfood capstone (deferred, §5)*.
- vitest "projects" (or tag filters) separate `unit` from `integration` so the demo runs unit + smoke
  fast, and the deferred real-Notion integration slots in later without rework.

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
| 1.3 Notion tracker | SYM-004 | `smoke:tracker` | Normalizes **mocked** Notion rows to the §4 `Issue` model and filters by active state. (Real board deferred, §4.) |
| 1.4 Workspace + safety | SYM-005 | `smoke:workspace` | Creates a per-issue dir under `workspace.root` and prints **A/B/C invariants = pass** (cwd, root-containment, key-sanitization). |
| 1.5 Agent runner | SYM-006 | `smoke:agent` | Renders a prompt for a sample issue and launches a **trivial Claude Code turn** in a temp workspace (or dry-run render if agent creds absent). |
| 1.7 Orchestrator + CLI | SYM-007 | `smoke:e2e` | **MVP gate:** `symphony ./WORKFLOW.md --once` takes a **fixture** candidate → confines a workspace → runs the agent → reconciles when the fixture flips terminal — all visible in logs + status line. |

> The SYM-007 e2e uses an in-memory/fixture tracker so the walking skeleton is demonstrable with **no
> live Notion**. Swapping the fixture for the real Notion MCP tracker is the first deferred step (§4).

## 4. DEFERRED (post-demo) — real Notion substrate & MCP wiring (G3/G4)

Kept here as the reference for the next iteration. **Not needed for the engine+Linear demo.**

### 4.1 Notion "Symphony Dev Board" (throwaway) — *deferred*
A Notion database with the properties the tracker normalizer expects:
- **Status** (select): `Todo`, `In Progress`, `In Review`, `Done`, `Cancelled`
  (active = `["Todo","In Progress"]`, terminal = `["Done","Cancelled"]`, PRD §8 defaults).
- **Priority**, **Title**, **Labels** (multi-select), **Blocked by** (relation → `blocked_by[]`).
- 2–3 seed rows, ≥1 in `Todo` with a trivial safe task, so a real e2e can drive a real ticket.

### 4.2 MCP wiring — two consumers — *deferred*
- **Orchestrator (read):** Notion MCP; `tracker.api_key: $NOTION_API_KEY` (resolved from env, never
  logged). Replaces the demo's mocked tracker.
- **Claude Code agent (write):** launched with Notion MCP in its workspace so it transitions the
  ticket / comments via its own tools (orchestrator never writes ticket state, PRD §2 / spec §11.5).

**When to un-defer:** after the MVP gate is green on the mocked path, point SYM-004/SYM-007 at a real
Dev Board and re-run `smoke:tracker` + `smoke:e2e` against it.

## 5. Build orchestration

### 5.1 Demo path (B1) — Engine builds the MVP off Linear (waves 0→4)
The **OpenSymphony engine** (`engine/`) polls Linear (M1, ARK-49…55) and launches a Claude Code agent
per ticket, in a workspace clone of the target repo. Per ticket the agent implements the unit, runs
`npm run verify` + the unit's smoke (§3), pastes evidence into the ticket, opens a PR, and moves the
issue to review — which unblocks the next wave via the existing blocker relations:

```
Wave 0: SYM-001                     (harness + domain + ports)
Wave 1: SYM-002  SYM-003            (config, observability)
Wave 2: SYM-004  SYM-005            (tracker[mocked], workspace+safety)
Wave 3: SYM-006                     (agent runner)
Wave 4: SYM-007   ← MVP GATE        (orchestrator + CLI; fixture e2e green)
```

### 5.2 DEFERRED (post-demo) — Dogfood capstone
Once SYM-007 lands and `symphony ./WORKFLOW.md` runs, the recursion becomes possible: seed a tracker
board with the Phase-2 / Core Conformance tickets (PRD §5.3) and point the **built product** at it so
it drives Claude Code to implement its own deferred features. **Paused for the demo** — reintroduce
after the MVP gate, together with the real Notion substrate (§4).

## 6. Surfacing the contract to the engine's agents

The engine-launched agents read the **target repo**, not this `aidlc-docs/` tree. So the build
contract must live where an agent will see it:

- Add a distilled **`BUILD-CONTRACT.md`** at the target repo root (created in SYM-001): the
  `package.json` script contract (§1), the per-ticket DoD (§2), and the safety invariants.
- Reference it from the target repo's `CLAUDE.md` / the `WORKFLOW.md` prompt body so every per-ticket
  agent loads it.
- Mirror the per-ticket DoD into each Linear issue description (or the SYM task files, then re-publish)
  so "done" has the same meaning on the board and in the repo.

## 7. Definition of Done — for THIS plan

- [x] Test harness pinned (vitest + tsc) — B3/G1.
- [x] Per-ticket DoD + smoke matrix defined — B2/G2.
- [x] Demo substrate = mocked Notion; real board + MCP wiring captured as deferred — B4/G3/G4.
- [x] Orchestration = engine + Linear only; dogfood capstone captured as deferred — B1/G5.
- [ ] **Actions to execute (engine + Linear demo):**
  - [ ] Add harness + `BUILD-CONTRACT.md` + smoke-script stubs to **SYM-001** (edit ARK-49 / re-publish).
  - [ ] Add the DoD + smoke line to **SYM-002…007** acceptance sections (+ Linear).
  - [ ] Wire the engine (`engine/WORKFLOW.md`: project slug + target-repo clone URL) — RUNBOOK §2.1.
  - [ ] Start the engine on ARK-49 (Wave 0) — RUNBOOK §2.3.
- [ ] **Deferred (post-demo):** real Notion Dev Board + MCP (§4); dogfood capstone (§5.2).
