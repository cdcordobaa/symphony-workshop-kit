# Unit of Work — Story Map (FR → Unit)

User Stories were skipped, so this maps the **MVP functional requirements** (`requirements.md`
§6.1.1 / §4) to their owning unit. Every MVP FR is assigned to exactly one unit. Deferred FRs are
listed at the end with the unit that will own them post-MVP.

## MVP FR Assignments

| FR (MVP slice) | Description | Unit | Spec |
|---|---|---|---|
| FR-CLI-1 | CLI workflow-path arg + default + exit codes | U1 | §17.7 |
| FR-WL-1 | Workflow path resolution | U1 | §5.1 |
| FR-WL-2 | Front matter / prompt body split | U1 | §5.2 |
| FR-WL-3 | Typed config + defaults + `$VAR` + path resolution | U1 | §6.1 |
| FR-WL-5 | Strict prompt template rendering primitive | U1 | §5.4, §12 |
| FR-WL-6 | Dispatch preflight validation (startup + per tick) | U1 | §6.3 |
| FR-WL-7 | Adapted Notion front-matter schema | U1 | §5.3 |
| FR-DM-1 | Normalized `Issue` model | U1 (type) / U2 (populate) | §4.1.1 |
| FR-DM-2 | Identifier/normalization rules (sanitize, lowercase, session id) | U1 + U4 | §4.2 |
| FR-DM-3 | Orchestrator runtime state | U3 | §4.1.8 |
| FR-TR-1 | `fetchCandidateIssues` + state refresh | U2 | §11.1 |
| FR-TR-2 | Notion MCP connection + auth | U2 | §11.2 |
| FR-TR-3 | Notion → domain normalization | U2 | §11.3 |
| FR-TR-4 | Pagination + ordering | U2 | §11.2 |
| FR-TR-5 | Tracker error → skip-tick behavior | U2 + U3 | §11.4 |
| FR-TR-6 | Read-only boundary (agent does writes) | U2 | §11.5 |
| FR-OR-2 | Poll tick sequence | U3 | §8.1, §16.2 |
| FR-OR-3 | Candidate eligibility (incl. Todo blocker rule) | U3 | §8.2 |
| FR-OR-4 | Dispatch sort order | U3 | §8.2 |
| FR-OR-5 (global) | Global concurrency slots | U3 | §8.3 |
| FR-OR-8 (Part B) | Basic terminal-state reconciliation | U3 | §8.5 |
| FR-WS-1 | Per-issue workspace create/reuse | U4 | §9.1–9.2 |
| FR-WS-2 (partial) | `before_run`/`after_run` hooks + timeout | U4 | §9.4 |
| **FR-WS-3a** | Agent cwd == workspace_path (SAFETY) | U4 | §9.5, §15.2 |
| **FR-WS-3b** | workspace_path within root (SAFETY) | U4 | §9.5, §15.2 |
| **FR-WS-3c** | Sanitized workspace key (SAFETY) | U4 | §9.5, §15.2 |
| FR-AG-1 | Launch Claude Code headless in workspace | U4 | §10.1 |
| FR-AG-2 | Abstract Agent Runner interface | U4 | §10.7 |
| FR-AG-3 | Session/thread/turn ids + `session_id` | U4 | §10.2 |
| FR-AG-4 | Streaming turn + completion/error mapping | U4 | §10.3 |
| FR-AG-5 | Emit runtime events upstream | U4 | §10.4 |
| FR-AG-6 | High-trust approval posture | U4 | §10.5 |
| FR-PR-1 | Render prompt with `issue` + `attempt` (strict) | U4 (via U1) | §12 |
| FR-PR-2 | `attempt` first/continuation/retry distinction | U4 | §12.3 |
| FR-OB-1 | Structured logs + required context fields | U5 | §13.1 |
| FR-OB-2 | Operator-visible failures; sink resilience | U5 | §13.2 |
| FR-OB-4 (minimal) | Simple terminal status surface | U5 | §13.3–13.4 |
| NFR-SAFETY | 3 invariants verified before launch | U4 | §9.5 |
| NFR-SECRETS | `$VAR`; never log secrets | U1 + U5 | §15.3 |
| NFR-RELIABILITY | Graceful degrade (skip tick / keep workers) | U3 | §14.2 |
| NFR-RECOVERY | In-memory state; tracker/fs restart recovery | U3 | §14.3 |
| NFR-CONCURRENCY | Single-authority state; bounded concurrency | U3 | §7.4, §8.3 |
| NFR-PERF | Fixed poll cadence; immediate first tick | U3 | §8.1 |

## Coverage Check
- ✅ Every MVP FR in `requirements.md` §6.1.1 is assigned to a unit.
- ✅ All 3 safety invariants (FR-WS-3 a/b/c) are owned by U4 with explicit acceptance checks.
- ✅ No MVP FR is unassigned or assigned to more than one owning unit (shared rows note primary
  owner + collaborator).

## Deferred FRs (post-MVP) → future owning unit
| FR | Description | Future Unit |
|---|---|---|
| FR-WL-4 | Dynamic WORKFLOW.md watch/reload | U1 |
| FR-OR-6, FR-OR-7 | Exponential retry/backoff + retry queue + continuation retries | U3 |
| FR-OR-5 (per-state) | Per-state concurrency caps | U3 |
| FR-OR-8 (Part A) | Stall detection | U3 |
| FR-OR-9 | Multi-turn continuation up to max_turns | U3 + U4 |
| FR-OR-10 | Startup terminal workspace cleanup | U3 + U2 (terminal fetch) |
| FR-OB-3 | Token/runtime accounting + rate limits | U5 + U4 |
| FR-WS-2 (rest), FR-WS-4 | after_create/before_remove hooks, workspace population | U4 |
