# AI-DLC Workflow State

> Single source of truth for INCEPTION / CONSTRUCTION progress. The planning AI maintains this
> file. It ships **blank** — you fill it in as you run the workshop. Do not pre-populate it.

## Project

- **Project Name**: _(set during Requirements Analysis)_
- **Project Type**: _(Greenfield | Brownfield — Greenfield for this workshop)_
- **Start Date**: _(set at workflow start)_
- **Source of truth**: `spec/SYMPHONY-SPEC.md`

## Workspace State

- Existing code present? _(no — greenfield)_
- Reverse engineering needed? _(no)_

## Extension Configuration

| Extension | Enabled | Decision Point | Rationale |
|---|---|---|---|
| _(scan `.aidlc-rule-details/extensions/` and record opt-in decisions here)_ | | | |

## Stage Progress

### INCEPTION
- [ ] Workspace Detection
- [ ] Reverse Engineering (conditional — skip for greenfield)
- [ ] Requirements Analysis
- [ ] User Stories (conditional)
- [ ] Workflow Planning
- [ ] Application Design (conditional)
- [ ] Units Generation

### BRIDGE (workshop-specific, not a native AI-DLC stage)
- [ ] aidlc-to-tasks — working units → `docs/tasks/task-package.yaml`
- [ ] convert-tasks-to-linear — task package → Linear issues

### CONSTRUCTION
> In this workshop, CONSTRUCTION is executed by the **OpenSymphony engine** driving Claude agents
> per Linear ticket — not by the planning AI. Track per-ticket status in Linear, not here.

## Current Status

- **Lifecycle phase**: _(not started)_
- **Current stage**: _(not started)_
- **Next stage**: Workspace Detection
- **Brief status**: Fresh kit. Begin with `spec/reading-guide.md`, then start AI-DLC INCEPTION.
