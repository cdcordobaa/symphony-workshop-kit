# OpenSymphony Engine Setup (Phase 2)

In Phase 2 the **OpenSymphony orchestrator** (Rust) is the engine: it polls your Linear project,
creates an isolated workspace per ticket, and launches **Claude Code CLI agents** to implement each
one. This kit does not vendor the engine binary — you point OpenSymphony at the `WORKFLOW.md` and
`config.yaml` in this `engine/` folder.

> ⚠️ **The Claude harness is EXPERIMENTAL and LOCAL-ONLY.** It runs `claude -p ... --dangerously-skip-permissions`,
> writes the resolved `LINEAR_API_KEY` into a per-workspace `mcp.json` in plaintext, and has no
> event replay, structured approvals, or multi-tenant mode. Run it only on a trusted single-user
> machine. See "Caveats" below.

## Prerequisites

- **Rust** (stable toolchain) — `rustc --version`, `cargo --version`.
- **`claude` CLI** on `$PATH` and authenticated — `claude --version`.
- **`git`** and **`gh`** (GitHub CLI, authenticated) — agents push branches and open PRs.
- Environment variables exported in the shell that runs the engine:
  ```bash
  export LINEAR_API_KEY="lin_api_..."      # same key Phase 1 used
  export ANTHROPIC_API_KEY="sk-ant-..."    # used by the claude CLI
  ```

## Get the OpenSymphony engine

Use a local checkout of the OpenSymphony repo (the Rust orchestrator). Either:

```bash
# Option A — run from a source checkout
git clone <opensymphony-repo-url> ~/src/OpenSymphony
cd ~/src/OpenSymphony
cargo build --release          # produces target/release/opensymphony

# Option B — install the binary onto PATH
cargo install --path ~/src/OpenSymphony/crates/opensymphony-cli
```

Confirm the CLI: `opensymphony --help` (or `cargo run -- --help` from the checkout).

## Wire the engine to your workshop

1. Edit `engine/WORKFLOW.md` and set the two placeholders:
   - `tracker.project_slug` → your Linear project's `slugId` (from the project URL).
   - `hooks.after_create` clone URL → your **target repo** git URL (the repo you seeded from
     `../target-repo-template/` and pushed to GitHub).
2. Leave the `claude:` block as-is — its presence selects the Claude harness.

## Preflight and run

```bash
# From wherever opensymphony is on PATH; --config points at this kit's engine config.
opensymphony doctor   --config /ABS/PATH/TO/symphony-workshop-kit/engine/config.yaml
opensymphony run      --config /ABS/PATH/TO/symphony-workshop-kit/engine/config.yaml
```

`opensymphony run` reads `WORKFLOW.md` from the working directory by default. Run it from this
`engine/` folder (so it finds `engine/WORKFLOW.md`), or copy `WORKFLOW.md` next to where you launch
the engine. `doctor` validates config, env, and tool availability before you commit to a full run.

## Observe

- **Control plane:** open `http://127.0.0.1:2468/` (the `control_plane.bind` from `config.yaml`)
  for the snapshot API and SSE event stream.
- **TUI:** `opensymphony tui --url http://127.0.0.1:2468`.
- **Per-workspace journal:** `~/.opensymphony/workspaces/<ISSUE>/.opensymphony/claude/`
  contains `session.json`, `mcp.json`, `stdout.ndjson`, `stderr.log` for debugging.

## What you should see

1. The engine polls Linear every 5s and finds `Todo` issues in your project.
2. For each (up to `max_concurrent_agents`), it creates `~/.opensymphony/workspaces/<ISSUE>/`,
   runs the `after_create` clone, then launches the Claude agent in that directory.
3. The agent moves the issue to `In Progress`, maintains the `## Agent Harness Workpad` comment,
   implements the ticket, opens a PR, attaches it to the issue, and moves it to `Human Review`.
4. You review/merge PRs. Blocker relations published in Phase 1 mean dependents wait for blockers.

## Caveats (experimental Claude harness)

- **Local-only / single-user.** `mcp.json` holds `LINEAR_API_KEY` in plaintext per workspace.
- **`dangerously-skip-permissions`** is the only permission mode — the agent acts without approval
  prompts. Only run against a target repo you control.
- **No event replay.** If the engine restarts mid-run, the per-workspace `stdout.ndjson` journal is
  the only event history.
- **Best-effort cancellation** (SIGTERM). Keep concurrency low.

## Troubleshooting

- Stuck or failing run → use `/debug <ISSUE-ID>` (the `debug` skill) to trace the journal/logs.
- Agent can't reach Linear → confirm `LINEAR_API_KEY` is exported in the engine's shell.
- Clone fails in `after_create` → check the target repo URL and `gh auth status` / SSH access.
- Issue never picked up → confirm its state is in `active_states` and it's in the configured project.
