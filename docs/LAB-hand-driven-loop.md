# Lab — The Hand-Driven Loop

**Goal:** go from a finished AI-DLC plan to a *working, Linear-integrated implementation loop* that
you drive **by hand** — no orchestrator. The point is not to avoid automation. The point is to
perform every step the orchestrator performs, so that when you switch it on you recognise the loop
and trust it.

**The line to say out loud:** *an orchestrator is a `while` loop around work a human can already do.
If you can't do one ticket by hand, automating it just makes the failure faster.*

- ⏱ ~60–90 min for one ticket, start to merged PR.
- **Prerequisite:** Phase 1 complete — a published Linear backlog. (Already true in this kit: run 2,
  tickets ARK-49…57, all merged.)
- **Out of scope, deliberately:** `symphony-claude`, the OpenSymphony engine, polling, concurrency.
  You are the daemon.

---

## The loop you are about to perform by hand

This is what `src/orchestrator/orchestrator.ts` actually does, per tick. Each row is a station below.

| # | Orchestrator does | You do by hand | Proves |
|---|---|---|---|
| 1 | Load `WORKFLOW.md` → typed config | Read the config, resolve `$VAR`s yourself | Config is the contract, not magic |
| 2 | Sweep terminal workspaces (§8.6) | `rm -rf` stale dirs | Restart safety |
| 3 | Poll tracker, filter `active_states` | Query Linear for `Todo` | **Tracker is the queue** |
| 4 | Eligibility: blockers terminal? slot free? | Check `blockedBy` yourself | Dependency order is real |
| 5 | Sort priority → created_at | Pick the ticket | Scheduling is a policy, not logic |
| 6 | Prepare workspace + safety invariants | `mkdir`, `git clone` | Isolation is enforced, not hoped |
| 7 | Render prompt (strict Liquid) | Render it, read it | **The prompt is the whole interface** |
| 8 | Launch agent in workspace `cwd` | Run `claude` yourself | The agent is replaceable |
| 9 | Reconcile on terminal state | Re-query Linear, stop | **Agent writes state, not the daemon** |

Rows **3, 7 and 9** are where the insight lives. Linger there.

---

## Station 0 — Pick a real ticket

Do not invent a toy. Five deferred units from PRD §5.3 are genuinely unimplemented today
(config is parsed, the logic is absent):

| Candidate | Where the gap is | Size |
|---|---|---|
| **`after_create` / `before_remove` hooks** ⭐ | `src/workspace/manager.ts:68` says "intentionally NOT run — deferred" | small |
| Stall detection | `stall_timeout_ms` parsed in `config.ts:147`, consumed nowhere | small |
| Multi-turn continuation to `max_turns` | `src/agent/runner.ts:21` deferred note | medium |
| `WORKFLOW.md` watch/reload | no implementation at all | medium |
| Token / runtime accounting | no implementation at all | medium |

**Use `after_create` hooks.** It is one file plus tests, needs no new dependencies, and it is
*literally the workspace-prep step the orchestrator automates* — so the ticket and the lab are about
the same thing.

---

## Station 1 — Write the ticket the way the plan writes tickets

The orchestrator hands an agent **only** the rendered prompt. So the ticket must be self-sufficient.
Create the task file first, then publish it — same path the bridge uses.

Create `docs/tasks/SYM-008-workspace-hooks.md` with the sections every other task file has:
`## Summary`, `## How to run this ticket`, `## Scope` (in/out), `## Deliverables`,
`## Acceptance Criteria` (checkboxes, measurable), `## Definition of Done` (points at
`BUILD-CONTRACT.md`), `## Context` (cite spec §9.4).

Copy the shape from `docs/tasks/SYM-005-workspace-manager-and-safety.md` — it is the closest sibling.

Then create the Linear issue in the same project:

```bash
set -a; . ./.env; set +a
# project: symphony-d27271e017ad   (from docs/tasks/linear-publish.yaml)
```

Use `/linear` to create it, mirroring the task file's acceptance criteria into the description, and
set it to **Todo**.

> ✅ **Gate:** the Linear issue, read cold with no other context, tells you exactly what to build and
> how you'll know it's done. If it doesn't, fix it now — every later failure traces back here.

---

## Station 2 — Be the poller (orchestrator step 3)

The daemon's entire tracker job is: *list issues whose state is in `active_states`.* Do it by hand.

```bash
set -a; . ./.env; set +a
python3 .agents/skills/linear/scripts/linear_graphql.py \
  --query-file .agents/skills/linear/queries/viewer.graphql
```

Then query the project's `Todo` issues via `/linear`.

**Say the point out loud:** the tracker is not a reporting tool bolted on the side. It *is* the work
queue. `active_states` is the only thing that makes a ticket exist to the system. A ticket in
`In Review` is invisible — which is exactly how the human review gate is implemented: not with a
feature, but with a state that is in neither `active_states` nor `terminal_states`.

---

## Station 3 — Be the scheduler (steps 4–5)

Check eligibility yourself:

