# Facilitator Guide

How to run the Symphony workshop. The participant path is `RUNBOOK.md`; this guide adds timing,
talking points, checkpoints to enforce, and recovery moves.

## The one-sentence framing (open with this)

> "We're going to use a working AI orchestrator — **OpenSymphony** — to build *our own* orchestrator
> that satisfies the same **Symphony spec**: we **plan** with AI-DLC, publish to **Linear**, and let
> OpenSymphony **drive the agents** that write the code. The plan isn't given to you — producing it
> is the workshop."

Draw the two-phase diagram from `README.md` on the board and keep returning to it.

## Suggested schedule (half-day)

| Time | Segment | Notes |
|---|---|---|
| 0:00–0:15 | Intro + framing + the diagram | Stress: target ≠ OpenSymphony. OpenSymphony is the engine. |
| 0:15–0:35 | Setup (RUNBOOK §0) | Most failures are env/auth. Preflight should have caught them. |
| 0:35–0:50 | Spec reading (RUNBOOK §1.1) | Walk §3/§4/§7 together; let them skim the rest. |
| 0:50–1:35 | AI-DLC INCEPTION (§1.2) | The heart of it. Circulate; help with stage checkpoints. |
| 1:35–1:55 | Bridge + publish (§1.3–1.5) | The "aha": working units become real Linear tickets. |
| 1:55–2:10 | Break / buffer | AI-DLC often overruns; borrow from here. |
| 2:10–2:30 | Engine wiring + launch (§2) | Launch once; watch the first ticket get claimed. |
| 2:30–3:00 | Watch agents + review PRs | Discuss blocker ordering, retries, the workpad comment. |

## Checkpoints to enforce (don't let people skip these)

1. **Viewer call returns JSON** before anyone starts AI-DLC (RUNBOOK §0.3). No key, no workshop.
2. **AI-DLC produced all three unit artifacts** + requirements before `/aidlc-to-tasks` (§1.2).
   If someone's AI-DLC "summarized" instead of writing files, send them back — the bridge needs
   real files.
3. **`validate` exits 0** before `apply` (§1.3). Never publish an invalid package.
4. **`dry-run` reviewed** before `apply` (§1.4) — cheapest place to catch a bad decomposition.
5. **One engine launch at a time per Linear project** in §2.3. Two engines on one project will
   double-claim.

## Teaching moments (call these out)

- **The bridge is the point.** AI-DLC plans; OpenSymphony executes; neither knows the other's
  format. `aidlc-to-tasks` is the adapter, and it's *validator-gated* — show participants the
  generate→validate→fix loop. This is the reusable idea they take home.
- **Dependencies become real.** The `blockedBy`/`blocks` edges from the dependency matrix turn into
  Linear blocker relations that actually gate the engine's scheduling. Point at a dependent ticket
  sitting idle until its blocker merges.
- **The workpad comment** is the agent's externalized working memory — open one live in Linear.
- **Spec fidelity.** Good acceptance criteria trace back to a spec section. Show a weak vs strong
  criterion.

## Common failure modes & recovery

| Failure | Recovery |
|---|---|
| AI-DLC stalls on questions | Tell them to pick sensible defaults and move on; the plan is iterable. |
| Bridge emits a cycle | The converter names it; break the edge, re-validate. Good discussion of dependency design. |
| `apply` duplicates issues | They re-ran into a different project, or deleted `linear-publish.yaml`. Use the existing project; the mapping makes `apply` idempotent. |
| Engine doesn't claim anything | Wrong `project_slug`, or issues not in `active_states`. Check `opensymphony doctor`. |
| Clone hook fails | `SYMPHONY_TARGET_REPO_URL` wrong or `gh`/SSH not set. Verify with a manual `git clone`. |
| Agent loops/stuck | `/debug <ISSUE>`; inspect the workspace `stdout.ndjson`. Lower `max_turns` if needed. |
| Running out of time in Phase 2 | It's fine to leave the engine running and review PRs async; Phase 1 is the learning core. |

## Scaling the scope

- **Short session:** cap AI-DLC at ~6–8 units (core conformance, §18.1). Skip §18.2 extensions and
  Appendix A (SSH workers).
- **Full day:** allow user stories, NFR stages, and a richer decomposition; let the engine run to
  several merged PRs and do live review.

## After the workshop

- Have participants keep their `aidlc-docs/`, `docs/tasks/`, and `linear-publish.yaml` — it's a
  complete, reproducible planning artifact.
- Debrief: where did the plan diverge from the spec? Which tickets were under-scoped? What would
  they change about the unit boundaries?
