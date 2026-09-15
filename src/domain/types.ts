/**
 * Core domain model — Symphony spec §4 "Core Domain Model".
 *
 * Types only. No behavior, no imports outside this directory: `src/domain/` is the
 * innermost layer of §3.2 and every other layer depends inward onto it.
 *
 * Notion adaptation: this build targets a Notion tracker, so the spec's Linear-shaped
 * `tracker.api_key` / `tracker.project_slug` appear here as `auth` / `database_id`, and
 * the spec's `codex.*` runner block is repurposed onto `agent.*`. Both adaptations are
 * fixed by the repository contract in the root `WORKFLOW.md`, which is the file the
 * config loader (ARK-59) must parse.
 */

/* ------------------------------------------------------------------------- *
 * §4.1.1 Issue
 * ------------------------------------------------------------------------- */

/**
 * Blocker reference attached to an {@link Issue}'s `blocked_by` (§4.1.1).
 *
 * Every field is nullable: trackers expose blocker relations with varying
 * completeness, and eligibility (§8.2) only needs whatever `state` is available.
 */
export interface BlockerRef {
  /** Stable tracker-internal ID of the blocking issue. */
  id: string | null;
  /** Human-readable key of the blocking issue (example: `ABC-123`). */
  identifier: string | null;
  /** Blocking issue's tracker state name; compared after lowercasing (§4.2). */
  state: string | null;
}

/**
 * Normalized issue record used by orchestration, prompt rendering, and
 * observability (§4.1.1).
 *
 * This is the single shape every tracker adapter normalizes into (§11.3), which is
 * what makes the tracker swappable (PRD §2).
 *
 * Field set note: FR5 names the seven fields the Notion adapter MUST populate
 * (`id, identifier, title, state, priority, labels, blocked_by`). The full §4.1.1
 * entity is wider, and the extra fields are load-bearing downstream — the prompt
 * template renders `issue.description` and `issue.url` under strict Liquid (§12.2,
 * where an undefined variable is an error), and candidate sorting is priority then
 * `created_at` (§8.2). The spec field set is therefore implemented in full.
 */
export interface Issue {
  /** Stable tracker-internal ID. Use for tracker lookups and internal map keys (§4.2). */
  id: string;
  /** Human-readable ticket key. Use for logs and workspace naming (§4.2). */
  identifier: string;
  title: string;
  description: string | null;
  /** Lower numbers are higher priority in dispatch sorting (§8.2). */
  priority: number | null;
  /** Current tracker state name. Compare after lowercasing (§4.2). */
  state: string;
  /** Tracker-provided branch metadata, if the tracker supplies it. */
  branch_name: string | null;
  url: string | null;
  /** Normalized to lowercase (§4.1.1). */
  labels: string[];
  /** Inverse "blocks" relations; gates eligibility (§8.2). */
  blocked_by: BlockerRef[];
  /** ISO-8601 timestamp. Secondary dispatch sort key (§8.2). */
  created_at: string | null;
  /** ISO-8601 timestamp. */
  updated_at: string | null;
}

/* ------------------------------------------------------------------------- *
 * §4.1.2 Workflow Definition
 * ------------------------------------------------------------------------- */

/**
 * Parsed `WORKFLOW.md` payload (§4.1.2) — the raw two halves of the repository
 * contract, before typing and environment resolution.
 */
export interface WorkflowDefinition {
  /** YAML front matter root object, untyped. {@link ServiceConfig} is the typed view. */
  config: Record<string, unknown>;
  /** Markdown body after the front matter, trimmed (§5.2). */
  prompt_template: string;
}

/* ------------------------------------------------------------------------- *
 * §4.1.3 Service Config (typed view)
 * ------------------------------------------------------------------------- */

/**
 * Tracker settings (§6.4, Notion variant). `auth` is resolved after `$VAR`
 * indirection and MUST NOT be logged (§15.3).
 */
export interface TrackerConfig {
  /** Tracker kind. `notion` for this build. */
  kind: string;
  /** Integration token after `$VAR` resolution; `null` when absent or empty. */
  auth: string | null;
  /** Notion database id holding the issues; `null` when absent. */
  database_id: string | null;
  /** States that make an issue a dispatch candidate. Default `["Todo", "In Progress"]`. */
  active_states: string[];
  /**
   * States that stop a run. Default
   * `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`.
   *
   * A state in neither list (for example `In Review`) pauses the issue and waits
   * for a human — the review gate is a gap between these two lists, not a feature.
   */
  terminal_states: string[];
}

/** Poll loop settings (§8.1). */
export interface PollingConfig {
  /** Milliseconds between poll ticks. Default `30000`. */
  interval_ms: number;
}

