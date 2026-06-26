# Project Milestones — Symphony MVP (Walking Skeleton)

Planning wave: `symphony-mvp-walking-skeleton`. Build order follows the unit dependency matrix:
`SYM-001 → SYM-002 → (SYM-003 ∥ SYM-004) → SYM-005`.

## M1: Foundation And Contracts

Goal: Stand up the TypeScript project and the foundation everything depends on — CLI/host, the
`WORKFLOW.md` loader, typed config (Notion variant), shared domain types + interfaces, the strict
prompt renderer, and the observability primitives.

Tasks:

- SYM-001 Bootstrap, CLI And Config
- SYM-002 Observability — Structured Logs And Terminal Status

## M2: Integration And Execution

Goal: Build the two adapters the orchestrator drives — the read-only Notion tracker (via the Notion
MCP server) and the workspace + Claude Code agent runner (with the mandatory filesystem-safety
invariants).

Tasks:

- SYM-003 Notion Tracker (Read) Via MCP
- SYM-004 Workspace Manager And Claude Code Agent Runner

## M3: Orchestration Core

Goal: Integrate everything into a single-authority poll loop (fetch → select → dispatch →
reconcile), yielding the runnable end-to-end walking skeleton.

Tasks:

- SYM-005 Orchestrator Core — Poll, Dispatch And Reconcile
