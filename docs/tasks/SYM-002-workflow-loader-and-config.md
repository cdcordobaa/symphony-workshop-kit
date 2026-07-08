---
id: SYM-002
title: Workflow Loader And Typed Config
milestone: "M1: MVP Walking Skeleton"
priority: 1
estimate: 5
blockedBy: ["SYM-001"]
blocks: ["SYM-004", "SYM-005", "SYM-006"]
parent: null
---

## Summary

Load `WORKFLOW.md` (YAML front matter + Markdown prompt body) and build a typed `ServiceConfig` with
defaults, `$VAR` resolution, and path normalization (Unit 1.2). This is the Configuration layer the
adapters consume.

## Scope

### In scope

- Parse `WORKFLOW.md`: split YAML front matter from the Markdown prompt body into a
  `WorkflowDefinition`.
- Build typed `ServiceConfig` applying the PRD §8 Notion-variant defaults.
- Resolve `$VAR` indirection from the environment (e.g. `$NOTION_API_KEY`).
- Normalize `workspace.root` (`~`, `$VAR`, relative → absolute).
- Validate required-for-dispatch fields: `tracker.kind`, `tracker.database`, resolved
  `tracker.api_key` (empty after resolution ⇒ reported missing) — **without printing secret values**.

### Out of scope

- Dynamic watch/reload of `WORKFLOW.md` (deferred — PRD §5.3).
- Hook execution (`hooks.*` parsed/defaulted but unused in MVP).
- Using the config (consumed by SYM-003…SYM-007).

## Deliverables

- `src/config/` — loader, schema/types population of `ServiceConfig`, `$VAR` + path resolution.
- A sample `WORKFLOW.md` fixture for tests.

## Acceptance Criteria

- [ ] A valid `WORKFLOW.md` parses into a `WorkflowDefinition` (front matter + prompt body). [FR1]
- [ ] Defaults from PRD §8 apply when fields are omitted. [FR2]
- [ ] `$VAR` values resolve from env; unresolved required secrets are flagged. [FR2]
- [ ] `workspace.root` with `~`/`$VAR`/relative resolves to an absolute path. [FR2]
- [ ] Missing `tracker.api_key` after resolution is reported as missing; **no secret value is ever
      logged or printed**. [FR21]

## Test Plan

- `npm test` — unit tests for: front-matter/body split, default application, `$VAR` resolution,
  path normalization, and the secret-presence-without-printing check.
- `npm run build` — compiles cleanly.

## Context

- Read `spec/SYMPHONY-SPEC.md` §5 (Workflow Specification) and §6 (Configuration); §15.3 (secrets).
- PRD §8 (Notion-variant config contract) for field names + defaults.
- Source working unit: `aidlc-docs/inception/application-design/unit-of-work.md` → Unit 1.2.
- Repo paths: `src/config/`; consumes `src/domain/` types from SYM-001.

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Implements FR1, FR2, FR21. `agent.max_turns`/`stall_timeout_ms`/`max_retry_backoff_ms` are parsed
  and defaulted but exercise only the MVP subset (one turn, no retry) — full use lands in the deferred
  Core Conformance pass.