1. Is every `blockedBy` issue in a **terminal** state? If not, the ticket is not runnable — stop.
2. Is it already running? (You'd know. The daemon keeps this in memory, and *only* in memory — §5.4,
   no persistence. Restart the daemon and it rebuilds this from the tracker + filesystem.)
3. Sort by priority, then created_at.

**Say the point:** there is no scheduler database. State lives in the tracker and the filesystem.
That is a deliberate design choice, and it is why the daemon can be killed mid-run and restarted.

---

## Station 4 — Be the workspace manager (step 6)

```bash
ISSUE=ARK-58        # your new issue identifier
ROOT=~/symphony-lab-workspaces
mkdir -p "$ROOT"
git clone --depth 1 --branch main \
  https://github.com/cdcordobaa/symphony-workshop-kit.git "$ROOT/$ISSUE"
cd "$ROOT/$ISSUE"
```

Now verify the three safety invariants the real manager enforces (`src/workspace/safety.ts`):

- **A** — the agent's `cwd` equals the workspace path (you are standing in it).
- **B** — the workspace path resolves *inside* the normalized root (no `..` escape).
- **C** — the issue key is sanitized to `[A-Za-z0-9._-]`.

**Say the point:** isolation is enforced, not trusted. The agent cannot wander into the kit repo or
your home directory because the path was checked before it launched, not after.

---

## Station 5 — Be the prompt renderer (step 7) ⭐

This is the station people underestimate. The agent's **entire** interface to the system is the
rendered prompt. Everything the orchestrator knows must arrive through that string or not at all.

Read the template — the Markdown body after the front matter in `build-driver/WORKFLOW.md` — and
render it in your head against your issue: `{{ issue.identifier }}`, `{{ issue.title }}`,
`{{ issue.state }}`, `{{ issue.url }}`, `{{ issue.description }}`, `blocked_by`, `attempt`.

Rendering is **strict** (`src/prompt/renderer.ts`): an undefined variable is an error, not an empty
string. A prompt that silently loses the ticket body is worse than one that fails loudly.

> ✅ **Gate — the cold-agent test:** the prompt plus the repo must be *sufficient*. If the agent will
> need to ask you a question, the **ticket** is underspecified, not the agent. Go back to Station 1.

---

## Station 6 — Be the agent runner (step 8)

From inside the workspace, launch a fresh agent and paste the rendered prompt as its first message:

```bash
cd "$ROOT/$ISSUE"
claude
```

Then **do not help it.** That is the experiment. The agent should:

1. Read `BUILD-CONTRACT.md` at the repo root and follow it (harness = `node:test`).
2. Post a `## Workpad` comment on the Linear issue with its plan, move the issue to **In Progress**.
3. Implement, satisfy the Definition of Done: `npm run build` clean, `npm test` green,
   the unit's `smoke:*` printing real evidence.
4. Commit, push a branch, open a PR, link it, move the issue to **In Review**, and stop.

Every question it asks you is a **defect in the plan**. Write each one down — that list is the most
valuable output of this whole lab.

**Say the point:** the agent is the replaceable part. Claude Code here, Codex in the spec, anything
behind the Agent Runner port. The contract is the prompt in, a PR and a state transition out.

---

## Station 7 — Be the reconciler (step 9)

Re-query Linear. The issue is now **In Review** — which is in neither `active_states` nor
`terminal_states`.

**This is the single most important thing in the lab.** A real orchestrator goes `running: 0` here
and looks idle. It has not hung. It is waiting for a human, exactly as designed.

Now do the human half:

1. Review the PR — build, tests, the smoke output.
2. Merge it to `main`.
3. Move the issue to **Done** (terminal).
4. Re-query. The ticket has left the queue. Any dependent's `blockedBy` is now satisfied — it just
   became eligible, and on a real run the next agent would claim it on the following poll.

**Say the point, and this is the punchline:** the daemon never wrote a single field. The **agent**
moved the ticket, via its own tools (spec §11.5 — the orchestrator is a reader/scheduler, not a
ticket-writer). The daemon only *observed* that the state had reached terminal and stopped the run.
That asymmetry is the whole architecture. You just performed both halves of it by hand.

---

## Station 8 — Name what you automated

Close the lab by walking the table at the top and marking which rows were tedious:

| Row | Tedious by hand? | So the orchestrator… |
|---|---|---|
| 3 Poll | yes, constantly | polls every `interval_ms` |
| 4 Eligibility | yes, error-prone | evaluates `blockedBy` mechanically |
| 6 Workspace | moderately | creates + enforces invariants every time |
| 7 Prompt | yes, and easy to get wrong | renders strictly, fails loud |
| 8 Launch | no — one command | runs N of them concurrently, capped |
| 9 Reconcile | **yes** — you must keep looking | re-polls and stops the run |

Nothing in that right-hand column is a new capability. It is the same loop, run continuously and
without fatigue. **That is the honest description of what the orchestrator adds** — and the reason
you can now turn it on with an accurate mental model instead of hope.

> ▶️ **Next:** `RUNBOOK.md` Phase 2A. The `build-driver/WORKFLOW.md` you'll hand the driver encodes
> exactly the config you applied by hand in Stations 2–7.
