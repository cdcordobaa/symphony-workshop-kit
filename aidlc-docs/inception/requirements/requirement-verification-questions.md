# Requirements Verification Questions — Symphony Orchestrator (Run 2)

**Stage:** INCEPTION → Requirements Analysis
**Inputs:** `spec/SYMPHONY-SPEC.md` (canonical), `spec/PRD.md` (locked variant decisions D1–D8).

> You asked to keep questions to a minimum and follow the PRD/spec as closely as possible.
> I resolved everything the PRD already decides as **assumptions** (below) — no answer needed for
> those. **Only one question** genuinely needs your input. Answer it after the `[Answer]:` tag, then
> tell me **"done"** and I'll generate `requirements.md`.

---

## Resolved directly from the PRD/spec (no question — override only if you disagree)

| # | Resolved as | Source |
|---|---|---|
| Conformance target | Core Conformance only, MVP walking-skeleton first | PRD D1, §5.1–5.3 |
| Observability | Structured logs + simple terminal status surface (no HTTP/JSON/web) | PRD D2 |
| Tracker | Notion databases via Notion MCP | PRD D3 |
| Agent | Claude Code headless behind abstract Agent Runner | PRD D4 |
| Approval posture | High-trust; user-input-required = hard failure | PRD D5 |
| Language | TypeScript / Node.js | PRD D6 |
| **Security extension** | **Opted OUT** (workshop-grade) — §9.5/§15.2 safety invariants stay REQUIRED | PRD D7 |
| Pipeline | All-Notion; Linear bridge & Rust engine out of *target* scope | PRD D8 |
| Active / terminal states | PRD §8 defaults (active `["Todo","In Progress"]`; terminal `["Closed","Cancelled","Canceled","Duplicate","Done"]`), operator-overridable in `WORKFLOW.md` | PRD §8 |
| `blocked_by` mapping | Normalize from a Notion "blocked by" relation into `blocked_by[]` (§4 issue model); exact board property name = Construction detail | PRD §10, spec §4 |
| Notion id binding | Bind to the configured Notion board id; data-source-vs-database resolution deferred to Construction | PRD §10 |
| Build tooling / test framework / project layout | Chosen in Construction | PRD §10 |

> **Note on Security (mandatory opt-in):** the AI-DLC security extension normally asks an opt-in
> question here. PRD **D7** already answers it (**opted out**), so I'm recording that decision rather
> than re-asking. The three workspace safety invariants (cwd confinement, path-root containment,
> identifier sanitization) remain hard requirements. If you'd rather enforce the full Security
> Baseline, say so under the question below.

---

## The one open question

## Question 1 — Backlog / milestone structure to publish in this Phase-1 pass

The PRD separates the **MVP walking skeleton** (§5.2, "BUILD THIS FIRST") from the **Deferred items**
(§5.3) that complete full Core Conformance, and states "Core Conformance = MVP + every deferred item
re-enabled." How should the working units / Linear backlog be organized when we decompose?

A) **Two milestones in one pass** — "MVP Walking Skeleton" (built first) + "Core Conformance Completion" (deferred items), with blocker relations so MVP precedes deferred. Most faithful to PRD §5.2/§5.3. *(Recommended)*
B) **MVP only now** — decompose & publish only the MVP units this pass; run INCEPTION again later for the deferred set.
C) **Single flat Core Conformance backlog** — one wave covering everything, no MVP-vs-deferred split.
X) Other (please describe after [Answer]: tag below)

[Answer]: Let's go with B and let's generate the first work units I can progress on as soon as possible. 
