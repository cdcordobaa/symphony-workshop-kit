# Requirements Verification Questions — Symphony Orchestrator

The canonical spec (`spec/SYMPHONY-SPEC.md`) is highly prescriptive about *what* the orchestrator
must do, so most functional requirements are already fixed. These questions resolve the **scoping
and implementation-posture decisions the spec intentionally leaves open** ("implementation-defined",
OPTIONAL features, and conformance target). Your answers drive the Workflow Planning and Units
Generation stages — i.e. how many Linear milestones/issues we produce and what their acceptance
criteria are.

Answer each by putting a letter after the `[Answer]:` tag. If none fit, pick the last option (Other)
and describe.

> **NOTE (answers captured 2026-05-30):** The user answered conversationally plus a clarification
> round. The headline reframing: build an **ultra-lightweight Symphony**, **terminal-only (no GUI)**,
> **TypeScript**, with **Notion** (Notion databases) as the tracker via the **Notion MCP** server
> (NOT Linear), and **Claude Code** as the implementation agent (NOT Codex app-server). The whole
> Phase-1 pipeline goes "all Notion": the kit's Linear bridge (`/convert-tasks-to-linear`) and the
> bundled OpenSymphony Rust engine are **out of scope**. Answers recorded below.

---

## Question 1
**Conformance target** — how much of the spec are we planning to build? (See §17 validation profiles
and §18 Definition of Done. The reading guide recommends targeting Core Conformance for a
workshop-sized build.)

A) **Core Conformance only** (§18.1) — required components only; treat §18.2 recommended extensions and Appendix A as out of scope *(recommended for the workshop)*
B) Core + a chosen subset of §18.2 recommended extensions (specify which in Q3–Q5)
C) Everything — Core + all §18.2 extensions + Appendix A SSH worker
X) Other (please describe after [Answer]: tag below)

[Answer]: A — Core Conformance only (§18.1), trimmed for "ultra-lightweight". §18.2 extensions and Appendix A out of scope.

---

## Question 2
**Observability surface** — the spec REQUIRES structured logs (§13.1) but treats the snapshot
interface and HTTP server/dashboard as OPTIONAL/RECOMMENDED (§13.3, §13.7). How far do we go?

A) **Structured logs only** — minimal core observability (§13.1–§13.2) *(smallest scope)*
B) Logs + in-memory runtime **snapshot interface** (§13.3), no HTTP server
C) Logs + snapshot + **OPTIONAL HTTP server**: dashboard `/` and JSON API `/api/v1/*` (§13.7)
X) Other (please describe after [Answer]: tag below)

[Answer]: A (+ simple terminal status) — Structured logs are the required baseline; add a simple terminal status surface only. No HTTP server, no JSON API, no web dashboard.

---

## Question 3
**`linear_graphql` client-side tool extension** (§10.5) — lets the coding agent run raw Linear
GraphQL (read/write tickets) through the orchestrator's configured auth. It is OPTIONAL (§18.2) but
is how the agent typically performs ticket state transitions/comments (§11.5).

A) **Include** the `linear_graphql` tool extension
B) **Skip** it — agent handles ticket writes by other means / out of scope for now
X) Other (please describe after [Answer]: tag below)

[Answer]: B / N/A — No Linear, so no `linear_graphql`. The Claude Code agent already has the Notion MCP server available and updates ticket state in Notion directly; no orchestrator-side client tool needed.

---

## Question 4
**Agent Runner target** — §10 specifies integration with a **Codex app-server** over stdio. In this
workshop the *driving* engine (OpenSymphony) uses Claude Code, but the orchestrator **we are
specifying** is the Symphony spec target. How should the Agent Runner be designed?

A) **Follow the spec literally** — Codex app-server over stdio as the agent protocol (§10) *(spec-faithful)*
B) **Abstract the Agent Runner** behind an interface, with Codex app-server as the first concrete adapter (easier to swap agents later)
X) Other (please describe after [Answer]: tag below)

[Answer]: X — Agent is **Claude Code** (headless/non-interactive), launched as a subprocess in the per-issue workspace. Wrap it behind an abstract Agent Runner interface (Codex app-server NOT used). Map the spec's session/thread/turn + streaming-event model onto Claude Code's invocation.

---

## Question 5
**Approval / sandbox posture** — the spec makes this implementation-defined but REQUIRES that the
implementation pick and document a posture (§10.5, §15.1). It becomes an explicit acceptance
criterion.

A) **High-trust** — auto-approve command execution and file-change approvals for the session; treat user-input-required turns as hard failure *(matches the spec's example behavior; simplest)*
B) **Strict** — require operator approval and/or stricter sandboxing; surface approvals rather than auto-approving
X) Other (please describe after [Answer]: tag below)

[Answer]: A — High-trust: auto-approve command execution and file changes for the session; treat user-input-required as hard failure. To be documented as the implementation's posture (§10.5/§15.1).

---

## Question 6
**Target implementation language** for the orchestrator being built. The spec is language-agnostic;
this does not change requirements, but it shapes the wording of task files and `Test Plan` sections
the engine's agents will implement against.

A) Rust
B) TypeScript / Node.js
C) Python
D) Go
X) Other (please describe after [Answer]: tag below)

[Answer]: B — TypeScript / Node.js for all code.

---

## Question 7 — Security Extensions (extension opt-in)
Should security extension rules be enforced for this project?

A) Yes — enforce all SECURITY rules as blocking constraints (recommended for production-grade applications)
B) No — skip all SECURITY rules (suitable for PoCs, prototypes, and experimental projects)
X) Other (please describe after [Answer]: tag below)

[Answer]: B — Skip the SECURITY extension (workshop-grade). NOTE: the spec's own MANDATORY filesystem-safety invariants (§9.5 / §15.2) remain in scope as hard functional requirements regardless of this opt-out.

---

## Question 8 (optional)
Anything else to constrain or emphasize for this build (e.g. must-hit spec sections, time box,
specific test framework, CI expectations)? Leave blank if none.

[Answer]: Headline constraints — **ultra-lightweight** build; **terminal-only, no GUI**; **Notion databases** are the board/tracker, connected via the **Notion MCP** server (no Linear); **Claude Code** is the implementation agent; **all code in TypeScript**. The whole pipeline goes "all Notion": the kit's Linear bridge and the bundled OpenSymphony Rust engine are out of scope — the orchestrator we build is itself what polls Notion and launches Claude Code.
