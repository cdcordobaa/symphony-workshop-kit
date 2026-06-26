# Symphony Workshop — Runbook

Build a Symphony-spec orchestrator **from scratch**, planning with **AI-DLC** and executing with the
**OpenSymphony** engine. Follow these steps top to bottom. Two phases: **Planning** then
**Implementing**.

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
`claude` CLI authenticated, `python3` + `uv`, `git`, `gh` authenticated, and a local OpenSymphony
engine checkout (Rust). See `engine/engine-setup.md`.

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

## Phase 2 — Implementing (OpenSymphony engine)

Now hand the backlog to the engine. Full detail in `engine/engine-setup.md`; the short path:

### 2.1 Wire the engine
Edit `engine/WORKFLOW.md`:
- `tracker.project_slug` → `$SYMPHONY_LINEAR_PROJECT_SLUG`.
- `hooks.after_create` clone URL → `$SYMPHONY_TARGET_REPO_URL`.

Leave the `claude:` block as-is (its presence selects the experimental Claude harness).

### 2.2 Export env in the engine shell
```bash
set -a; . ./.env; set +a    # LINEAR_API_KEY + ANTHROPIC_API_KEY must be present
```

### 2.3 Preflight + run
```bash
opensymphony doctor --config "$PWD/engine/config.yaml"
cd engine && opensymphony run --config "$PWD/config.yaml"
```
(`run` reads `WORKFLOW.md` from the working directory — run it from `engine/`.)

### 2.4 Watch
- Control plane: `http://127.0.0.1:2468/`
- TUI: `opensymphony tui --url http://127.0.0.1:2468`
- The engine claims `Todo` issues (up to `max_concurrent_agents`), clones your repo into
  `~/.opensymphony/workspaces/<ISSUE>/`, and runs a Claude agent there. Each agent moves the issue
  to `In Progress`, keeps a `## Agent Harness Workpad` comment, opens a PR, attaches it, and moves
  the issue to `Human Review`. Blocked issues wait for their blockers.

### 2.5 Review & merge
Review PRs as they arrive. Move approved issues to `Merging` (the agent then follows the `land`
skill). As blockers merge, dependents unblock and get picked up.

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
| Engine never claims an issue | Issue state not in `active_states`, or wrong `project_slug`. |
| `after_create` clone fails | Bad `SYMPHONY_TARGET_REPO_URL` or `gh auth`/SSH not set up. |
| Agent can't write Linear | `LINEAR_API_KEY` missing in the **engine** shell. |
| Run stuck/failing | `/debug <ISSUE-ID>`; inspect `~/.opensymphony/workspaces/<ISSUE>/.opensymphony/claude/stdout.ndjson`. |

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
