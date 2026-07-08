# Symphony Workshop — Runbook

Build a Symphony-spec orchestrator **from scratch**, planning with **AI-DLC** and executing with a
**Symphony driver** — `symphony-claude` (TypeScript, the current default) or the **OpenSymphony**
engine (Rust). Follow these steps top to bottom. Two phases: **Planning** then **Implementing**.

- ⏱ Rough timing: Setup ~20 min · Phase 1 ~60–90 min · Phase 2 runs unattended (watch & review).
- 🎯 Goal of Phase 1: a Linear project full of well-scoped, dependency-linked tickets derived from
  the spec. Goal of Phase 2: OpenSymphony drives agents that turn those tickets into merged PRs.

> **Remember the boundary:** you are building *your own* Symphony implementation. OpenSymphony is the
> engine that drives the build. The decomposition/plan is **the workshop exercise** — you generate
> it live from `spec/SYMPHONY-SPEC.md`; nothing is pre-baked.

---

## 0. Setup (once)

### 0.1 Accounts, keys, tools
Work through `facilitator/preflight-checklist.md`. You need: a Linear workspace + API key, the
`claude` CLI authenticated, `python3` + `uv`, `git`, `gh` authenticated, and a **Symphony driver**:
either `symphony-claude` (Node 22+, built locally at `../symphony-claude` — see Phase 2A) or a local
OpenSymphony engine checkout (Rust, `engine/engine-setup.md` — Phase 2B).

### 0.2 Environment
```bash
cp .env.example .env
# edit .env: set LINEAR_API_KEY and ANTHROPIC_API_KEY
set -a; . ./.env; set +a
```

### 0.3 Verify Linear auth
```bash
python3 .agents/skills/linear/scripts/linear_graphql.py \
  --query-file .agents/skills/linear/queries/viewer.graphql
```
You should see your Linear viewer JSON. If not, fix `LINEAR_API_KEY` before continuing.

### 0.4 Create the Linear project
In Linear, create an **empty project** for this build (e.g. "Symphony From Scratch"). Copy its
**slugId** from the URL — `linear.app/<team>/project/<name>-<SLUG>`. Save it as
`SYMPHONY_LINEAR_PROJECT_SLUG` in `.env`.

### 0.5 Create the target repo (what agents will build into)
```bash
# From the kit root:
cp -R target-repo-template /tmp/symphony && cd /tmp/symphony
git init && git add -A && git commit -m "chore: seed Symphony workshop repo"
gh repo create <you>/symphony --private --source=. --push
```
Save the clone URL as `SYMPHONY_TARGET_REPO_URL` in `.env`. Return to the kit:
`cd -` (or `cd` back to the kit folder).

---

## Phase 1 — Planning (in this kit, with Claude Code)

Open the **kit folder** in Claude Code. `CLAUDE.md` puts Claude in the planning persona and arms the
AI-DLC workflow + skills.

### 1.0 (Optional) Seed the run with a PRD
The default workshop derives every decision **live** from the spec — that is the core exercise. If
instead you want to **lock the variant up front** (tracker, agent, language, conformance/scope) so a
from-scratch run is fast and repeatable, write a short **PRD** at `spec/PRD.md` and point Claude at
it. A PRD turns Requirements Analysis from "decide cold" into "confirm / refine".

- A PRD states: problem, goals/non-goals, **locked variant decisions** (D1..Dn), in/out scope,
  conformance target, and the config contract — but **not** the unit decomposition, which stays the
  live exercise (§1.2 Units Generation).
- This kit ships a worked example at `spec/PRD.md` (Notion + Claude Code + TypeScript variant). Edit
  it, replace it, or delete it to suit your run.
- **No PRD?** Skip this step — INCEPTION will ask every locked decision as a multiple-choice question
  during Requirements Analysis instead.

