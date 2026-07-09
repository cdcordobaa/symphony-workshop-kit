/**
 * Shared domain types (Symphony spec §4 Core Domain Model).
 *
 * These are the normalized records used by orchestration, prompt rendering, and
 * observability. They are transport-agnostic: a Notion tracker, a Linear tracker,
 * or a stub all normalize into the same {@link Issue} shape (§11.3).
 */

/**
 * Blocker reference attached to an {@link Issue} (§4.1.1 `blocked_by`).
 * Derived from inverse "blocks" relations; every field is best-effort.
 */
export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/**
 * Normalized issue record (§4.1.1). All keys are strings so the record can be
 * fed directly to the strict prompt renderer (§12.2).
 */
export interface Issue {
  /** Stable tracker-internal ID. Used for lookups and map keys. */
  id: string;
  /** Human-readable ticket key (example: `ABC-123`). Used for logs/workspace naming. */
  identifier: string;
  title: string;
  description: string | null;
  /** Lower numbers are higher priority in dispatch sorting. */
  priority: number | null;
  /** Current tracker state name (compared after lowercasing). */
  state: string;
  /** Tracker-provided branch metadata, if available. */
  branch_name: string | null;
  url: string | null;
  /** Normalized to lowercase. */
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
}

/* ------------------------------------------------------------------------- *
 * Service Config (typed view) — §4.1.3, adapted to the Notion tracker.
 * Built from WorkflowDefinition.config plus environment resolution.
 * ------------------------------------------------------------------------- */

/**
 * Tracker configuration (Notion variant of §5.3.1). Linear's `api_key`/`project_slug`
 * are adapted to Notion's `auth`/`database_id`.
 */
export interface TrackerConfig {
  /** Tracker kind. Supported value for this build: `notion`. */
  kind: string;
  /** Notion integration token, resolved after `$VAR` indirection. `null` when absent/empty. */
  auth: string | null;
  /** Notion database id holding the issues. `null` when absent. */
  database_id: string | null;
  /** Active states considered for dispatch. Default `["Todo", "In Progress"]`. */
  active_states: string[];
  /** Terminal states. Default `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`. */
  terminal_states: string[];
}

/** Polling configuration (§5.3.2). */
export interface PollingConfig {
  /** Poll cadence in milliseconds. Default `30000`. */
  interval_ms: number;
}

/** Workspace configuration (§5.3.3). */
export interface WorkspaceConfig {
  /** Normalized absolute workspace root. */
  root: string;
}

/** Workspace lifecycle hooks (§5.3.4 / §9.4). `null` when not configured. */
export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  /** Applies to all hooks. Default `60000`. */
  timeout_ms: number;
}

/**
 * Agent configuration. Per the U1 ticket, the spec's `codex.*` fields are
 * repurposed onto `agent.*` for the Claude Code runner (U4). Concurrency fields
 * (§5.3.5) and runner fields (§5.3.6) are merged here.
 */
export interface AgentConfig {
  /** Coding-agent launch command (shell string). Default `claude`. */
  command: string;
  /** Global concurrency cap. Default `10`. */
  max_concurrent_agents: number;
  /** Coding-agent turns per worker session. Positive integer. Default `20`. */
  max_turns: number;
  /** Retry backoff cap in ms. Default `300000` (5m). */
  max_retry_backoff_ms: number;
  /** Per-state concurrency overrides. Keys normalized to lowercase. Default `{}`. */
  max_concurrent_agents_by_state: Record<string, number>;
  /** Per-turn timeout in ms. Default `3600000` (1h). */
  turn_timeout_ms: number;
  /** App-server read timeout in ms. Default `5000`. */
  read_timeout_ms: number;
  /** Stall timeout in ms; `<= 0` disables stall detection. Default `300000` (5m). */
  stall_timeout_ms: number;
  /** Pass-through agent approval policy. Implementation-defined default (`null`). */
  approval_policy: string | null;
  /** Pass-through thread sandbox mode. Implementation-defined default (`null`). */
  thread_sandbox: string | null;
  /** Pass-through turn sandbox policy. Implementation-defined default (`null`). */
  turn_sandbox_policy: string | null;
}

/** Typed runtime configuration (§4.1.3) derived from a {@link import("../config/loader.js").WorkflowDefinition}. */
export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
}

/* ------------------------------------------------------------------------- *
 * Orchestrator runtime state — §4.1.8 and supporting records (§4.1.5–4.1.7).
 * ------------------------------------------------------------------------- */

/** Live coding-agent session metadata (§4.1.6). */
export interface LiveSession {
  /** `<thread_id>-<turn_id>`. */
  session_id: string;
  thread_id: string;
  turn_id: string;
  agent_pid: string | null;
  last_event: string | null;
  last_timestamp: string | null;
  last_message: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  turn_count: number;
}

/** One in-flight run, tracked under {@link OrchestratorRuntimeState.running}. */
export interface RunningEntry {
  issue_id: string;
  issue_identifier: string;
  /** `null` for the first run, `>= 1` for retries/continuations. */
  attempt: number | null;
  /**
   * Tracked issue state at dispatch time, used for per-state concurrency
   * accounting (§8.3). Compared case-insensitively via the state-set helpers.
   */
  state: string;
  workspace_path: string;
  started_at: string;
  session: LiveSession | null;
}

/** Scheduled retry state for an issue (§4.1.7). */
export interface RetryEntry {
  issue_id: string;
  /** Best-effort human ID for status surfaces/logs. */
  identifier: string | null;
  /** 1-based for the retry queue. */
  attempt: number;
  /** Monotonic-clock due timestamp (ms). */
  due_at_ms: number;
  /** Runtime-specific timer reference. */
  timer_handle: unknown | null;
  error: string | null;
}

/** Aggregate token + runtime accounting. */
export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  runtime_seconds: number;
}

/**
 * Single authoritative in-memory state owned by the orchestrator (§4.1.8).
 */
export interface OrchestratorRuntimeState {
  /** Current effective poll interval (ms). */
  poll_interval_ms: number;
  /** Current effective global concurrency limit. */
  max_concurrent_agents: number;
  /** `issue_id -> running entry`. */
  running: Map<string, RunningEntry>;
  /** Issue IDs reserved/running/retrying. */
  claimed: Set<string>;
  /** `issue_id -> RetryEntry`. */
  retry_attempts: Map<string, RetryEntry>;
  /** Bookkeeping only; not dispatch gating. */
  completed: Set<string>;
  /** Aggregate tokens + runtime seconds. */
  codex_totals: TokenTotals;
  /** Latest rate-limit snapshot from agent events. */
  codex_rate_limits: unknown | null;
}

/** Construct an empty {@link OrchestratorRuntimeState} seeded from a {@link ServiceConfig}. */
export function createRuntimeState(config: ServiceConfig): OrchestratorRuntimeState {
  return {
    poll_interval_ms: config.polling.interval_ms,
    max_concurrent_agents: config.agent.max_concurrent_agents,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      runtime_seconds: 0,
    },
    codex_rate_limits: null,
  };
}
