# Facilitator Preflight Checklist

Run through this **before** the session (ideally have participants do it the day before). Every
item should be green or the workshop stalls.

## Accounts & keys
- [ ] Linear workspace access; a **Personal API key** created (Settings → API).
- [ ] An **empty Linear project** created for the build; its **slugId** copied.
- [ ] Anthropic API key available (`ANTHROPIC_API_KEY`) for the `claude` CLI.
- [ ] GitHub account; `gh auth status` succeeds; can create a repo and push.

## Tools on PATH
- [ ] `claude --version` (CLI authenticated — `claude` runs interactively at least once).
- [ ] `python3 --version` (3.10+).
- [ ] `uv --version` (for the converter scripts).
- [ ] `git --version`, `gh --version`.
- [ ] Rust: `cargo --version`, `rustc --version`.
- [ ] OpenSymphony engine: a local checkout that builds (`cargo build --release`) **or** the
      `opensymphony` binary installed on PATH. Verify `opensymphony --help`.

## Kit sanity
- [ ] `cp .env.example .env` and fill `LINEAR_API_KEY`, `ANTHROPIC_API_KEY`.
- [ ] `set -a; . ./.env; set +a` then the `viewer.graphql` call returns your viewer.
- [ ] `uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py --help`
      runs (deps resolve).
- [ ] Claude Code opens the kit folder and recognizes the slash commands (`/linear`,
      `/aidlc-to-tasks`, `/convert-tasks-to-linear`).

## Target repo
- [ ] `target-repo-template/` pushed to a fresh GitHub repo; clone URL saved as
      `SYMPHONY_TARGET_REPO_URL`.
- [ ] The clone URL works from the machine that will run the engine (`git clone` + `gh auth`/SSH).

## Dry-run (recommended, facilitator only)
- [ ] Do a tiny 2-unit end-to-end pass into a **throwaway** Linear project to confirm the whole
      chain (AI-DLC → `/aidlc-to-tasks` → validate → apply → `opensymphony run` claims one ticket).
      Delete the throwaway issues afterward.

## Safety reminder to read aloud
- The Phase-2 harness runs agents with `--dangerously-skip-permissions` and stores the Linear key
  in plaintext per workspace. Local, single-user, trusted machine only. Use a repo you control.
