---
# Sample WORKFLOW.md — Notion variant (Symphony spec §5, adapted).
#
# This is the repository contract the orchestrator loads on startup. The optional
# YAML front matter below configures the tracker, polling, workspace, hooks, and
# the coding agent. The Markdown body after the closing `---` is the per-issue
# prompt template, rendered with strict Liquid semantics (inputs: `issue`,
# `attempt`).
#
# Notion adaptation vs. the spec's Linear schema:
#   tracker.auth        <- Notion integration token (literal or $VAR; here $NOTION_API_KEY)
#   tracker.database_id <- Notion database id holding the issues (literal or $VAR)
# Per the U1 ticket, the spec's `codex.*` runner fields are repurposed onto `agent.*`.
tracker:
  kind: notion
  # Literal token or `$VAR` indirection. If omitted entirely, the loader falls
  # back to the NOTION_API_KEY environment variable.
  auth: $NOTION_API_KEY
  database_id: $NOTION_DATABASE_ID
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate

polling:
  interval_ms: 30000

workspace:
  # `~` and `$VAR` are expanded; relative paths resolve against this file's directory.
  root: ~/.symphony/workspaces

hooks:
  before_run: |
    git status --short
  after_run: |
    git status --short
  timeout_ms: 60000

agent:
  # Coding-agent launch command (Claude Code runner is wired up in U4).
  command: claude
  max_concurrent_agents: 2
  max_turns: 30
  max_retry_backoff_ms: 300000
  stall_timeout_ms: 300000
---

You are working on a Notion issue `{{ issue.identifier }}` — {{ issue.title }}.

{% if attempt %}
This is retry attempt #{{ attempt }}. Resume from the current workspace state
instead of restarting from scratch.
{% endif %}

Current status: {{ issue.state }}
{% if issue.url %}URL: {{ issue.url }}{% endif %}

{% if issue.labels.size > 0 %}
Labels:
{% for label in issue.labels %}- {{ label }}
{% endfor %}
{% endif %}

{% if issue.blocked_by.size > 0 %}
Blocked by:
{% for blocker in issue.blocked_by %}- {{ blocker.identifier }} ({{ blocker.state }})
{% endfor %}
{% endif %}

Description:
{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}

Implement this issue to its acceptance criteria, with tests. Do not ask a human
to perform follow-up actions; this is an unattended session.

You have Notion tools available. The full task and acceptance criteria live on this
issue's Notion page (see the URL above) — read them there with your Notion tools.
When the work is complete, use your Notion tools to set **this issue's Status to a
terminal state (`Done`)** so the orchestrator reconciles and stops the run.
