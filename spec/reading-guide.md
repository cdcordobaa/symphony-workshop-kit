# Symphony SPEC — Reading Guide

`SYMPHONY-SPEC.md` in this folder is the **canonical OpenAI Symphony service specification**
(fetched verbatim from `github.com/openai/symphony`). It is the single source of truth for the
workshop: everything you plan in Phase 1 is *derived from this document*, not invented.

> You are not implementing OpenSymphony (the Rust engine in `engine/`). You are implementing
> **your own** Symphony-spec orchestrator from scratch. OpenSymphony is only the engine that
> drives the agents that build it.

## How the workshop uses the spec

```
SYMPHONY-SPEC.md  ──(AI-DLC: Requirements → Units)──▶  aidlc-docs/ working units
       │                                                        │
       │                                          (/aidlc-to-tasks)
       ▼                                                        ▼
  source of truth                              docs/tasks/task-package.yaml
                                                                │
                                              (/convert-tasks-to-linear)
                                                                ▼
                                                   Linear milestones + issues
```

## Recommended reading order (first pass, ~20 min)

Read these sections to understand *what must be built* before you run AI-DLC:

1. **§1 Problem Statement** + **§2 Goals and Non-Goals** — the bounded scope. Note the non-goals;
   they keep the build small enough to finish in a workshop.
2. **§3 System Overview** — the eight components and six layers. This is your component map and a
   strong hint at how to decompose into working units.
3. **§4 Core Domain Model** — Issue, Workflow Definition, Service Config, Workspace, Run Attempt,
   Live Session, Retry Entry, Orchestrator Runtime State. These become your domain types.
4. **§5 Workflow Specification (Repository Contract)** — the `WORKFLOW.md` format (YAML front
   matter + Markdown prompt body) your orchestrator must load.

## Deep-read sections (these drive the bulk of the units)

| Spec section | Becomes (working unit area) |
|---|---|
| **§5** Workflow Specification + **§6** Configuration | Workflow Loader / Config Layer |
| **§7** Orchestration State Machine | Orchestrator Core (Unclaimed → Claimed → Running → RetryQueued → Released) |
| **§8** Polling, Scheduling, and Reconciliation | Polling loop, candidate selection, retry/backoff, stall detection |
| **§9** Workspace Management and Safety | Workspace Manager + lifecycle hooks + 3 safety invariants |
| **§10** Agent Runner Protocol | Agent Runner (subprocess launch, turn streaming, timeouts) |
| **§11** Issue Tracker Integration (Linear) | Tracker Client (fetch candidates / terminal / running) |
| **§12** Prompt Construction | Prompt rendering (template + issue + attempt) |
| **§13** Logging, Status, Observability | Logging + optional status surface / HTTP API |
| **§14** Failure Model + **§15** Security | Cross-cutting NFRs (apply to every unit) |
| **§16** Reference Algorithms | Pseudocode you can lift directly into tasks |
| **§17** Test/Validation Matrix + **§18** Definition of Done | Acceptance criteria + your conformance target |
| **Appendix A** SSH Worker Extension | OPTIONAL — out of scope for the base workshop |

## Scoping advice for a workshop-sized build

- Target **§18.1 Core Conformance** (the required components). Treat **§18.2** recommended
  extensions and **Appendix A** as out of scope unless you have extra time.
- §16's reference algorithms (startup, tick loop, reconciliation, dispatch, worker lifecycle,
  retry) map almost one-to-one onto Orchestrator-Core tasks — cite them in your task `Test Plan`.
- The three workspace **safety invariants** in §9 (agent cwd confinement, path-root containment,
  identifier sanitization) should each become an explicit acceptance-criterion checkbox.

When you start AI-DLC, point it at this file. The `reading-guide` table above is the seed for the
milestone/unit decomposition it will produce.
