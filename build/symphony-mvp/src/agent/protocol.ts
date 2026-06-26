/**
 * Claude Code headless protocol interpretation (U4; SYMPHONY-SPEC §10.2–§10.6,
 * adapted from the Codex app-server protocol to the Claude Code stream).
 *
 * Claude Code in headless print mode (`--output-format stream-json`) emits one
 * JSON object per line. The shapes we rely on for the MVP single turn:
 *
 *   { "type": "system", "subtype": "init", "session_id": "<uuid>", ... }
 *   { "type": "assistant" | "user", "session_id": "<uuid>", "message": {...} }
 *   { "type": "result", "subtype": "success" | "error_*",
 *     "session_id": "<uuid>", "is_error": bool, "result": "...", ... }
 *
 * The protocol is treated as the source of truth (§10): we extract identity and
 * terminal signals from it rather than hard-coding a schema. From the
 * `session_id` we derive the spec's `thread_id` + `turn_id` and emit
 * `session_id = "<thread_id>-<turn_id>"` (§10.2). High-trust handling (§10.5):
 * an `init` line that asks for user input, or a `result` carrying a
 * permission/user-input error, is mapped to a hard failure
 * (`turn_input_required`); unsupported tool calls do not stall (we never block
 * on them — the agent process drives itself).
 */

/** Normalized error categories (§10.6, adapted to Claude Code). */
export type AgentErrorCategory =
  | "agent_not_found"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "port_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  | "render_failed"
  | "malformed_protocol";

/** A single parsed protocol line. */
export type ParsedLine =
  | { kind: "session_init"; threadId: string }
  | { kind: "turn_completed"; threadId: string | null; summary?: string }
  | {
      kind: "turn_failed";
      threadId: string | null;
      category: AgentErrorCategory;
      reason: string;
    }
  | { kind: "input_required"; threadId: string | null; reason: string }
  | { kind: "notification"; threadId: string | null; message?: string }
  | { kind: "malformed"; raw: string }
  | { kind: "ignored" };

/** Extract a string field from an unknown object, or null. */
function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Parse one stream-json line into a {@link ParsedLine}. Blank lines are
 * ignored; non-JSON lines are reported as `malformed` (§10.4 `malformed`) so the
 * runner can decide whether they matter (they don't terminate the turn on their
 * own).
 */
export function parseProtocolLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "ignored" };

  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "malformed", raw: trimmed };
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return { kind: "malformed", raw: trimmed };
  }

  const type = str(obj, "type");
  const threadId = str(obj, "session_id");

  // Session bootstrap line — carries the thread identity.
  if (type === "system" && str(obj, "subtype") === "init") {
    if (threadId === null) return { kind: "malformed", raw: trimmed };
    return { kind: "session_init", threadId };
  }

  // Terminal result line.
  if (type === "result") {
    const subtype = str(obj, "subtype");
    const isError = obj["is_error"] === true || subtype !== "success";
    if (!isError) {
      return {
        kind: "turn_completed",
        threadId,
        summary: str(obj, "result") ?? undefined,
      };
    }
    // High-trust: a permission / user-input result is a hard failure (§10.5).
    const reason =
      str(obj, "result") ?? str(obj, "error") ?? subtype ?? "turn failed";
    const category = categorizeResultError(subtype, reason);
    if (category === "turn_input_required") {
      return { kind: "input_required", threadId, reason };
    }
    return { kind: "turn_failed", threadId, category, reason };
  }

  // Anything else (assistant/user/tool messages) is a non-terminal update.
  if (type === "assistant" || type === "user" || type === "stream_event") {
    return { kind: "notification", threadId, message: type };
  }

  return { kind: "ignored" };
}

/** Map a Claude Code error result to a normalized category (§10.6). */
function categorizeResultError(
  subtype: string | null,
  reason: string,
): AgentErrorCategory {
  const hay = `${subtype ?? ""} ${reason}`.toLowerCase();
  if (
    hay.includes("permission") ||
    hay.includes("user input") ||
    hay.includes("user-input") ||
    hay.includes("requires approval") ||
    hay.includes("confirmation")
  ) {
    return "turn_input_required";
  }
  if (subtype === "error_max_turns" || hay.includes("max turns")) {
    return "turn_failed";
  }
  return "turn_failed";
}

/**
 * Build the spec session id from a thread id and a turn id (§10.2):
 * `session_id = "<thread_id>-<turn_id>"`.
 */
export function makeSessionId(threadId: string, turnId: string): string {
  return `${threadId}-${turnId}`;
}
