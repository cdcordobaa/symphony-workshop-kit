# AI-DLC Workflow State

> Single source of truth for INCEPTION / CONSTRUCTION progress. The planning AI maintains this
> file. It ships **blank** — you fill it in as you run the workshop. Do not pre-populate it.

## Project

- **Project Name**: Symphony Orchestrator (Notion + Claude Code + TypeScript) _(provisional — confirmed in Requirements Analysis)_
- **Project Type**: Greenfield
- **Start Date**: 2026-06-26
- **Source of truth**: `spec/SYMPHONY-SPEC.md` + `spec/PRD.md` (locked variant decisions D1–D8)

## Workspace State

- Existing code present? **No** for the target build. Only the Rust OpenSymphony **engine** (`engine/`, the Phase-2 driver) and `target-repo-template/` exist — neither is the target orchestrator. No TypeScript target code present.
- Reverse engineering needed? **No** (greenfield target → skip Reverse Engineering)
- Workspace root: `/Volumes/Life-OS/Users/Arkatechie/Development/claude-code-skills/symphony-workshop-kit`

## Extension Configuration

| Extension | Enabled | Decision Point | Rationale |
|---|---|---|---|
| Security Baseline (`extensions/security/baseline`) | **No** | Requirements Analysis | Decided by PRD **D7** (workshop-grade, opted out). Safety invariants §9.5/§15.2 remain hard requirements regardless. |

## Stage Progress

### INCEPTION
- [x] Workspace Detection
- [~] Reverse Engineering — SKIPPED (greenfield target)
- [x] Requirements Analysis — `requirements.md` (MVP-scoped, Q1=B)
- [~] User Stories — SKIPPED (infra daemon; personas pre-defined in PRD §4)
- [x] Workflow Planning — `plans/execution-plan.md`
- [~] Application Design — FOLDED into Units Generation (component map from PRD §6 embedded in `unit-of-work.md`)
- [x] Units Generation — `application-design/unit-of-work*.md` (7 MVP units, milestone M1)

### BRIDGE (workshop-specific, not a native AI-DLC stage)
- [x] aidlc-to-tasks — working units → `docs/tasks/task-package.yaml` (7 tasks SYM-001…007, milestone M1; validator + dry-run exit 0)
- [x] convert-tasks-to-linear — published to Linear project `symphony-d27271e017ad`: SYM-001→ARK-49 … SYM-007→ARK-55 (milestone M1). Mapping: `docs/tasks/linear-publish.yaml`

### CONSTRUCTION
> In this workshop, CONSTRUCTION is executed by the **OpenSymphony engine** driving Claude agents
> per Linear ticket — not by the planning AI. Track per-ticket status in Linear, not here.
- [x] Build & Test definition — `construction/build-and-test/build-and-test-plan.md` (branch `construction-run-2`).
  Decisions: **B1** implementation driven by **symphony-claude ("Symphony Cloud") + Linear** (TS
  Symphony reimpl at `../symphony-claude`, polls Linear + launches Claude Code per ticket; replaces the
  Rust OpenSymphony engine which is not cloud-ready). Builds all 7 units, waves 0–4; dogfood capstone
  DEFERRED. **B2** per-ticket DoD = build+unit-tests green + a smoke that shows
  the unit's real job, **real-Notion e2e at SYM-007 = MVP gate**; **B3** harness = **node:test** (`node --import tsx --test`) + tsc — aligned to the existing ARK-49 scaffolding (pinned
  in SYM-001); **B4** **real Notion + MCP is REQUIRED for verification** (unit tests mock for speed, but
  SYM-004 + SYM-007 carry required integration/e2e tests against a live Notion "Symphony Dev Board" —
  NOT deferred; the product's value is the Notion connection). Reference tag: `run-2-construction-baseline`.

## Current Status

- **Lifecycle phase**: CONSTRUCTION — Build & Test defined; ready to wire tickets + start the engine
- **Current stage**: Build & Test plan approved on branch `construction-run-2` (engine + Linear demo path); execution actions pending (see plan §7)
- **Next stage**: (1) ✅ DONE — **Notion "Symphony Dev Board"** provisioned (db `1c7826ea19e443b9addd794981606d56`, data-source `c29d9c6a-0db6-4dcb-bb52-66a0ac769468`; seed DEV-1 Todo + DEV-2 Done); Notion access via the connected claude.ai connector (no key needed); (2) fold harness + `BUILD-CONTRACT.md` + per-ticket DoD/smoke into SYM-001…007 (+ Linear); (3) driver config drafted at `build-driver/WORKFLOW.md` (Linear `d27271e017ad` + target-repo clone + per-ticket DoD prompt); Notion access for SYM-004/006/007 agents = connected `claude.ai Notion` connector by default (optional local-server `.mcp.json` + `NOTION_API_KEY` fallback at `build-driver/notion.mcp.json`); (4) start the driver (`node ../symphony-claude/dist/index.js "$PWD/build-driver/WORKFLOW.md" --port 3000`) on ARK-49 (Wave 0)
- **Brief status**: 7 MVP issues live in Linear project `symphony-d27271e017ad` (ARK-49…ARK-55, milestone M1). SYM-001/Unit 1.1 = **ARK-49**, the unblocked root. Build-and-test approach defined in `construction/build-and-test/build-and-test-plan.md`: implementation is driven **only from OpenSymphony + Linear**, but **verification is against a real Notion board via MCP** (SYM-004/007 — required, not deferred). Only the dogfood capstone is deferred. Per-unit implementation is done by **symphony-claude ("Symphony Cloud")** driving Claude Code agents per Linear ticket — tracked in Linear, not here. **Target repo = THIS kit repo** (`cdcordobaa/symphony-workshop-kit`): the product is built here alongside the plan (greenfield `src/` at root). SYM-001/ARK-49 already scaffolded on origin branch `arkatechie/ark-49-sym-001-bootstrap-cli-and-config` (`src/domain`, `src/config`, `src/prompt`, `test/`) — but it uses **node:test** (not the planned vitest) and has **no BUILD-CONTRACT.md/smoke scripts**. Reconciliation DONE. **ARK-49 (SYM-001) merged to `main` and set Done** — PR #1 (`ef68aea`) integrated (domain types, config loader, prompt renderer, CLI skeleton, node:test suites); `npm ci && npm run build && npm test` = **47/47 green on main**. `construction-run-2` fast-forwarded into `main`, which now carries plan + `docs/tasks/` + `BUILD-CONTRACT.md` + `src/` + `test/`. **ARK-50…55 set to Todo**; the driver honors blocker eligibility (`dispatcher.ts` — Todo dispatches only when all blockers are terminal), so it will build in wave order (50,51 → 52,53 → 54 → 55) with ARK-55's real-Notion e2e as the MVP gate. Ready to start the driver.
