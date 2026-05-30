# Symphony (workshop build)

This repository **will become a Symphony-spec orchestrator**, implemented from scratch during the
workshop. It starts nearly empty: the implementation is produced ticket-by-ticket by Claude Code
agents launched by the **OpenSymphony engine**, working from a Linear backlog that was planned with
AI-DLC against the canonical Symphony specification.

## What is Symphony?

A long-running service that polls an issue tracker (Linear), creates an isolated workspace per
issue, and runs a coding agent in that workspace — plus the orchestration state machine, retry/
reconciliation, workspace safety, and observability around it. The authoritative spec lives in the
workshop kit at `spec/SYMPHONY-SPEC.md`.

## How this repo gets built

1. **Planning (kit):** AI-DLC decomposes the spec into working units → `/aidlc-to-tasks` →
   `docs/tasks/task-package.yaml` → `/convert-tasks-to-linear` publishes Linear issues.
2. **Implementing (engine):** OpenSymphony polls Linear, clones this repo into a per-issue
   workspace, and a Claude agent implements the ticket, opens a PR, and moves the issue to review.

## For agents working in this repo

- Read **`AGENTS.md`** for build/test commands and invariants (filled in once the stack is chosen
  during AI-DLC Requirements Analysis).
- Use the repo-local skills in `.agents/skills/` (`linear`, `commit`, `push`, `pull`, `land`).
- Follow the orchestration prompt/protocol delivered by the engine's `WORKFLOW.md`.

## Status

Greenfield. See the Linear project for the live backlog and per-ticket progress.
