/**
 * Claude Code headless event stream (Symphony spec §10.3–§10.4, adapted).
 *
 * Codex app-server framing is replaced by the Claude Code `--output-format
 * stream-json` transport: one JSON object per stdout line. This module parses
 * those lines and normalizes them onto the spec §10.4 event vocabulary so the
 * runner and the rest of the system stay protocol-agnostic (§10 "keep query
 * construction isolated"): only this file knows the concrete Claude Code shapes.
 *
 * It also owns the two extraction rules the runner depends on:
 *   - session identity — `thread_id` from the stream `session_id`, `turn_id` from
 *     a per-message/turn `uuid`; combined as `"<thread_id>-<turn_id>"` (§10.2, FR16).
 *   - user-input-required detection — a control/permission/input signal that, under
 *     the high-trust posture, MUST be treated as a hard failure (§10.5, D5).
 */

/** Normalized event name (Symphony spec §10.4 vocabulary subset). */
export type AgentEventName =
  | "session_started"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  | "notification"
  | "other_message"
  | "malformed";

/** One normalized runtime event forwarded upstream to observability (§10.4). */
export interface AgentEvent {
  event: AgentEventName;
  /** UTC ISO-8601 timestamp the line was processed. */
  timestamp: string;
  /** Claude Code session/thread id, when the line carries one. */
  session_id?: string;
  /** Per-message / per-turn id (`uuid`), when present. */
  turn_id?: string;
  /** Short human-readable summary, when derivable. */
  message?: string;
  /** The parsed line object, or the raw string when the line was malformed. */
  raw: unknown;
}

/** Regex covering fields that signal an interactive input/approval request. */
const INPUT_REQUIRED = /input[_-]?required|user[_-]?input|awaiting[_-]?input|can[_-]?use[_-]?tool/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Extract the Claude Code session/thread id from a parsed line, if present. */
export function extractSessionId(raw: unknown): string | undefined {
  return str(asRecord(raw)?.["session_id"]);
}

/** Extract a per-message/turn id (`uuid`) from a parsed line, if present. */
export function extractTurnId(raw: unknown): string | undefined {
  return str(asRecord(raw)?.["uuid"]);
}

/**
 * True when a parsed line signals that the agent is blocked on user input or an
 * interactive approval. Under the high-trust posture this is a hard failure (D5):
 * a `control_request` (permission prompt) or any `type`/`subtype` matching the
 * input-required vocabulary. With `--permission-mode bypassPermissions` these
 * should not appear; detecting them is defense-in-depth against a stalled run.
 */
export function isUserInputRequired(raw: unknown): boolean {
  const obj = asRecord(raw);
  if (!obj) return false;
  const type = str(obj["type"]);
  const subtype = str(obj["subtype"]);
  if (type === "control_request") return true;
  return INPUT_REQUIRED.test(type ?? "") || INPUT_REQUIRED.test(subtype ?? "");
}

/** Combine the derived thread + turn ids into `session_id` (§10.2, FR16). */
export function deriveSessionId(threadId: string | undefined, turnId: string | undefined): string {
  return `${threadId ?? "unknown"}-${turnId ?? "0"}`;
}

/**
 * Parse and classify one stream-json line onto the §10.4 event vocabulary.
 * A line that is not valid JSON becomes a `malformed` event (never throws) so a
 * single bad line cannot abort turn processing.
 */
export function parseEventLine(line: string, timestamp: string): AgentEvent {
  const trimmed = line.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { event: "malformed", timestamp, raw: line };
  }

  const obj = asRecord(parsed);
  const base: AgentEvent = {
    event: "other_message",
    timestamp,
    session_id: extractSessionId(parsed),
    turn_id: extractTurnId(parsed),
    raw: parsed,
  };
  if (!obj) return base;

  // Interactive input/approval request — highest priority (hard failure upstream).
  if (isUserInputRequired(parsed)) return { ...base, event: "turn_input_required" };

  const type = str(obj["type"]);
  const subtype = str(obj["subtype"]);

  if (type === "system" && subtype === "init") return { ...base, event: "session_started" };

  if (type === "result") {
    const isError = obj["is_error"] === true;
    if (subtype && /cancel/i.test(subtype)) return { ...base, event: "turn_cancelled" };
    if (!isError && (subtype === "success" || subtype === undefined)) {
      return { ...base, event: "turn_completed", message: str(obj["result"]) };
    }
    return { ...base, event: "turn_failed", message: str(obj["result"]) ?? subtype };
  }

  if (type === "assistant" || type === "user") return { ...base, event: "notification" };

  return base;
}
