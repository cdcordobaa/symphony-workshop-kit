/**
 * Agent Runner (Claude Code) + strict prompt rendering (§10, §12) — Unit 1.5.
 *
 * Implements the ARK-49 {@link import("../domain/interfaces.js").AgentRunner} port:
 * renders a strict `issue` + `attempt` prompt, launches Claude Code headless in the
 * per-issue workspace (re-checking safety invariant A at launch), runs one turn,
 * maps success/failure, and forwards §10.4 events with a derived `session_id`.
 */

export * from "./errors.js";
export * from "./prompt.js";
export * from "./events.js";
export * from "./runner.js";
