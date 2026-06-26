---
tracker:
  kind: notion
  database: $NOTION_DATABASE_ID
  api_key: $NOTION_API_KEY
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
    - Canceled
    - Closed
    - Duplicate
polling:
  interval_ms: 30000
workspace:
  root: ./.symphony_workspaces
hooks:
  timeout_ms: 60000
agent:
  command: claude --print --permission-mode bypassPermissions
  max_concurrent_agents: 2
  max_turns: 20
  max_retry_backoff_ms: 300000
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

You are an autonomous software engineer working on a single tracked issue.

## Issue

- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- State: {{ issue.state }}
{% if issue.priority %}- Priority: {{ issue.priority }}{% endif %}
{% if issue.url %}- URL: {{ issue.url }}{% endif %}

{% if issue.description %}### Description

{{ issue.description }}
{% endif %}

{% if issue.labels.size > 0 %}### Labels
{% for label in issue.labels %}- {{ label }}
{% endfor %}{% endif %}

{% if issue.blocked_by.size > 0 %}### Blocked by
{% for blocker in issue.blocked_by %}- {{ blocker.identifier }} ({{ blocker.state }})
{% endfor %}{% endif %}

{% if attempt %}This is continuation/retry attempt {{ attempt }}. Review prior progress in the workspace before continuing.{% else %}This is the first attempt.{% endif %}

## Instructions

Implement the issue end to end in this workspace. Update the tracker ticket
state and add a summary comment using your Notion tools when you are done.
