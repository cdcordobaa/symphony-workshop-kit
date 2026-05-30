# Symphony Workshop Kit

A self-contained kit for a hands-on workshop: **build a Symphony-spec orchestrator from scratch,
using OpenSymphony as the engine.** It bundles everything needed to plan the work with **AI-DLC**,
publish it to **Linear**, and have the **OpenSymphony** orchestrator drive Claude Code agents that
implement each ticket.

> **The mental model:** you use *OpenSymphony* (a working orchestrator) to build *your own*
> orchestrator that satisfies the same **Symphony specification** — planning with AI-DLC, executing
> with OpenSymphony. The implementation plan is **not** shipped: producing it is the workshop.

## The two phases

```
        PHASE 1 — PLANNING (you + Claude Code, in this kit)
  spec/SYMPHONY-SPEC.md
        │  AI-DLC INCEPTION (Requirements → Workflow Planning → Units)
        ▼
  aidlc-docs/ working units
        │  /aidlc-to-tasks   (the bridge skill)
        ▼
  docs/tasks/task-package.yaml + task files
        │  /convert-tasks-to-linear apply
        ▼
  Linear: milestones + issues + sub-issues + blockers
  ─────────────────────────────────────────────────────────────
        PHASE 2 — IMPLEMENTING (OpenSymphony engine)
  engine/WORKFLOW.md (Claude harness) + engine/config.yaml
        │  opensymphony run  → polls Linear, clones target repo per issue
        ▼
  Claude agents implement each ticket → open PRs → move issues to Human Review
```

## What's in the kit

| Path | Purpose |
|---|---|
| `spec/SYMPHONY-SPEC.md` | Canonical OpenAI Symphony spec — the source of truth. |
| `spec/reading-guide.md` | Section map + how the spec drives the decomposition. |
| `CLAUDE.md` | Planning persona + AI-DLC workflow + skills catalog (read by Claude Code here). |
| `.aidlc-rule-details/` | The AI-DLC framework rules (pre-installed). |
| `aidlc-docs/` | AI-DLC working dir — **ships empty**; you fill it live. |
| `.agents/skills/` | Planning skills: `linear`, `create-implementation-plan`, **`aidlc-to-tasks`**, `convert-tasks-to-linear`, `commit`, `debug`. |
| `.claude/commands/` | Slash-command wrappers for the skills. |
| `engine/` | OpenSymphony wiring: `WORKFLOW.md` (Claude harness), `config.yaml`, `engine-setup.md`. |
| `target-repo-template/` | Seed for the repo agents build into (skills + AGENTS.md + PR template). |
| `RUNBOOK.md` | ⭐ Step-by-step participant runbook for both phases. |
| `facilitator/` | Facilitator guide + preflight checklist. |
| `.env.example` | Required environment variables. |

## Quickstart (5 minutes)

```bash
cp .env.example .env          # fill LINEAR_API_KEY + ANTHROPIC_API_KEY
set -a; . ./.env; set +a

# Confirm Linear auth (planning side)
python3 .agents/skills/linear/scripts/linear_graphql.py \
  --query-file .agents/skills/linear/queries/viewer.graphql
```

Then open this folder in **Claude Code** and follow **`RUNBOOK.md`**. Facilitators: start with
`facilitator/preflight-checklist.md`.

## Prerequisites

- A Linear workspace + API key, and an empty Linear project for the backlog.
- `claude` CLI (authenticated), `python3`, `uv`, `git`, `gh` (authenticated).
- Rust toolchain + a local checkout of the OpenSymphony engine (see `engine/engine-setup.md`).

## Caveat

Phase 2 uses OpenSymphony's **experimental, local-only Claude harness**
(`--dangerously-skip-permissions`, plaintext per-workspace `mcp.json`). Run it only on a trusted,
single-user machine against a repo you control. Details in `engine/engine-setup.md`.
