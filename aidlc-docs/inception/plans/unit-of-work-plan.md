# Unit of Work Plan — Symphony Orchestrator MVP

> Fast-path: decomposition decisions resolved with sensible MVP defaults (no blocking questions —
> a single-process greenfield daemon has no real grouping/ownership ambiguity). Assumptions are
> stated inline. User approved proceeding straight to Units Generation.

## Decomposition Decisions (resolved)

- **Deployment model**: a **single deployable Node.js process** (one daemon). "Units" are **logical
  modules** within one TypeScript package, not separate services.
- **Code organization (greenfield)**: single package, `src/<module>/` per unit; shared domain types
  + config live in the bootstrap module. (See `unit-of-work.md` → Code Organization.)
- **Grouping basis**: by spec component/layer (§3) — the cleanest seams and the easiest to test.
- **Scope**: only the MVP walking-skeleton slice (`requirements.md` §6.1.1). Deferred items are NOT
  units yet; each will extend its owning module later.
- **Stories**: none (User Stories skipped) → the **story map maps Functional Requirements** to units.

## Units (5)

- **U1 — Bootstrap, CLI & Config** (Workflow Loader + Config Layer + shared domain types + CLI/host)
- **U2 — Notion Tracker (read) via MCP** (Integration Layer, read-only)
- **U3 — Orchestrator Core** (Coordination Layer: poll/dispatch/eligibility/basic reconcile)
- **U4 — Workspace & Agent Runner** (Execution Layer: workspace + safety invariants + Claude Code)
- **U5 — Observability** (structured logging + simple terminal status)

## Generation Checklist

- [x] Generate `aidlc-docs/inception/application-design/unit-of-work.md` (definitions, responsibilities, code org)
- [x] Generate `aidlc-docs/inception/application-design/unit-of-work-dependency.md` (dependency matrix + build order)
- [x] Generate `aidlc-docs/inception/application-design/unit-of-work-story-map.md` (FR → unit mapping)
- [x] Document greenfield code organization strategy in `unit-of-work.md`
- [x] Validate unit boundaries and dependencies
- [x] Ensure all MVP FRs are assigned to a unit
