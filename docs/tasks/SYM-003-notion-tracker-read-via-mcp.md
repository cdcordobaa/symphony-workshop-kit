---
id: SYM-003
title: Notion Tracker (Read) Via MCP
milestone: "M2: Integration And Execution"
priority: 2
estimate: 5
blockedBy: ["SYM-001", "SYM-002"]
blocks: ["SYM-005"]
parent: null
---

## Summary

Implement the read-only Notion tracker adapter behind the `TrackerClient` interface. It connects to
the Notion MCP server, reads issues from the configured Notion database, and normalizes pages into
the spec's domain `Issue` model. Replaces the spec's Linear adapter (§11), keeping normalized
outputs identical to §4.

## Scope

### In scope

- Connect to the Notion MCP server using configured Notion auth (no raw token reads beyond `$VAR`).
  (FR-TR-2)
- `fetchCandidateIssues()`: read pages of the configured Notion database whose Status is in
  `active_states`; paginate; preserve order. (FR-TR-1, FR-TR-4)
- `fetchIssueStatesByIds(ids)`: minimal state refresh for reconciliation. (FR-TR-1)
- Normalize Notion pages → `Issue` (§4.1.1): Status select → `state`; "blocked by" relation →
  `blocked_by[]` (`{id, identifier, state}`); labels/multi-select lowercased; priority → int|null;
  ISO-8601 timestamps parsed; title/identifier/url mapped. (FR-TR-3, FR-DM-1)
- Error taxonomy + behavior: candidate-fetch failure ⇒ log and signal skip-tick to the orchestrator;
  state-refresh failure ⇒ signal keep-workers. (FR-TR-5)
- Read-only boundary: ticket writes are done by the Claude Code agent via its own Notion MCP tools,
  not here. (FR-TR-6)

### Out of scope

- `fetchIssuesByStates()` for startup terminal cleanup (deferred with FR-OR-10).
- Any ticket writes / state transitions from the orchestrator.

## Deliverables

- `src/tracker/notion.ts` (MCP client wiring + the three read operations).
- `src/tracker/normalize.ts` (Notion page → `Issue`).
- `TrackerClient` implementation exported for the orchestrator (U3).

## Acceptance Criteria

- [ ] Candidate fetch returns only issues whose Status ∈ `active_states` from the configured Notion
      database. (FR-TR-1)
- [ ] Connection uses configured Notion auth via the Notion MCP server; no token is read from disk
      outside `$VAR` resolution. (FR-TR-2)
- [ ] Notion pages normalize to the `Issue` model: labels lowercased, priority int|null, timestamps
      parsed, `blocked_by[]` populated from the "blocked by" relation. (FR-TR-3, FR-DM-1)
- [ ] Pagination preserves order across multiple pages. (FR-TR-4)
- [ ] Candidate-fetch failure surfaces a skip-tick signal (no throw across the boundary); refresh
      failure surfaces a keep-workers signal. (FR-TR-5)
- [ ] No code path in this module mutates Notion ticket state. (FR-TR-6)

## Test Plan

- `npm test` against a mocked Notion MCP transport: candidate filter by state, pagination ordering,
  normalization (labels/priority/timestamps/blockers), error→signal mapping.
- `npm run build` passes.
- (Manual/integration, optional) point at a real Notion database via MCP and confirm candidates
  normalize correctly.

## Context

- Read `spec/SYMPHONY-SPEC.md` §11 (tracker contract) and §4.1.1 / §4.2 (issue model + normalization).
- Read `aidlc-docs/inception/requirements/requirements.md` §4.3 (FR-TR-*) and §7 (tracker config).
- Read `aidlc-docs/inception/application-design/unit-of-work.md` → U2.
- Depends on U1 (`TrackerClient` interface, `Issue` type, config) and U2 (logger). Repo path:
  `src/tracker/`.

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

- Inference: exact Notion data-source binding (database id vs data-source id) and the MCP client
  library are resolved at implementation time; the `TrackerClient` interface (U1) insulates the
  orchestrator from that choice.
- Notion replaces Linear (§11); the normalized outputs MUST still match spec §4 per the portability
  clause.
