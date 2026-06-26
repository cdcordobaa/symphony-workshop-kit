---
# ============================================================================
# OpenSymphony engine config for the Symphony Workshop (Phase 2).
# This WORKFLOW.md is read by the Rust OpenSymphony orchestrator. It selects the
# EXPERIMENTAL, LOCAL-ONLY Claude Code CLI harness (the top-level `claude:` key
# is what triggers it). Fill the two <PLACEHOLDER> values before running.
# ============================================================================
tracker:
  kind: linear
  # Linear project slugId (from the project URL: linear.app/<team>/project/<name>-<slug>).
  # This MUST be the project your Phase-1 backlog was published into.
  project_slug: "symphony-d27271e017ad"
  # tracker.api_key is optional; the loader falls back to LINEAR_API_KEY.
  active_states:
    - Todo
    - In Progress
    - Human Review
    - Merging
    - Rework
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate

polling:
  interval_ms: 5000

workspace:
  # `~` and exact $VAR/${VAR} tokens are expanded during config resolution.
  root: ~/.opensymphony/workspaces

hooks:
  # Clone the participant's TARGET repo into each per-issue workspace. The agent
  # runs with cwd == workspace root, so it implements inside this checkout.
  # Replace with your fork/remote of the target repo (the one seeded from
  # ../target-repo-template/).
  after_create: |
    git clone 'https://github.com/cdcordobaa/symphony-workshop-kit.git' .
  before_run: |
    git status --short
  after_run: |
    git status --short
  before_remove: |
    git status --short
  timeout_ms: 120000

agent:
  # Keep concurrency low for a workshop demo. The Claude harness is single-user,
  # local-only; raise cautiously.
  max_concurrent_agents: 2
  max_turns: 30
  max_retry_backoff_ms: 300000
  stall_timeout_ms: 300000

# `openhands:` must be present and well-formed even when the Claude harness is
# selected — the config loader validates the whole front-matter up front. Only
# the transport base_url is required here; OpenHands is not actually launched.
openhands:
  transport:
    base_url: "http://127.0.0.1:8000"

# The presence of this `claude:` block selects the Claude Code CLI harness.
# `claude: {}` alone is valid (all defaults). Defaults shown for clarity:
#   command: claude
#   permission_mode: dangerously-skip-permissions
#   verbose: true
#   session_reuse: per_issue
#   mcp.linear.enabled: true
#   mcp.linear.api_key_env: LINEAR_API_KEY
claude:
  mcp:
    linear:
      enabled: true
      api_key_env: LINEAR_API_KEY
---

You are working on a Linear ticket `{{ issue.identifier }}` in an unattended OpenSymphony
orchestration session.

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- Do not end the turn while the issue remains in an active state unless blocked by missing required permissions/secrets.
{% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Only stop early for a true blocker (missing required auth/permissions/secrets). If blocked, record it in the workpad and move the issue according to this workflow.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy (the cloned target repo). Do not touch any other path.

## Prerequisite: `LINEAR_API_KEY` is available

The agent must talk to Linear through the repo-local `linear` skill
(`.agents/skills/linear/`) using `LINEAR_API_KEY`. If the key is not present, treat that as a real
blocker and follow the blocked path below.

## What you are building

The cloned repo is an implementation of the **Symphony service specification**. The ticket you are
assigned is one working unit of that spec. Implement it to its acceptance criteria, with tests.

## Default posture

- Determine the ticket's current status first, then follow the matching flow.
- Open/refresh the single persistent `## Agent Harness Workpad` comment before new implementation work.
- Spend effort up front on planning and a verification design before implementation.
- Reproduce/establish current behavior before changing code where applicable.
- Keep ticket metadata current; treat one workpad comment as the source of truth for progress.
- Mirror any ticket `Validation`/`Test Plan`/`Testing` section into the workpad as required, non-optional checkboxes and execute it.
- Move status only when the matching quality bar is met. Operate autonomously end-to-end unless truly blocked.

## Related skills (in the cloned repo)

- `linear`: interact with Linear (workpad comments, state transitions, PR attachment).
- `commit`: produce clean, logical commits.
- `push`: keep the remote branch current and open/update the PR.
- `pull`: sync with latest `origin/main` before handoff.
- `land`: when the ticket reaches `Merging`, follow `.agents/skills/land/SKILL.md`.

## Status map

- `Backlog` -> out of scope; do not modify.
- `Todo` -> queued; immediately transition to `In Progress` before active work.
- `In Progress` -> implementation actively underway.
- `Human Review` -> PR attached and validated; waiting on human approval.
- `Merging` -> approved by human; follow the `land` skill flow (never call `gh pr merge` directly).
- `Rework` -> reviewer requested changes; address in the same PR/branch by default.
- `Done` -> terminal; do nothing.

## Execution flow (Todo / In Progress)

1. Fetch the issue, read its state, and route per the status map.
2. For `Todo`: move to `In Progress`, then find/create the `## Agent Harness Workpad` comment.
3. Reconcile the workpad: check off done items; make the plan comprehensive for current scope;
   ensure `Acceptance Criteria` and `Validation` are current.
4. Run `pull` to sync `origin/main`; record the result in the workpad `Notes`.
5. Implement against the hierarchical TODOs, keeping the workpad current after each milestone.
6. Run the required validation/tests for the scope (mandatory gate for any ticket-provided
   validation). Iterate until green.
7. Commit (`commit` skill), then `push` to open/update the PR.
8. Attach the PR to the issue via the `linear` skill (`attachment_link_github_pr.graphql`). Ensure
   the PR has the `symphony` label.
9. Run the PR feedback sweep (Linear comments + top-level PR comments + inline review comments +
   checks). Address each actionable item or record explicit pushback in-thread.
10. When the completion bar is met, move the issue to `Human Review`.

## Blocked-access escape hatch

Use only for missing required tools or auth/permissions that cannot be resolved in-session. GitHub
is not a valid blocker by default — try fallback strategies first and document them. For a genuine
non-GitHub blocker, move to `Human Review` with a short blocker brief in the workpad: what is
missing, why it blocks acceptance, and the exact human action needed to unblock.

## Completion bar before Human Review

- Workpad checklist is complete and accurate.
- Acceptance criteria and any ticket-provided validation items are complete.
- Validation/tests are green for the latest commit.
- PR feedback sweep is complete; PR checks green; branch pushed; PR linked on the issue with the
  `symphony` label.

## Workpad template

```md
## Agent Harness Workpad

` ` `text
<hostname>:<abs-path>@<short-sha>
` ` `

### Plan
- [ ] 1. Parent task
  - [ ] 1.1 Child task

### Acceptance Criteria
- [ ] Criterion 1

### Validation
- [ ] targeted tests: `<command>`

### Notes
- YYYY-MM-DD HH:MMZ: State transition / reproduction / validation / PR event
```
