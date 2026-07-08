/**
 * Consumer-layer interfaces (Symphony spec §9, §10.7, §11.1).
 *
 * U1 only defines and exports these contracts so later units can implement them
 * against a stable surface. No behavior is implemented here.
 */

import type { Issue } from "./types.js";

/* ------------------------------------------------------------------------- *
 * Workspace Manager — §9.
 * ------------------------------------------------------------------------- */

/** Filesystem workspace assigned to one issue identifier (§4.1.4). */
export interface Workspace {
  /** Absolute workspace path. */
  path: string;
  /** Sanitized issue identifier (§4.2: non `[A-Za-z0-9._-]` -> `_`). */
  workspace_key: string;
  /** `true` only if the directory was created during this call (gates `after_create`). */
  created_now: boolean;
}

/**
 * Manages per-issue workspaces and lifecycle hooks while enforcing the three
 * safety invariants in §9.5 (cwd confinement, root containment, key sanitization).
 */
export interface WorkspaceManager {
  /** Deterministic absolute path for an issue identifier, under the workspace root. */
  workspacePathFor(identifier: string): string;
  /** Create-or-reuse the per-issue workspace; runs `after_create` only when newly created. */
  prepare(identifier: string): Promise<Workspace>;
  /** Remove the workspace; runs `before_remove` first (failures logged and ignored). */
  remove(identifier: string): Promise<void>;
}

/* ------------------------------------------------------------------------- *
 * Agent Runner — §10.7.
 * ------------------------------------------------------------------------- */

/** One execution attempt for one issue (§4.1.5). */
export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  /** `null` for the first run, `>= 1` for retries/continuations. */
  attempt: number | null;
  workspace_path: string;
  started_at: string;
  status: "running" | "succeeded" | "failed" | "timeout" | "cancelled";
  error?: string;
}

/**
 * Wraps workspace + prompt + app-server client for one attempt (§10.7). On any
 * error it fails the attempt and lets the orchestrator decide retry behavior.
 */
export interface AgentRunner {
  run(issue: Issue, attempt: number | null): Promise<RunAttempt>;
}

/* ------------------------------------------------------------------------- *
 * Observability — §13 Logging, Status, and Observability (Core subset).
 * ------------------------------------------------------------------------- */

/** Severity of a {@link LogRecord}, ordered least-to-most severe. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured context attached to a log record (§13.1). The three named fields
 * are the REQUIRED context for issue-related and session-lifecycle logs; extra
 * keys carry the `key=value` detail the spec asks for (`action`, `outcome`, …).
 */
export interface LogContext {
  /** Stable tracker-internal issue ID (§13.1, REQUIRED for issue logs). */
  issue_id?: string;
  /** Human-readable ticket key, e.g. `ABC-123` (§13.1, REQUIRED for issue logs). */
  issue_identifier?: string;
  /** Coding-agent session id (§13.1, REQUIRED for session-lifecycle logs). */
  session_id?: string;
  /** Arbitrary additional structured fields (rendered as `key=value`). */
  [key: string]: unknown;
}

/** One fully-resolved, structured log record — the unit a {@link LogSink} receives. */
export interface LogRecord {
  /** ISO-8601 timestamp of the record. */
  time: string;
  level: LogLevel;
  message: string;
  /** Merged bound + call-site context, after secret redaction. */
  context: LogContext;
}

/**
 * A destination for structured records (§13.2). Implementations MAY write to
 * stderr, a file, or a remote sink. `write` MUST NOT be relied upon to succeed:
 * the {@link Logger} isolates sink failures so a broken sink never reaches callers.
 */
export interface LogSink {
  write(record: LogRecord): void;
}

/**
 * Structured logger (§13.1). Every record carries merged context; secret values
 * are redacted before any sink sees them (§13, FR21). `child` returns a logger
 * with additional context bound — e.g. the orchestrator binds `issue_id`/
 * `issue_identifier`, then the agent binds `session_id`.
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** A logger that merges `context` into every record it emits. */
  child(context: LogContext): Logger;
}

/** A single currently-active run tracked by the {@link StatusSurface} (§13.4). */
export interface ActiveRun {
  /** Human-readable ticket key; the identity key for upsert/remove. */
  issue_identifier: string;
  /** Coding-agent session id, when a session has started. */
  session_id?: string;
  /** Short lifecycle phase, e.g. `running`, `retrying`. */
  phase?: string;
}

/**
 * Human-readable terminal status surface (§13.4). OPTIONAL per the spec and NOT
 * required for correctness: it draws only from orchestrator state, and rendering
 * or printing failures MUST NOT propagate to callers.
 */
export interface StatusSurface {
  /** Insert or replace the active run keyed by `issue_identifier`. */
  upsert(run: ActiveRun): void;
  /** Drop the active run for `issueIdentifier` (no-op if absent). */
  remove(issueIdentifier: string): void;
  /** Snapshot of the currently-active runs, in insertion order. */
  activeRuns(): ActiveRun[];
  /** Render the current active set as a single status line. */
  render(): string;
  /** Write the status line to the configured stream; never throws. */
  print(): void;
}

/* ------------------------------------------------------------------------- *
 * Tracker Client — §11.1 REQUIRED operations.
 * ------------------------------------------------------------------------- */

/**
 * Issue-tracker adapter. Normalized outputs MUST match the §4 domain model
 * regardless of the underlying transport (§11.2).
 */
export interface TrackerClient {
  /** Issues in configured active states for the configured project/database. */
  fetchCandidateIssues(): Promise<Issue[]>;
  /** Issues in the given states; used for startup terminal cleanup. Empty input -> `[]` with no call. */
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  /** Current states for the given issue IDs; used for active-run reconciliation. */
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}