> The PRD seeds the **product** requirements only. The build pipeline is unchanged: spec (+ PRD) →
> INCEPTION → task package → **Linear** → OpenSymphony engine. (Linear orchestrates the *build*; the
> product's own runtime tracker is whatever the PRD specifies.)

### 1.1 Read the spec
Ask Claude to read `spec/reading-guide.md` and then the deep-read sections of
`spec/SYMPHONY-SPEC.md` (§3 System Overview, §4 Domain Model, §7 State Machine, §8 Polling/Retry,
§9 Workspace, §10 Agent Runner, §11 Tracker). This grounds the decomposition in the real spec. If
you seeded a PRD (§1.0), have Claude read `spec/PRD.md` too — it is the locked-decision overlay on
the spec.

### 1.2 Run AI-DLC INCEPTION
Tell Claude:
> "Run the AI-DLC workflow to plan a from-scratch Symphony implementation. Source of truth is
> `spec/SYMPHONY-SPEC.md` (and `spec/PRD.md` if you seeded one in §1.0). Greenfield project."

AI-DLC will (per `.aidlc-rule-details/`):
1. **Workspace Detection** → greenfield.
2. **Requirements Analysis** → choose the tech stack and test framework (you decide, e.g.
   TypeScript+Jest, Rust+cargo, Python+pytest). Writes `aidlc-docs/inception/requirements/requirements.md`.
   *If you seeded a PRD (§1.0), these come pre-locked — Requirements Analysis confirms/refines the
   PRD's decisions instead of asking them cold, and still runs the mandatory extension opt-ins.*
3. **Workflow Planning** → which stages to run.
4. **Units Generation** → the working units in
   `aidlc-docs/inception/application-design/unit-of-work.md`, `unit-of-work-dependency.md`,
   `unit-of-work-story-map.md`.

Answer its multiple-choice questions; approve each stage at its checkpoint. **This is the core
exercise — the working units are the building plan, produced here, not shipped.**

> ✅ Checkpoint: you have `unit-of-work.md`, `unit-of-work-dependency.md`, `unit-of-work-story-map.md`,
> and `requirements.md`. Each unit names the spec section it implements and its dependencies.

### 1.3 Bridge: working units → task package
Run the bridge skill:
> `/aidlc-to-tasks`

It reads the AI-DLC artifacts and produces `docs/tasks/task-package.yaml` + one task file per unit
(`docs/tasks/SYM-NNN-*.md`) + `docs/tasks/milestones.md`, mapping phases→milestones, the dependency
matrix→`blockedBy`/`blocks`, and the story map→acceptance criteria. It then **validates**:

```bash
uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py \
  validate --manifest docs/tasks/task-package.yaml
```
The skill loops generate→validate→fix until this exits 0.

> ✅ Checkpoint: `validate` passes. Review `docs/tasks/milestones.md` and a couple of task files —
> are acceptance criteria measurable and scoped to one unit?

### 1.4 Preview the Linear projection
```bash
uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py \
  dry-run --manifest docs/tasks/task-package.yaml
```
Confirm the milestones, issues, sub-issues, and blocker relations look right.

### 1.5 Publish to Linear
> `/convert-tasks-to-linear` — or directly:
```bash
uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py \
  apply --manifest docs/tasks/task-package.yaml \
  --project-slug "$SYMPHONY_LINEAR_PROJECT_SLUG"
# add --team-key <KEY> if the project spans multiple teams
```
This writes `docs/tasks/linear-publish.yaml` (the id→issue mapping).

> ✅ Checkpoint: open the Linear project. Milestones exist, issues are assigned to them, blocker
> relations are set, and the issues are in `Todo` (or your backlog→todo state). Phase 1 done.

---

## Phase 1.5 — Define the build & test approach (CONSTRUCTION planning)

Before handing the backlog to the engine, decide **how each ticket proves it produced a working
increment**. This is a short planning pass (still in the kit, with Claude) that closes the gap between
"a ticket is coded" and "we know the product still works." Output:
`aidlc-docs/construction/build-and-test/build-and-test-plan.md`.

Decide and record four things:

1. **Build orchestrator.** Who drives ticket-by-ticket construction. For a demo, the simplest and most
   reliable choice is **engine + Linear only**: the OpenSymphony engine claims Linear tickets and a
   Claude Code agent implements each one (Phase 2 below). *(A later, optional "dogfood" step can point
   the finished product at its own tracker to build its next iteration — keep it deferred until the MVP
   gate is green.)*
2. **Per-ticket Definition of Done ("working at each step").** Pin one shared script contract in the
   first ticket (e.g. `npm run build`, `npm test`, `npm run smoke:<unit>`, `npm run verify`). Every
   ticket must go **build green → unit tests green → a runnable smoke that shows the unit doing its real
   job** before it moves to review. "Done" then means a *verified, runnable* increment — and because the
   engine only unblocks dependents when a blocker is done, quality gates the whole wave graph.
3. **Test substrate.** Mock external services in **unit** tests for speed and determinism — but do
   **not** let the product's *defining* integration be mock-only, or "it works" is unproven. If the
   product's whole value is a connection (here: reading/driving a **Notion** board via MCP), make a
   **real** integration/e2e test a *required* part of the Definition of Done for the ticket(s) that own
   that connection, and reach the MVP gate against a **real** board — not a fixture. Keep a fast
   in-memory fixture too if you want quick CI, but the gate is the real run. (Only truly separable,
   later-iteration work — e.g. having the finished product build *itself* — should be deferred.)

   > Note the two independent axes: *who orchestrates the build* (here: OpenSymphony + Linear only) is
   > separate from *what the tests run against* (here: a real Notion board). Simplifying the first does
   > not require mocking the second.
4. **Agent-facing build contract.** The engine's agents read the **target repo**, not `aidlc-docs/`.
   So put the script contract + per-ticket DoD in a **`BUILD-CONTRACT.md` at the target repo root**
   (created by the first ticket) and reference it from the target repo's `CLAUDE.md` / `WORKFLOW.md`
   prompt, and mirror the DoD into each Linear issue so "done" means the same on the board and in code.

> ✅ Checkpoint: `build-and-test-plan.md` exists with those four decisions; the first ticket
> (SYM-001) carries the harness + `BUILD-CONTRACT.md`; every ticket's acceptance list includes the
> build/test/smoke DoD. Tag a reference point (Appendix E) before starting the engine.

---

## Phase 2 — Implementing (Symphony driver)

Hand the Linear backlog to a **driver** that polls Linear and launches a Claude Code agent per ticket.
The driver is pluggable — both consume the same Linear project and the same per-ticket Definition of
Done (Phase 1.5). Pick one:

- **2A. symphony-claude ("Symphony Cloud")** — a TypeScript reimplementation of Symphony at
  `../symphony-claude` (`npx symphony`). **Use this when the Rust OpenSymphony engine isn't available.**
  ← current default for this run.
- **2B. OpenSymphony engine (Rust)** — the original bundled in `engine/`. See §2B.

### 2A — Drive with symphony-claude

**2A.1 Build the driver once**
```bash
cd ../symphony-claude && npm install && npm run build && cd -
```

**2A.2 Use the driver `WORKFLOW.md`.** This kit ships a ready-made one at **`build-driver/WORKFLOW.md`**
(Linear project `d27271e017ad`, active/terminal states, target-repo clone hook, and a per-ticket prompt
that wires `BUILD-CONTRACT.md` + the Definition of Done). It is **distinct** from the product's own
`WORKFLOW.md` (which the product loads to poll Notion). Edit the `hooks.after_create` clone URL to your
target repo; adjust the slug/states only if yours differ.

**2A.3 Notion access for the agents.** The SYM-004/006/007 tickets' tests hit a real Notion board. By
**default** the agents inherit your connected `claude.ai Notion` MCP connector (`claude mcp list` shows
it) — symphony-claude injects `linear_graphql` and does **not** pass `--strict-mcp-config`, so
user-scope servers still load. **No key needed.** For unattended runs or a fresh machine, use the
*fallback*: copy `build-driver/notion.mcp.json` to the target-repo root as `.mcp.json` and export a
`NOTION_API_KEY`.
```bash
set -a; . ./.env; set +a          # LINEAR_API_KEY always; NOTION_API_KEY only for the fallback; `claude` authenticated
```

**2A.4 Run**
```bash
cd ../symphony-claude && npm install && npm run build && cd -   # once
node ../symphony-claude/dist/index.js "$PWD/build-driver/WORKFLOW.md" --port 3000
```

**2A.5 Watch**
- **TUI**: full-screen dashboard on the TTY (running agents, turns, tokens, retry queue).
- **Web**: `http://localhost:3000/` (`GET /api/v1/state`, per-issue detail, `POST /api/v1/refresh`).
- **Linear**: each agent keeps a `## Workpad` comment with its live plan.
The driver claims active-state issues (up to `max_concurrent_agents`), clones the target repo into
`workspace.root/<ISSUE>/`, runs a multi-turn Claude session there, opens a PR, and moves the issue
toward a terminal state. Blocked issues wait for their blockers.

**2A.6 Review & merge** — review PRs as they arrive; advance approved issues per your Status Map. As
blockers merge, dependents unblock and get claimed.

**2A.7 The per-unit review gate (how the chain actually advances).** This is the cadence you operate,
verified on a real run:

1. The driver claims a `Todo` ticket, an agent implements it, pushes a branch, opens a PR, and moves
   the ticket to **In Review**, then **stops**. The driver goes **idle** (`running: 0`) — this is
   expected, not a hang.
2. `In Review` is **not a terminal state**, and the driver only unblocks a dependent when *all* its
   blockers are terminal. So the chain **pauses** here until you act.
3. Review the PR (build + tests + the unit's `smoke:*` per `BUILD-CONTRACT.md`), **merge it to `main`**,
   then set the ticket to a **terminal** state (**Done**).
4. On its next poll the driver detects the dependent is unblocked, clones the **updated `main`**, and
   starts the next unit. Repeat until the last unit (the MVP gate) is green.

> Each agent clones `main` fresh per workspace, so a unit's dependency must be **merged to `main`**
> (not just "In Review") before the dependent can build on it. Merge promptly to keep the chain moving.

**2A.8 Gotchas (learned on a real run).**
- **Stale tracker states.** Tickets left `In Review`/`In Progress` by an earlier, aborted run — with
  no branch or PR — will not be re-claimed (those states aren't active). Reset them to `Todo` so the
  driver rebuilds them. Don't trust the status column alone; confirm a real PR exists.
- **Published blockers can be stricter than your plan chart.** The `blockedBy` relations actually in
  the tracker drive dispatch order (a unit may block on more than the plan diagram showed), so the
  driver may serialize where you expected parallelism. That's correct behavior — check the relations,
  not the diagram.
- **Building in-place (target repo = this repo).** If agents build the product into the same repo that
  holds the planning kit, its `CLAUDE.md` planning persona will otherwise tell them "construction is
  not done here" — add an **implementation-agent clause** to `CLAUDE.md` and a root `BUILD-CONTRACT.md`
  so agents know their job. Pin the test harness (here: `node:test`) so every unit matches.
- **First ticket may over-deliver.** An early agent can bundle several units into one PR; later tickets
  then mostly add their missing `smoke:*` + reconcile to the DoD rather than rebuild. That's fine —
  merge it and let the remaining tickets fill gaps.

### 2B — Drive with the OpenSymphony engine (Rust, alternative)

Full detail in `engine/engine-setup.md`; the short path:

1. **Wire the engine** — edit `engine/WORKFLOW.md`: `tracker.project_slug` →
   `$SYMPHONY_LINEAR_PROJECT_SLUG`; `hooks.after_create` clone URL → `$SYMPHONY_TARGET_REPO_URL`.
   Leave the `claude:` block as-is (selects the experimental Claude harness).
2. **Export env** — `set -a; . ./.env; set +a` (LINEAR_API_KEY + ANTHROPIC_API_KEY).
3. **Preflight + run** — `opensymphony doctor --config "$PWD/engine/config.yaml"`, then
   `cd engine && opensymphony run --config "$PWD/config.yaml"` (reads `WORKFLOW.md` from cwd).
4. **Watch** — control plane `http://127.0.0.1:2468/`; `opensymphony tui --url http://127.0.0.1:2468`.
5. **Review & merge** — move approved issues to `Merging` (agent follows the `land` skill).

> ✅ Done when the backlog has been implemented as merged PRs and your target repo is a working
> Symphony implementation.

---

## Appendix A — Field-mapping cheat-sheet (AI-DLC → task package)

| AI-DLC source | task-package field |
|---|---|
| working unit | one task `.md` + manifest entry, `id: SYM-NNN` |
| phase heading | `milestone:` + entry in `milestones:` |
| dependency matrix | `blockedBy` / `blocks` (acyclic) |
| story map (FR→unit) + BDD | `## Acceptance Criteria` checkboxes |
| unit responsibilities | `## Summary` / `## Scope` / `## Deliverables` |
| requirements stack + NFRs | `## Test Plan`, `## Context` (cite spec §) |

Full rules: `.agents/skills/aidlc-to-tasks/SKILL.md`.

## Appendix B — Troubleshooting

| Symptom | Fix |
|---|---|
| `viewer.graphql` returns auth error | `LINEAR_API_KEY` not set/exported in the current shell. |
| `validate` fails on cycles | Break the cyclic `blockedBy` edge the converter names; re-validate. |
| `apply` says milestone mismatch | A task's `milestone:` doesn't exactly match a `milestones:` entry. |
| Driver never claims an issue | Issue state not in `active_states`, or wrong `project_slug`. |
| `after_create` clone fails | Bad clone URL / `SYMPHONY_TARGET_REPO_URL` or `gh auth`/SSH not set up. |
| Agent can't write Linear | `LINEAR_API_KEY` missing in the **driver** shell. |
| Agent can't reach Notion (product tests fail) | Target-repo `.mcp.json` missing the Notion server, or `NOTION_API_KEY` not exported in the driver shell (Phase 2A.3). |
| Run stuck/failing (OpenSymphony) | `/debug <ISSUE-ID>`; inspect `~/.opensymphony/workspaces/<ISSUE>/.opensymphony/claude/stdout.ndjson`. |
| Run stuck/failing (symphony-claude) | Check the TUI/`symphony.log`, the web dashboard at `:3000`, and the workspace under `workspace.root/<ISSUE>/`. |
| Driver went idle (`running: 0`) after a PR opened | Expected — the ticket is `In Review` (not terminal). Merge the PR to `main` and set the ticket **Done**; the next unit unblocks on the following poll (§2A.7). |
| Dependent never starts though its blocker "looks done" | The blocker is `In Review`, not a terminal state. Merge its PR and move it to **Done** — dispatch requires blockers to be terminal. |
| Ticket marked In Review but has no branch/PR | Stale state from an earlier run. Reset it to `Todo` so the driver rebuilds it (§2A.8). |

## Appendix C — Experimental harness caveats

The Claude harness is **local-only, single-user**: `--dangerously-skip-permissions` (no approval
prompts), `LINEAR_API_KEY` written in plaintext into each workspace's `mcp.json`, no event replay,
best-effort SIGTERM cancellation. Run only on a trusted machine against a repo you control. Keep
`max_concurrent_agents` low.

## Appendix D — Reset / re-run

### D.1 Restart from scratch (clean slate, PRD-seeded)
Begin a brand-new run while preserving the previous one. This is the path that pairs with a PRD seed
(§1.0); it is exactly how a fresh from-the-PRD run is bootstrapped.

1. **Archive the previous run** to its own branch so nothing is lost (source, plans, any build):
   ```bash
   git switch -c archive/inception-run-N        # snapshot the finished run
   git add -A && git commit -m "chore(archive): snapshot AI-DLC run N"
   ```
2. **Branch a fresh slate off main.** Switching restores tracked files to main and drops the run-N
   artifacts out of the working tree:
   ```bash
   git switch main
   git switch -c inception-run-<N+1>
   rm -rf docs build                            # remove generated leftovers (safe: kept on archive)
   ```
3. **Reset the AI-DLC state to blank.** `aidlc-docs/aidlc-state.md` and `aidlc-docs/audit.md` go back
   to their shipped empty templates (keep the headers); the `aidlc-docs/inception/*` subfolders
   should contain only `.gitkeep`. (Switching off the archive branch usually does this for you.)
4. **Author or carry over the PRD** at `spec/PRD.md` (see §1.0), then commit the baseline:
   ```bash
   git add -A && git commit -m "chore(inception): baseline for run <N+1> — add PRD seed"
   ```
5. **Run Phase 1** from §1.1. Workspace Detection sees a clean greenfield tree and INCEPTION consumes
   `spec/PRD.md` as the seed.

> Verify-ready checklist before starting: on `inception-run-<N+1>`; `aidlc-state.md` shows no stage
> progress; `inception/*` is only `.gitkeep`; `docs/` and `build/` absent; `spec/PRD.md` present;
> `.aidlc-rule-details/` present.

### D.2 Lighter re-plan (same branch)
- Clear `aidlc-docs/` back to the shipped blank state and `docs/tasks/`, then redo Phase 1.
  (Keep `aidlc-state.md` / `audit.md` headers.) Use this when you don't need a separate branch.

### D.3 Re-publish / re-implement
- **Re-publish:** `convert-tasks-to-linear` is idempotent via `linear-publish.yaml` — re-running
  `apply` updates rather than duplicates.
- **Re-implement a ticket:** move the Linear issue back to `Todo`; the engine re-claims it. Delete
  its workspace under `~/.opensymphony/workspaces/<ISSUE>/` for a clean clone.

## Appendix E — Reference points (branches & tags)

Keep return points so you can compare runs, restart cleanly, or demo from a known state.

### E.1 Branch strategy (one branch per lifecycle phase, per run)
- `archive/inception-run-<N>` — a **frozen** snapshot of a completed run (source + plans + any build).
  Push it (`git push -u origin archive/inception-run-<N>`) so it survives locally-lost work.
- `inception-run-<N>` — the finalized INCEPTION artifacts for run N (requirements, unit-of-work,
  task package). Frozen once CONSTRUCTION planning starts.
- `construction-run-<N>` — branched from `inception-run-<N>`; where the build & test definition
  (Phase 1.5) and any construction-side docs live while the engine implements tickets.

### E.2 Tag a reference point before consequential steps
Annotated tags mark states you may want to `git checkout` back to:

```bash
git tag -a run-<N>-construction-baseline -m "Run N: MVP backlog published + build/test plan defined"
git push origin run-<N>-construction-baseline        # optional: share it
```

Suggested reference tags per run:

| Tag | Marks |
|---|---|
| `run-<N>-inception-complete` | INCEPTION artifacts finalized (backlog not yet published). |
| `run-<N>-construction-baseline` | Backlog live in Linear **+** build-and-test plan defined — the point just before the engine starts. |
| `run-<N>-mvp-gate` | The MVP walking skeleton is green (last ticket done). |

Return to one with `git checkout <tag>` (detached HEAD — branch from it if you want to continue:
`git switch -c <new-branch> <tag>`). List them with `git tag -l 'run-*'`.

### E.3 Per-milestone tags during implementation (optional)
As waves land, tag the merge points (e.g. `run-<N>-wave-2-done`) so a long build has coarse
checkpoints independent of Linear/engine state.
