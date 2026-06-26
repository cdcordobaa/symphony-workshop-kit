/**
 * Single authoritative in-memory Orchestrator Runtime State (§4.1.8).
 *
 * Defined in U1 so that U3 (orchestrator) and U5 (observability) share one
 * contract. The MVP walking skeleton uses a strict subset; deferred fields
 * (retry queue, token totals, rate limits) are present so they slot in without
 * rework.
 */

/** One execution attempt for one issue (§4.1.5). */
export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  /** null for first run, >=1 for retries/continuation. */
  attempt: number | null;
  workspace_path: string;
  /** ISO-8601 timestamp. */
  started_at: string;
  status: "running" | "completed" | "failed" | "cancelled";
  error?: string;
}

/** A running worker entry tracked in `running` (keyed by issue_id). */
export interface RunningEntry {
  issue_id: string;
  issue_identifier: string;
  attempt: number | null;
  workspace_path: string;
  /** ISO-8601 timestamp. */
  started_at: string;
  /** Latest known session id (`<thread_id>-<turn_id>`), if a session started. */
  session_id: string | null;
  /** Number of agent turns started within this worker lifetime. */
  turn_count: number;
  /** Latest tracker-state snapshot used by reconciliation. */
  last_state: string | null;
}

/** Scheduled retry state for an issue (§4.1.7). Deferred post-MVP. */
export interface RetryEntry {
  issue_id: string;
  identifier: string | null;
  attempt: number;
  due_at_ms: number;
  timer_handle: unknown;
  error: string | null;
}

/** Aggregate token + runtime accounting (§4.1.8 `codex_totals`). Deferred. */
export interface AgentTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  runtime_seconds: number;
}

/**
 * The single authoritative scheduler state owned by the orchestrator (§4.1.8).
 * The orchestrator is the only component permitted to mutate this.
 */
export interface OrchestratorRuntimeState {
  /** Current effective poll interval (ms). */
  poll_interval_ms: number;
  /** Current effective global concurrency limit. */
  max_concurrent_agents: number;
  /** issue_id -> running entry. */
  running: Map<string, RunningEntry>;
  /** Issue IDs reserved/running/retrying. */
  claimed: Set<string>;
  /** issue_id -> retry entry (deferred post-MVP). */
  retry_attempts: Map<string, RetryEntry>;
  /** Issue IDs completed — bookkeeping only, NOT dispatch gating. */
  completed: Set<string>;
  /** Aggregate agent token + runtime totals (deferred post-MVP). */
  agent_totals: AgentTotals;
  /** Latest rate-limit snapshot from agent events (deferred post-MVP). */
  rate_limits: unknown | null;
}

/** Construct an empty runtime state from effective config values. */
export function createRuntimeState(
  poll_interval_ms: number,
  max_concurrent_agents: number,
): OrchestratorRuntimeState {
  return {
    poll_interval_ms,
    max_concurrent_agents,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    agent_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      runtime_seconds: 0,
    },
    rate_limits: null,
  };
}
