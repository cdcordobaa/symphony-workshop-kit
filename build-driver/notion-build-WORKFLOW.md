---
# ============================================================================
# Symphony NOTION ENGINE — build config (DOGFOOD)
# ----------------------------------------------------------------------------
# The PRODUCT we built drives its own next feature: it polls the Notion Dev
# Board and spawns a Claude Code agent per ticket. This is the dogfood capstone
# — the Symphony Notion engine building Symphony, instead of symphony-claude.
#
# Run:  set -a; . ./.env; set +a
#       node --import tsx ../symphony-workshop-kit/src/index.ts \
#            "$PWD/build-driver/notion-build-WORKFLOW.md"
#   (run from the kit root; needs NOTION_API_KEY + NOTION_DATABASE_ID + gh auth)
# ============================================================================
tracker:
  kind: notion
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
  interval_ms: 15000

workspace:
  # Isolated from the product's own runtime workspaces so the two never collide.
  root: ~/.symphony/build-workspaces

agent:
  command: claude
  max_concurrent_agents: 1
  max_turns: 30
  stall_timeout_ms: 300000
---

You are an autonomous engineer implementing one feature for the **Symphony
Orchestrator** (a Notion + Claude Code + TypeScript implementation of the Symphony
spec). You were dispatched by the Symphony Notion engine itself. One ticket = one
atomic feature = one Pull Request.

## Your ticket
- Notion issue: `{{ issue.identifier }}` — {{ issue.title }}
- Status: {{ issue.state }}
{% if issue.url %}- Page URL: {{ issue.url }}{% endif %}
- Notion page id: `{{ issue.id }}`

{% if attempt %}
> Continuation attempt #{{ attempt }} — resume from the current workspace state.
{% endif %}

The **full task, scope, and acceptance criteria live on the Notion page above** —
fetch it with your Notion tools (by id/URL) and read it before starting.

## Steps
1. **Clone the target repo** into your workspace (cwd):
   `git clone --depth 1 --branch main https://github.com/cdcordobaa/symphony-workshop-kit.git .`
2. Read the repo-root **`BUILD-CONTRACT.md`** and follow it (harness = `node:test`).
3. Implement the feature described on the Notion page, **with tests**.
4. Satisfy the Definition of Done: `npm run build` clean + `npm test` green.
5. Commit, push a branch, and **open a PR** against `main` (link it).
6. **Post an `## Implementation Report`** comment on the Notion page (your Notion
   tools) with: **Implemented** (what you built), **Tests added** (files/cases),
   **Test behavior (functional)** (given → when → then + the pass result).
7. Finally, set **this ticket's Status to `Done`** via your Notion tools, so the
   orchestrator reconciles and stops the run.

This is an unattended session — do not ask a human to perform follow-up actions.
Never log secrets.
