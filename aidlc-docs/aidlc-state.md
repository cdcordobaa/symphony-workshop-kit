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
- [x] convert-tasks-to-linear — **re-published 2026-09-14 to a NEW Linear project**
  `symphony-orchestrator-notion-build-e555d457be74` ("Symphony Orchestrator (Notion) — Build",
  team ARK): SYM-001→**ARK-58** … SYM-007→**ARK-64**, milestone `M1: MVP Walking Skeleton`.
  Mapping: `docs/tasks/linear-publish.yaml`.
  Superseded run: project `symphony-d27271e017ad` (SYM-001→ARK-49 … SYM-007→ARK-55, all Done from the
  `main` build) — mapping archived at `docs/tasks/linear-publish.archive-symphony-d27271e017ad.yaml`.

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

- [ ] Unit implementation — **IN PROGRESS on this branch: 1 of 7 units landed.** The completed M1
  implementation is preserved on `main` (PRs #1–#11 merged, `origin/main` @ `fae4857`); restore any
  path with `git checkout main -- <path>`.
  - [x] **SYM-001 / ARK-58** — §4 domain models + the five port interfaces. PR
        [#12](https://github.com/cdcordobaa/symphony-workshop-kit/pull/12) squash-merged into
        `docs/lab-hand-driven-loop` @ `27116a1` (verified `state=MERGED`, `mergedAt`
        2026-09-15T01:08:10Z); ARK-58 **Done** (`completedAt` 2026-09-15T01:08:11Z). Re-adds
        `BUILD-CONTRACT.md`. On the merged branch `npm run verify` exits 0 (typecheck clean,
        build clean, 10/10 tests) — the TS18003 baseline below is now superseded.
        Executed **by hand** per `docs/LAB-hand-driven-loop.md`, no driver.
  - [ ] SYM-002 / ARK-59 · SYM-003 / ARK-60 — both unblocked by ARK-58, dispatchable next.
  - [ ] SYM-004 / ARK-61 · SYM-005 / ARK-62 · SYM-006 / ARK-63 · SYM-007 / ARK-64 (MVP gate).

## Current Status

- **Lifecycle phase**: CONSTRUCTION — **in progress on this branch** (`docs/lab-hand-driven-loop`),
  1 of 7 M1 units landed.
- **Current stage**: SYM-001/**ARK-58** merged and Done; awaiting the second unit. (Superseded:
  the TS18003 / `tests 0` baseline described below held only until ARK-58 landed.) Historic:
  awaiting first unit — The branch carries the plan (`aidlc-docs/inception/` +
  `construction/build-and-test/build-and-test-plan.md`), the published backlog (`docs/tasks/` +
  Linear), and the build harness only — `package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `WORKFLOW.md`. There is no `src/`, `test/`, or `smoke/`: verified on this branch, `npm run build`
  exits non-zero with `error TS18003: No inputs were found` and `npm test` exits 0 with `tests 0`
  — both expected until the first unit lands. The `smoke:*` npm scripts were removed with their
  files; each unit re-adds its own per `build-and-test-plan.md` B2.
- **Backlog**: 7 MVP units SYM-001…SYM-007 → **ARK-58…ARK-64** (milestone `M1: MVP Walking Skeleton`)
  in Linear project **`symphony-orchestrator-notion-build-e555d457be74`**; mapping in
  `docs/tasks/linear-publish.yaml`. SYM-001/**ARK-58** is the unblocked root; wave order
  58 → (59, 60) → (61, 62) → 63 → **64** (MVP gate).
  ⚠️ All 7 were created in **Backlog**. The driver dispatches only on `tracker.active_states`
  (`Todo`, `In Progress`), so move them to **Todo** before starting a run or nothing is eligible.
  The previous project `symphony-d27271e017ad` (ARK-49…55, Done) is superseded — leave it as the
  record of the `main` build.
- **Next stage**: implement **SYM-002/ARK-59** and **SYM-003/ARK-60** (both unblocked by ARK-58),
  then proceed in wave order to the real-Notion e2e MVP gate at SYM-007/**ARK-64**.
- **Open plan defects raised by the ARK-58 run** (not yet applied to `docs/tasks/`):
  1. `SYM-001` AC says `Issue` exposes *"exactly"* the seven FR5 fields; SPEC §4.1.1 defines
     twelve. Implemented the full entity — the literal reading breaks ARK-63 (strict Liquid,
     §12.2) and ARK-64 (`created_at` sorting, §8.2). AC should read *"at least"*.
  2. `SYM-001` Deliverables say *"the eight §4 entities"* while its own Out-of-scope defers
     §4.1.6 Live Session and §4.1.7 Retry Entry. Should say **six**.
  3. `SYM-001` AC *"`npm test` runs and exits 0"* is vacuously true against an empty suite.
     Every unit's AC should require at least one real assertion.
  4. `BUILD-CONTRACT.md` is required by `build-driver/WORKFLOW.md` and cited by every later
     ticket's DoD, but appears in no task file's Deliverables. Added to SYM-001 in practice.
