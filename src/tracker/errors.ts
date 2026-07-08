/**
 * Tracker error contract (Symphony spec §11.4).
 *
 * Every failure the tracker adapter can surface is a {@link TrackerError} with a
 * stable `code`. All of them are RECOVERABLE by design: the orchestrator logs the
 * error and skips the affected tick (candidate fetch) or keeps workers running
 * (state refresh) rather than crashing (§11.4 "Orchestrator behavior on tracker
 * errors"). Nothing in this module ever calls `process.exit` or rethrows a raw
 * transport error to the caller.
 */

/** Stable error categories (§11.4, adapted Linear → Notion/MCP). */
export type TrackerErrorCode =
  /** `tracker.kind` is not a value this adapter supports. */
  | "unsupported_tracker_kind"
  /** `tracker.auth` is required for the configured transport but is absent. */
  | "missing_tracker_auth"
  /** The underlying Notion MCP tool call failed (transport-level). */
  | "notion_mcp_request"
  /** The MCP tool returned a payload we could not interpret as rows. */
  | "notion_unknown_payload"
  /** A row could not be normalized into the §4 `Issue` model. */
  | "notion_normalize_error";

/**
 * A typed, recoverable tracker failure. `recoverable` is always `true`: it exists
 * so a caller can assert the contract without string-matching the code.
 */
export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  readonly recoverable = true;
  /** Original error, when this wraps a transport/parse failure. */
  readonly cause?: unknown;

  constructor(code: TrackerErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "TrackerError";
    this.code = code;
    this.cause = cause;
  }
}

/** True when `value` is a {@link TrackerError} (safe across module realms). */
export function isTrackerError(value: unknown): value is TrackerError {
  return value instanceof TrackerError || (value as TrackerError)?.name === "TrackerError";
}