/** Workspace settings (§9.1). */
export interface WorkspaceConfig {
  /** Absolute path after `~` / `$VAR` expansion. Default `<system-temp>/symphony_workspaces`. */
  root: string;
}

/** Workspace lifecycle hook scripts (§9.4). `null` means "not configured". */
export interface HooksConfig {
  /** Runs once, only when the workspace directory was created by this run. */
  after_create: string | null;
  /** Runs before each agent launch. */
  before_run: string | null;
  /** Runs after each agent run completes. */
  after_run: string | null;
  /** Runs before the workspace is removed. */
  before_remove: string | null;
  /** Per-hook timeout in milliseconds. Default `60000`. */
  timeout_ms: number;
}

/**
 * Coding-agent settings (§6.4 `agent.*` + `codex.*`, merged onto `agent.*` for this
 * build per the root `WORKFLOW.md`).
 */
export interface AgentConfig {
  /** Launch command for the coding agent. `claude` for this build. */
  command: string;
  /** Global concurrency cap. Default `10`. */
  max_concurrent_agents: number;
  /** Per-state concurrency caps, keyed by lowercased state name (§8.3). Default `{}`. */
  max_concurrent_agents_by_state: Record<string, number>;
  /** Turn budget for one run. Default `20`. */
  max_turns: number;
  /** Ceiling on retry backoff, milliseconds. Default `300000`. */
  max_retry_backoff_ms: number;
  /** Idle-event timeout before a run is treated as stalled, ms. Default `300000`. */
  stall_timeout_ms: number;
}

/**
 * Typed runtime view of {@link WorkflowDefinition.config} after defaults, `$VAR`
 * resolution, and path normalization (§4.1.3, §6.1). Produced by ARK-59.
 */
export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  /** The prompt template carried through from the workflow body (§5.4). */
  prompt_template: string;
}

/* ------------------------------------------------------------------------- *
 * §4.1.4 Workspace
 * ------------------------------------------------------------------------- */

/** Filesystem workspace assigned to one issue identifier (§4.1.4). */
export interface Workspace {
  /** Absolute workspace path. Must resolve inside the workspace root (§9.5 invariant 2). */
  path: string;
  /** Issue identifier sanitized to `[A-Za-z0-9._-]` (§4.2, §9.5 invariant 3). */
  workspace_key: string;
  /** `true` only when this call created the directory; gates `after_create` (§9.4). */
  created_now: boolean;
}

/* ------------------------------------------------------------------------- *
 * §4.1.5 Run Attempt
 * ------------------------------------------------------------------------- */

/** Terminal and in-flight outcomes of a {@link RunAttempt}. */
export type RunAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled";

/** One execution attempt for one issue (§4.1.5). */
export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  /** `null` for the first run, `>= 1` for retries/continuations (§12.3). */
  attempt: number | null;
  workspace_path: string;
  /** ISO-8601 timestamp. */
  started_at: string;
  status: RunAttemptStatus;
  /** Populated when `status` is `failed` or `timeout`. */
  error?: string;
}

/* ------------------------------------------------------------------------- *
 * §4.1.8 Orchestrator Runtime State
 * ------------------------------------------------------------------------- */

/** One in-flight run tracked by {@link OrchestratorState.running}. */
export interface RunningEntry {
  issue_id: string;
  issue_identifier: string;
  /** Tracker state at dispatch; keys the per-state concurrency caps (§8.3). */
  dispatch_state: string;
  workspace_path: string;
  /** ISO-8601 timestamp. */
  started_at: string;
  /** `null` for the first run, `>= 1` for retries/continuations. */
  attempt: number | null;
}

/**
 * The single authoritative scheduling state, owned by the orchestrator (§4.1.8).
 *
 * In-memory only — there is no scheduler database (§5.4). On restart this is
 * rebuilt from the tracker plus the filesystem (§14.3), which is what makes the
 * daemon safe to kill mid-run.
 *
 * Deferred to the later Core Conformance pass, per this ticket's out-of-scope list:
 * `retry_attempts` (§4.1.7 Retry Entry) and the `codex_totals` / `codex_rate_limits`
 * accounting that depends on §4.1.6 Live Session.
 */
export interface OrchestratorState {
  /** Current effective poll interval, ms. Re-read on dynamic reload (§6.2). */
  poll_interval_ms: number;
  /** Current effective global concurrency limit. */
  max_concurrent_agents: number;
  /** In-flight runs, keyed by `issue.id`. */
  running: Record<string, RunningEntry>;
  /** Issue IDs reserved, running, or awaiting retry. Gates double-dispatch. */
  claimed: Set<string>;
  /** Issue IDs seen reaching a terminal state. Bookkeeping only, never gates dispatch. */
  completed: Set<string>;
}
