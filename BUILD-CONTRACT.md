# BUILD-CONTRACT.md — how every ticket must be built & verified

You are an **implementation agent** building the **Symphony Orchestrator** (a Notion + Claude Code +
TypeScript implementation of the Symphony spec) into **this repo**, one Linear ticket at a time.
One ticket = one atomic unit = one PR. This contract is the shared bar for every ticket.

> Your unit's scope + acceptance criteria: `docs/tasks/SYM-###-*.md` **and** the Linear issue
> description. Where they disagree, `spec/SYMPHONY-SPEC.md` wins — the task files are derived from
> it, and a derived document does not get to contradict its source. Say so on the ticket when it
> happens; do not silently satisfy the weaker one.

## Ticket map (milestone M1 — project `symphony-orchestrator-notion-build-e555d457be74`)

| Task file | Linear | Unit |
|---|---|---|
| `SYM-001` | [ARK-58](https://linear.app/arkatechie/issue/ARK-58) | project init + §4 domain models |
| `SYM-002` | [ARK-59](https://linear.app/arkatechie/issue/ARK-59) | `WORKFLOW.md` loader + typed config |
| `SYM-003` | [ARK-60](https://linear.app/arkatechie/issue/ARK-60) | observability: logging + status |
| `SYM-004` | [ARK-61](https://linear.app/arkatechie/issue/ARK-61) | Notion tracker client (read-only) |
| `SYM-005` | [ARK-62](https://linear.app/arkatechie/issue/ARK-62) | workspace manager + safety |
| `SYM-006` | [ARK-63](https://linear.app/arkatechie/issue/ARK-63) | agent runner + prompt rendering |
| `SYM-007` | [ARK-64](https://linear.app/arkatechie/issue/ARK-64) | orchestrator + reconciliation + CLI |

## Project layout (greenfield, TypeScript at repo root)

```
package.json  tsconfig.json  tsconfig.build.json
src/domain/        # §4 domain types + the five port interfaces   [SYM-001]
src/config/        # WORKFLOW.md loader + typed config + $VAR + path normalization
src/observability/ # structured logger + terminal status
src/tracker/       # Notion MCP client + row -> Issue normalization
src/workspace/     # Workspace Manager + the 3 safety invariants
src/agent/         # Agent Runner (Claude Code) + strict prompt rendering
src/orchestrator/  # poll loop, eligibility, dispatch, reconciliation
src/index.ts       # CLI entrypoint `symphony ./WORKFLOW.md`
test/              # node:test unit specs;  test/integration/ = real-service specs
smoke/             # one runnable smoke per unit (see matrix below)
```

Do **not** modify `aidlc-docs/`, `spec/`, `docs/tasks/`, `build-driver/`, or `engine/` unless your
ticket explicitly says so — those are the plan and the build driver, not the product.

`src/domain/` is the innermost layer (§3.2). It contains **types and interfaces only**: every module
under it must compile to an empty JS file. Later units depend inward onto it and never the reverse.

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
  "verify": "npm run typecheck && npm run build && npm test"
}
```

If a script does not exist yet and your ticket owns it, add it. Keep existing ones working.

> **`typecheck` is not optional, and it is not a duplicate of `build`.** `build` compiles
> `src/**` only; `tsx` strips types at test time without checking them. So `test/**` and `smoke/**`
> are type-checked by **nothing** unless you run `typecheck`. That is exactly where port-conformance
> lives — a stub that no longer satisfies an interface fails there and nowhere else.

## Definition of Done — you may not move the ticket to review until ALL hold

- [ ] `npm run typecheck` is clean (covers `src/`, `test/`, `smoke/`).
- [ ] `npm run build` compiles clean.
- [ ] `npm test` is green, and adds **at least one real assertion** for this unit.
      An empty suite exits 0; that does not count as green.
- [ ] `npm run smoke:<unit>` prints evidence the unit does its **real** job (see matrix).
- [ ] Every acceptance-criteria checkbox in the task file is satisfied — or explicitly
      contested on the ticket with a spec citation, if it contradicts the spec.
- [ ] **SYM-004 / SYM-006 / SYM-007 only:** the REQUIRED real-service test passes
      (`test/integration/`) — real Notion via MCP (004/007) or a real Claude Code turn (006).
      **A mock-only pass is NOT acceptable for these.**
- [ ] **Workspace-safety unit only:** the three §9.5 invariants pass as explicit checks —
      (A) agent `cwd == workspace path`, (B) workspace path within the normalized root,
      (C) key sanitized to `[A-Za-z0-9._-]`.
- [ ] Paste the smoke output / test summary into the ticket's `## Workpad` Linear comment.

## Per-unit smoke (what "runnable" means for each)

| Ticket | `smoke:<unit>` proves |
|--------|----------------------|
| SYM-001 | `npm run verify` — types + ports compile; each `dist/domain/*.js` is `export {};`. |
| SYM-002 | `smoke:config` — parses the real root `WORKFLOW.md`, prints resolved config (secrets redacted). |
| SYM-003 | `smoke:observability` — a structured log line with `issue_id`/`issue_identifier`/`session_id` + a status line. |
| SYM-004 | `smoke:tracker` — lists candidates from the **real Notion Dev Board** (below), normalized to the §4 `Issue`. |
| SYM-005 | `smoke:workspace` — creates a per-issue dir; prints safety invariants A/B/C = pass. |
| SYM-006 | `smoke:agent` — renders a prompt + launches a **real** trivial Claude Code turn in a temp workspace. |
| SYM-007 | `smoke:e2e` — reads a real `Todo` from the Dev Board -> confines a workspace -> runs the agent -> reconciles on the real terminal state. **MVP gate.** |

## Real Notion test substrate (for SYM-004 / SYM-007)

- **Board:** "Symphony Dev Board" — database `1c7826ea19e443b9addd794981606d56`,
  data-source `c29d9c6a-0db6-4dcb-bb52-66a0ac769468`.
- **Active** states `["Todo","In Progress"]`; **terminal** `["Done","Cancelled"]`.
- Seed rows: `DEV-1` (Todo — the e2e target: write `HELLO.md`, then set itself to Done) and
  `DEV-2` (Done — control that candidate-fetch must ignore).
- **Notion access:** use the connected `claude.ai Notion` MCP tools available in your session (no API
  key needed). Never log secrets.

## Status map (how you drive the Linear ticket)

- **Todo** -> post a plan in a `## Workpad` comment, move to **In Progress**, implement.
- **In Progress** -> satisfy the Definition of Done, commit, push, open a PR (link it), post an
  `## Implementation Report` comment, move to **In Review**, stop.
- **Merging** -> PR approved: land it, then move to **Done**.

> **`In Review` is deliberately in neither `active_states` nor `terminal_states`.** Moving a ticket
> there makes it invisible to the driver, which is how the human review gate is implemented — with a
> state, not a feature. A driver sitting at `running: 0` with everything in review has not hung.
> Corollary: a ticket published in **`Backlog`** is invisible for the same reason. The backlog must
> be moved to **`Todo`** before a driver will pick anything up.
