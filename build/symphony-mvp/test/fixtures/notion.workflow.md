---
tracker:
  kind: notion
  database: db_123abc
  api_key: $TEST_NOTION_KEY
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
polling:
  interval_ms: 15000
workspace:
  root: ./ws
agent:
  command: claude --print
  max_concurrent_agents: 3
  max_turns: 5
---

Work the issue {{ issue.identifier }}: {{ issue.title }}.
