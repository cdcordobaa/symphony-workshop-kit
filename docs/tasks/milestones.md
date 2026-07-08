# Project Milestones — Symphony Orchestrator (Run 2)

Planning wave: `symphony-mvp-walking-skeleton`. Scope this pass: the **MVP walking skeleton** only
(PRD §5.2; backlog option B). The Deferred / full Core Conformance set (PRD §5.3) is a later wave.

## M1: MVP Walking Skeleton

Goal: the thinnest end-to-end slice that takes a real Notion ticket and produces a real Claude Code
run with the three safety invariants enforced — proving the PRD §9 MVP gate.

Build/unblock order (dependency-driven):

- **SYM-001** Project Initialization And Core Domain Models — *root; §4 types + ports*
- **SYM-002** Workflow Loader And Typed Config — *§5/§6; depends on SYM-001*
- **SYM-003** Observability — Structured Logging And Terminal Status — *§13; depends on SYM-001*
- **SYM-004** Notion Tracker Client (Read-Only) Via MCP — *§11; depends on SYM-002, SYM-003*
- **SYM-005** Workspace Manager And Safety Invariants — *§9/§15.2; depends on SYM-002, SYM-003*
- **SYM-006** Agent Runner (Claude Code) And Prompt Rendering — *§10/§12; depends on SYM-002, SYM-005, SYM-003*
- **SYM-007** Orchestrator, Reconciliation And CLI/Host — *§7/§8/§16; depends on SYM-004, SYM-005, SYM-006, SYM-003*

Unblock waves:

```
Wave 0:  SYM-001
Wave 1:  SYM-002   SYM-003
Wave 2:  SYM-004   SYM-005
Wave 3:  SYM-006
Wave 4:  SYM-007   (MVP gate demonstrated here)
```
