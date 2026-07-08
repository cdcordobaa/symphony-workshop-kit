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
  Decisions (demo posture — drive everything from OpenSymphony + Linear): **B1** engine + Linear only
  (engine builds all 7 units, waves 0–4; dogfood capstone DEFERRED); **B2** per-ticket DoD =
  build+unit-tests green + a smoke that shows the unit's real job, fixture e2e at SYM-007 = MVP gate;
  **B3** harness = vitest + tsc (pinned in SYM-001); **B4** mocked Notion MCP for the demo (real Notion
  "Symphony Dev Board" + live MCP wiring DEFERRED). Reference tag: `run-2-construction-baseline`.

## Current Status

- **Lifecycle phase**: CONSTRUCTION — Build & Test defined; ready to wire tickets + start the engine
- **Current stage**: Build & Test plan approved on branch `construction-run-2` (engine + Linear demo path); execution actions pending (see plan §7)
- **Next stage**: (1) fold harness + `BUILD-CONTRACT.md` + per-ticket DoD/smoke into SYM-001…007 (+ Linear); (2) wire `engine/WORKFLOW.md` (project slug + target-repo URL); (3) start the engine on ARK-49 (Wave 0)
- **Brief status**: 7 MVP issues live in Linear project `symphony-d27271e017ad` (ARK-49…ARK-55, milestone M1). SYM-001/Unit 1.1 = **ARK-49**, the unblocked root. Build-and-test approach defined in `construction/build-and-test/build-and-test-plan.md`; the demo drives implementation **only from OpenSymphony + Linear** (mocked Notion; real board + dogfood deferred). Per the kit boundary, per-unit implementation is done by the engine driving Claude Code agents per ticket — tracked in Linear, not here.
