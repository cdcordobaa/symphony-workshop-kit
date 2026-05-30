# AGENTS.md — implementation context for Symphony (workshop build)

> Persistent context for coding agents implementing this repo. **Fill the placeholders below once
> the tech stack is chosen during AI-DLC Requirements Analysis.** Agents read this file first.

## Mission

Implement the **Symphony service specification** (see the workshop kit `spec/SYMPHONY-SPEC.md`).
Each Linear ticket is one working unit of that spec. Implement it to its acceptance criteria, with
tests, and open a PR.

## Tech stack

- Language / runtime: `<TODO: e.g. TypeScript + Node 20 / Rust stable / Python 3.12>`
- Test framework: `<TODO: e.g. Jest + Cucumber / cargo test / pytest>`
- Package manager / build: `<TODO>`

## Commands (the validation gate — keep these accurate)

```bash
# install deps
<TODO: e.g. npm ci>

# build / typecheck
<TODO: e.g. npm run build  |  cargo build>

# run the full test suite (agents MUST run this green before pushing)
<TODO: e.g. npm test  |  cargo test>

# lint / format check
<TODO: e.g. npm run lint  |  cargo clippy && cargo fmt --check>
```

## Non-negotiable invariants (from the spec)

Mirror the spec's hard requirements here so every agent enforces them. Seeds from the spec:

- **Workspace safety (§9):** agent cwd is confined to the issue workspace; workspace paths are
  contained under the configured root; issue identifiers are sanitized before use as paths.
- **Orchestrator authority (§7):** the orchestrator owns scheduling state; workers report events.
- **Tracker writes are agent-driven (§11):** the tracker client reads candidates/states; it does
  not own issue mutations beyond what the spec defines.
- `<TODO: add project-specific invariants as the design solidifies>`

## Conventions

- Branch names: `<TODO>`; commit style: conventional commits (`feat:`, `fix:`, `refactor:`).
- One ticket = one branch = one PR.
- Keep changes scoped to the assigned ticket; file a separate Linear issue for out-of-scope work.

## References

- Spec: `spec/SYMPHONY-SPEC.md` (in the workshop kit) — cite the relevant section in each PR.
- Skills: `.agents/skills/` (`linear`, `commit`, `push`, `pull`, `land`).
