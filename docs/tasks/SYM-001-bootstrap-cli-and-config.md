---
id: SYM-001
title: Bootstrap, CLI And Config
milestone: "M1: Foundation And Contracts"
priority: 1
estimate: 5
blockedBy: []
blocks: ["SYM-002", "SYM-003", "SYM-004", "SYM-005"]
parent: null
---

## Summary

Stand up the TypeScript project and the foundation layer: CLI/host lifecycle, the `WORKFLOW.md`
loader, the typed config layer (Notion variant), the shared domain types, and a strict prompt
renderer. This unit (U1) unblocks every other unit.

## Scope

### In scope

- TypeScript single-package project setup (package.json, tsconfig, test runner).
- CLI: positional `path-to-WORKFLOW.md`; default `./WORKFLOW.md`; error on missing explicit path or
  missing default; clean startup-failure surface; exit 0 on normal start/shutdown, non-zero on
  startup failure. (FR-CLI-1)
- Workflow Loader: read `WORKFLOW.md`, split optional YAML front matter (`---` delimited) from the
  trimmed prompt body; absent front matter ⇒ empty config + whole file as prompt; non-map front
  matter is a typed error. (FR-WL-1, FR-WL-2)
- Typed Config Layer: defaults; `$VAR` indirection only for values that reference it; `~` home
  expansion and relative-path resolution (relative to the `WORKFLOW.md` dir) for path fields; the
  adapted Notion front-matter schema (`requirements.md` §7). (FR-WL-3, FR-WL-7)
- Dispatch preflight validation (startup + per-tick): workflow loads/parses; `tracker.kind=notion`
  supported; Notion auth present after `$` resolution; Notion database id present; agent command
  present. (FR-WL-6)
- Shared domain types: `Issue` (+ blocker ref), `ServiceConfig`, `OrchestratorRuntimeState`, and the
  `TrackerClient` / `AgentRunner` / `WorkspaceManager` interfaces consumed by later units. (§4)
- Strict prompt renderer (Liquid-compatible): unknown variables/filters fail rendering; inputs are
  the normalized `issue` object and `attempt` (int|null); preserve nested arrays/maps. (FR-WL-5, FR-PR-1)

### Out of scope

- Dynamic `WORKFLOW.md` watch/reload (deferred FR-WL-4 — later iteration).
- Any Notion API calls, agent launching, or orchestration (later units).

## Deliverables

- `package.json`, `tsconfig.json`, test-runner config.
- `src/index.ts` (CLI entrypoint / host lifecycle).
- `src/config/` (workflow loader + typed config + `$VAR`/path resolution + preflight validation).
- `src/domain/` (Issue, config, runtime-state types; tracker/agent/workspace interfaces).
- `src/prompt/` (or `src/config/render.ts`) strict prompt renderer.
- A sample `WORKFLOW.md` (Notion variant) for local runs.

## Acceptance Criteria

- [ ] CLI uses an explicit workflow path when provided and `./WORKFLOW.md` otherwise; errors on a
      nonexistent explicit path or missing default. (FR-CLI-1)
- [ ] Loader splits front matter + prompt body; absent front matter ⇒ empty config; non-map front
      matter returns a typed error. (FR-WL-2)
- [ ] Config defaults apply for missing optional values; `$VAR` resolves only where referenced; `~`
      and relative path resolution work for path fields. (FR-WL-3)
- [ ] Preflight validation passes with a valid Notion workflow and fails (operator-visible) when
      `tracker.kind`, Notion auth, Notion database id, or agent command is missing. (FR-WL-6)
- [ ] Prompt renders `issue` and `attempt`; rendering fails on unknown variables/filters. (FR-WL-5)
- [ ] Domain types + the three consumer interfaces compile and are exported for later units. (§4)

## Test Plan

- `npm test` (unit tests for loader, config resolution, `$VAR`/path expansion, preflight validation,
  strict renderer happy-path + unknown-variable failure).
- `npm run build` / `tsc --noEmit` passes.
- A fixture `WORKFLOW.md` parses into the expected typed config.

## Context

- Read `spec/SYMPHONY-SPEC.md` §5 (Workflow Spec), §6 (Configuration), §12 (Prompt), §17.7 (CLI).
- Read `aidlc-docs/inception/requirements/requirements.md` §7 (adapted Notion front matter) and §4.
- Read `aidlc-docs/inception/application-design/unit-of-work.md` → U1.
- Repo paths to create: `src/index.ts`, `src/config/`, `src/domain/`, `src/prompt/`.

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Implements the MVP walking-skeleton slice only (`requirements.md` §6.1.1). Dynamic reload
  (FR-WL-4) is intentionally deferred and will extend this module later.
- Front-matter `codex.*` is repurposed to `agent.*` for the Claude Code runner (see U4).
