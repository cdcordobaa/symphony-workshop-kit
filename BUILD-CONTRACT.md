# BUILD-CONTRACT.md — how every ticket must be built & verified

You are an **implementation agent** building the **Symphony Orchestrator** (a Notion + Claude Code +
TypeScript implementation of the Symphony spec) into **this repo**, one Linear ticket at a time.
One ticket = one atomic unit = one PR. This contract is the shared bar for every ticket.

> Full rationale: `aidlc-docs/construction/build-and-test/build-and-test-plan.md`. Your unit's scope +
> acceptance criteria: `docs/tasks/SYM-###-*.md` (and the Linear issue description).

## Project layout (greenfield, TypeScript at repo root)

```
package.json  tsconfig.json  tsconfig.build.json
src/domain/        # §4 domain types + port interfaces (Issue, WorkflowDefinition, ServiceConfig, …)
src/config/        # WORKFLOW.md loader + typed config + $VAR + path normalization
src/observability/ # structured logger + terminal status
src/tracker/       # Notion MCP client + row→Issue normalization
src/workspace/     # Workspace Manager + 3 safety invariants
src/agent/         # Agent Runner (Claude Code) + strict prompt rendering
src/orchestrator/  # poll loop, eligibility, dispatch, reconciliation
src/index.ts       # CLI entrypoint `symphony ./WORKFLOW.md`
test/              # node:test unit specs;  test/integration/ = real-service specs
smoke/             # one runnable smoke per unit (see below)
```

Do **not** modify `aidlc-docs/`, `spec/`, `docs/tasks/`, `build-driver/`, or `engine/` unless your
ticket explicitly says so — those are the plan and the build driver, not the product.

## Script contract (package.json) — harness = node:test + tsx

```jsonc
{
  "build":       "tsc -p tsconfig.build.json",
  "typecheck":   "tsc -p tsconfig.json --noEmit",
  "test":        "node --import tsx --test \"test/**/*.test.ts\"",
  "test:integration": "node --import tsx --test \"test/integration/**/*.test.ts\"",
  "smoke:config": "tsx smoke/config.ts ./WORKFLOW.md",
  "smoke:observability": "tsx smoke/observability.ts",
  "smoke:tracker": "tsx smoke/tracker.ts",
  "smoke:workspace": "tsx smoke/workspace.ts",
  "smoke:agent": "tsx smoke/agent.ts",
  "smoke:e2e": "node --import tsx src/index.ts ./WORKFLOW.md --once",
  "verify": "npm run build && npm test"
}
```

If a script does not exist yet and your ticket owns it, add it. Keep existing ones working.

## Definition of Done — you may not move the ticket to review until ALL hold

- [ ] `npm run build` compiles clean.
- [ ] `npm test` (this unit's `test/*.test.ts`) is green.
- [ ] `npm run smoke:<unit>` prints evidence the unit does its **real** job (see matrix).
- [ ] Every acceptance-criteria checkbox in the task file is satisfied.
- [ ] **SYM-004 / SYM-006 / SYM-007 only:** the REQUIRED real-service test passes
      (`test/integration/`) — real Notion via MCP (004/007) or a real Claude Code turn (006).
      **A mock-only pass is NOT acceptable for these.**
- [ ] **Workspace-safety unit only:** the three safety invariants pass as explicit checks —
      (A) agent `cwd == workspace path`, (B) workspace path within the normalized root,
      (C) key sanitized to `[A-Za-z0-9._-]`.
- [ ] Paste the smoke output / test summary into the ticket's `## Workpad` Linear comment.

## Per-unit smoke (what "runnable" means for each)

| Ticket | `smoke:<unit>` proves |
|--------|----------------------|
| SYM-001 | `npm run build` — types + ports compile; skeleton + `verify` run. |
| SYM-002 | `smoke:config` — parses a real `WORKFLOW.md`, prints resolved config (secrets redacted). |
| SYM-003 | `smoke:observability` — a structured log line with `issue_id`/`issue_identifier`/`session_id` + a status line. |
| SYM-004 | `smoke:tracker` — lists candidates from the **real Notion Dev Board** (below), normalized to the §4 `Issue`. |
| SYM-005 | `smoke:workspace` — creates a per-issue dir; prints safety invariants A/B/C = pass. |
| SYM-006 | `smoke:agent` — renders a prompt + launches a **real** trivial Claude Code turn in a temp workspace. |
| SYM-007 | `smoke:e2e` — reads a real `Todo` from the Dev Board → confines a workspace → runs the agent → reconciles on the real terminal state. **MVP gate.** |

## Real Notion test substrate (for SYM-004 / SYM-007)

- **Board:** "Symphony Dev Board" — database `1c7826ea19e443b9addd794981606d56`,
  data-source `c29d9c6a-0db6-4dcb-bb52-66a0ac769468`.
- **Active** states `["Todo","In Progress"]`; **terminal** `["Done","Cancelled"]`.
- Seed rows: `DEV-1` (Todo — the e2e target: write `HELLO.md`, then set itself to Done) and
  `DEV-2` (Done — control that candidate-fetch must ignore).
- **Notion access:** use the connected `claude.ai Notion` MCP tools available in your session (no API
  key needed). Never log secrets.

## Status map (how you drive the Linear ticket)

- **Todo** → post a plan in a `## Workpad` comment, move to **In Progress**, implement.
- **In Progress** → satisfy the Definition of Done, commit, push, open a PR (link it), move to
  **In Review**, stop.
- **Merging** → PR approved: land it, then move to **Done**.
