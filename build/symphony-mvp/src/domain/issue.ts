/**
 * Normalized domain model for issues (SYMPHONY-SPEC §4.1.1).
 *
 * Every tracker adapter (U2) MUST normalize its native records into these shapes.
 * These types are the stable contract consumed by the orchestrator (U3), the
 * agent runner / prompt renderer (U4/U1), and observability (U5).
 */

/** A reference to a blocking issue (§4.1.1 `blocked_by[]`). */
export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/**
 * Normalized issue record used by orchestration, prompt rendering, and
 * observability output (§4.1.1).
 */
export interface Issue {
  /** Stable tracker-internal ID. */
  id: string;
  /** Human-readable ticket key (e.g. `ABC-123`). */
  identifier: string;
  title: string;
  description: string | null;
  /** Lower numbers are higher priority in dispatch sorting; null sorts last. */
  priority: number | null;
  /** Current tracker state name (compared after lowercasing). */
  state: string;
  /** Tracker-provided branch metadata if available. */
  branch_name: string | null;
  url: string | null;
  /** Normalized to lowercase. */
  labels: string[];
  blocked_by: BlockerRef[];
  /** ISO-8601 timestamp string, or null. */
  created_at: string | null;
  /** ISO-8601 timestamp string, or null. */
  updated_at: string | null;
}

/**
 * Minimal state-refresh shape used during reconciliation
 * (`fetchIssueStatesByIds`, §11.1 / FR-TR-1).
 */
export interface IssueStateRef {
  id: string;
  identifier: string | null;
  state: string;
}
