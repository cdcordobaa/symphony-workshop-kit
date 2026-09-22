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

#### PHASE 2 — Core Conformance Completion (the PRD §5.3 deferred set)
> Driven by the **dogfood capstone**: the built product polls its own Notion Dev Board and launches a
> Claude Code agent per DEV-### ticket. One ticket = one PR.
- [x] Exponential retry/backoff + retry queue (§8.4/§16.6) — present on `main` before Phase 2 dogfooding (`src/orchestrator/retry.ts`, `smoke:retry`).
- [x] Per-state concurrency caps (§8.3) — present on `main` (`src/orchestrator/concurrency.ts`).
- [x] Startup terminal workspace cleanup (§8.6) — present on `main` (`Orchestrator.cleanupTerminalWorkspaces`, `test/orchestrator/startup-cleanup.test.ts`).
- [x] **Dynamic `WORKFLOW.md` watch/reload (§6.2) — DEV-5.** `src/config/watcher.ts` (injected watch seam
  + reject-and-keep-last-good) + `Orchestrator.applyConfig` (live `polling.interval_ms` /
  `agent.max_concurrent_agents`, pending tick re-armed). Tests in `test/orchestrator/config-reload.test.ts`;
  evidence via `npm run smoke:reload`.
- [ ] Multi-turn continuation on the same thread up to `max_turns` (§12.3).
- [ ] Stall detection (§8.5 Part A).
- [ ] Token/runtime accounting + rate-limit tracking (§13.3).
- [ ] `after_create`/`before_remove` hooks + optional workspace population (§9.3/§9.4).

## Current Status

- **Lifecycle phase**: CONSTRUCTION — **Phase 2: Core Conformance Completion**, executed as the **dogfood capstone** (the product driving its own Notion Dev Board). M1 MVP walking skeleton remains complete (all 7 units merged to `main`).
- **Most recent ticket**: **DEV-5 — Dynamic `WORKFLOW.md` watch/reload (spec §6.2)** — IMPLEMENTED, PR open, ticket **In Review** (not merged). Added `src/config/watcher.ts` (`reloadWorkflow` + `ConfigWatcher` over an injected `WorkflowWatch` seam; `createFsWatch` watches the containing directory so atomic editor saves are still seen) and `Orchestrator.applyConfig` (swaps the config reference, re-applies `polling.interval_ms` — re-arming an already-sleeping tick — and `agent.max_concurrent_agents`, plus the retry backoff cap). A reload that fails to read/parse/resolve/preflight is REJECTED: logged at `error` with `outcome=rejected`, previous good config retained, nothing thrown. In-flight runs are never disturbed. FR21 holds: `tracker.auth` is compared in memory but never logged. Verified on this branch: `npm ci && npm run build && npm test` → build clean, **223 tests / 222 pass / 1 skipped / 0 fail** (baseline on `main` was 208 / 207 pass); `npm run smoke:reload` PASS (real `fs.watch`, good edit applied live, malformed edit rejected, daemon alive); `smoke:config`, `smoke:retry`, `smoke:e2e` still PASS.
- **Known scope boundary recorded for DEV-5** (not a defect in the delivered work, but a residual gap vs spec §6.2): the reload re-applies everything the **orchestrator** reads off its config (poll interval, global + per-state concurrency, active/terminal state sets, retry backoff cap). It does **not** yet rebind the **agent runner's** prompt template / `agent.command` or the **workspace manager's** root — those are still bound at `buildRuntime` construction time, so a change to the `WORKFLOW.md` prompt body or workspace root still needs a restart. The DEV-5 brief scoped the ticket to `polling.interval_ms` + `agent.max_concurrent_agents`; closing the rest of §6.2 ("prompt content for future runs", workspace paths/hooks) wants a follow-up ticket. The §6.2 SHOULD for a defensive re-validate before each dispatch (in case a filesystem watch event is missed) is likewise not wired.
- **Previous milestone**: ✅ **M1: MVP Walking Skeleton COMPLETE** (all 7 units merged to `main`)
- **Current stage**: MVP gate GREEN. All 7 PRs (#1–#7) merged; ARK-49…ARK-55 all **Done**. On integrated `main`: `npm run build` clean, `npm test` = 167 pass / 1 skipped / 0 fail, `npm run smoke:e2e` = MVP walking skeleton PASS end-to-end (real Notion pipeline + confined workspace + agent HELLO.md + terminal reconcile). Driver stopped (no work left). Reference tag: `run-2-mvp-gate`.
- **Next stage** (optional, post-MVP): (1) ✅ DONE — **truly-live run** executed: added `RestNotionMcp` (live Notion REST transport + integration token, PR #8) and ran `node dist/index.js ./WORKFLOW.md` against the real Dev Board — daemon read DEV-1 `Todo` via REST → spawned a real Claude Code agent → agent wrote `HELLO.md` and set DEV-1 `Done` via its connector → daemon reconciled (`0 active`). Read path uses the integration token; write path rides the agent's connector; (2) **Phase 2: Core Conformance Completion** — re-run INCEPTION for the PRD §5.3 deferred set (retry/backoff, continuation turns, stall detection, dynamic reload, startup cleanup, token accounting); (3) the **dogfood capstone** — point the built product at a Notion board of Phase-2 tickets so it drives its own next iteration
- **Brief status**: 7 MVP issues live in Linear project `symphony-d27271e017ad` (ARK-49…ARK-55, milestone M1). SYM-001/Unit 1.1 = **ARK-49**, the unblocked root. Build-and-test approach defined in `construction/build-and-test/build-and-test-plan.md`: implementation is driven **only from OpenSymphony + Linear**, but **verification is against a real Notion board via MCP** (SYM-004/007 — required, not deferred). Only the dogfood capstone is deferred. Per-unit implementation is done by **symphony-claude ("Symphony Cloud")** driving Claude Code agents per Linear ticket — tracked in Linear, not here. **Target repo = THIS kit repo** (`cdcordobaa/symphony-workshop-kit`): the product is built here alongside the plan (greenfield `src/` at root). SYM-001/ARK-49 already scaffolded on origin branch `arkatechie/ark-49-sym-001-bootstrap-cli-and-config` (`src/domain`, `src/config`, `src/prompt`, `test/`) — but it uses **node:test** (not the planned vitest) and has **no BUILD-CONTRACT.md/smoke scripts**. Reconciliation DONE. **ARK-49 (SYM-001) merged to `main` and set Done** — PR #1 (`ef68aea`) integrated (domain types, config loader, prompt renderer, CLI skeleton, node:test suites); `npm ci && npm run build && npm test` = **47/47 green on main**. `construction-run-2` fast-forwarded into `main`, which now carries plan + `docs/tasks/` + `BUILD-CONTRACT.md` + `src/` + `test/`. **ARK-50…55 set to Todo**; the driver honors blocker eligibility (`dispatcher.ts` — Todo dispatches only when all blockers are terminal), so it will build in wave order (50,51 → 52,53 → 54 → 55) with ARK-55's real-Notion e2e as the MVP gate. Ready to start the driver.
