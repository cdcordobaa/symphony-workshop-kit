/**
 * Workspace error contract (Symphony spec §9, §15.2).
 *
 * A {@link WorkspaceError} carries a stable `code` so callers can branch on the
 * failure category without string-matching messages. The three `safety_*` codes
 * map one-to-one onto the mandatory §9.5 invariants; they are raised eagerly and
 * are NOT recoverable — a safety-invariant violation means the workspace must not
 * be used to launch an agent (§15.2 "Mandatory").
 */

/** Stable workspace failure categories. */
export type WorkspaceErrorCode =
  /** Invariant A (§9.5.1): agent `cwd` did not equal the per-issue workspace path. */
  | "safety_cwd_mismatch"
  /** Invariant B (§9.5.2): the resolved path escapes the normalized workspace root. */
  | "safety_root_escape"
  /** Invariant C (§9.5.3): the identifier could not be sanitized to a usable key. */
  | "safety_invalid_key"
  /** A filesystem operation (stat/mkdir/rm) failed unexpectedly. */
  | "workspace_io_error";

/** A typed workspace failure. Safety-invariant violations use the `safety_*` codes. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  /** Original error, when this wraps a filesystem/transport failure. */
  readonly cause?: unknown;

  constructor(code: WorkspaceErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.cause = cause;
  }
}

/** True when `value` is a {@link WorkspaceError} (safe across module realms). */
export function isWorkspaceError(value: unknown): value is WorkspaceError {
  return value instanceof WorkspaceError || (value as WorkspaceError)?.name === "WorkspaceError";
}
