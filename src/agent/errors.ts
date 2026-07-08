/**
 * Agent Runner error contract (Symphony spec §10.6 Error Mapping).
 *
 * An {@link AgentError} carries a stable normalized `code` so the orchestrator
 * can branch on the failure category (and, later, decide retry behavior) without
 * string-matching messages. The codes are the RECOMMENDED normalized categories
 * from §10.6, adapted from the Codex app-server to the Claude Code headless CLI:
 * `codex_not_found` -> `agent_not_found`, `port_exit` kept for subprocess exit.
 */

/** Stable agent-runner failure categories (§10.6). */
export type AgentErrorCode =
  /** The coding-agent command could not be launched (missing binary / spawn error). */
  | "agent_not_found"
  /** Safety invariant A re-check failed: launch cwd did not equal the workspace path. */
  | "invalid_workspace_cwd"
  /** Strict prompt rendering failed (unknown/missing binding, malformed template). */
  | "prompt_render_error"
  /** The turn exceeded `agent.turn_timeout_ms`. */
  | "turn_timeout"
  /** The subprocess exited before emitting a terminal turn result. */
  | "port_exit"
  /** The turn produced a failure result (`is_error` / error subtype). */
  | "turn_failed"
  /** The turn was cancelled. */
  | "turn_cancelled"
  /** A user-input-required / interactive-approval signal — a hard failure (D5, §10.5). */
  | "turn_input_required";

/** A typed Agent Runner failure carrying a normalized §10.6 `code`. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  /** Original error, when this wraps a spawn/transport failure. */
  readonly cause?: unknown;

  constructor(code: AgentErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.cause = cause;
  }
}

/** True when `value` is an {@link AgentError} (safe across module realms). */
export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError || (value as AgentError)?.name === "AgentError";
}
