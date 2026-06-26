/**
 * Typed Service Config (SYMPHONY-SPEC §4.1.3, §6) — the Notion variant
 * (requirements.md §7). This is the typed view derived from
 * `WorkflowDefinition.config` after defaults, `$VAR` resolution, path
 * normalization, and coercion.
 *
 * Only the MVP walking-skeleton fields are surfaced here; later units extend
 * this without rewriting the existing shape.
 */

/** Tracker block (requirements.md §7 — Notion variant of §5.3.1). */
export interface TrackerConfig {
  /** REQUIRED for dispatch. Currently only `notion` is supported. */
  kind: string;
  /** Notion database / data-source identifier (REQUIRED for dispatch). */
  database: string | null;
  /** Notion auth — literal or resolved from `$VAR`; empty ⇒ missing. */
  api_key: string | null;
  /** State names treated as active/dispatchable. */
  active_states: string[];
  /** State names treated as terminal. */
  terminal_states: string[];
}

/** Polling block (§5.3.2). */
export interface PollingConfig {
  interval_ms: number;
}

/** Workspace block (§5.3.3). `root` is normalized to an absolute path. */
export interface WorkspaceConfig {
  root: string;
}

/** Workspace lifecycle hooks (§5.3.4). */
export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

/**
 * Agent block (requirements.md §7 — `codex.*` repurposed to `agent.*`
 * for the Claude Code runner).
 */
export interface AgentConfig {
  /** Launch command, run via `bash -lc` in the workspace cwd. */
  command: string;
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  /** Per-state concurrency caps; keys normalized to lowercase. */
  max_concurrent_agents_by_state: Record<string, number>;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

/** The fully-resolved, typed service configuration. */
export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
}

/**
 * Parsed `WORKFLOW.md` payload (§4.1.2). `config` is the raw front-matter root
 * object; `prompt_template` is the trimmed Markdown body.
 */
export interface WorkflowDefinition {
  /** Front-matter root object (NOT nested under a `config` key). */
  config: Record<string, unknown>;
  /** Trimmed Markdown body after the front matter. */
  prompt_template: string;
  /** Typed view of `config` after resolution. */
  service: ServiceConfig;
  /** Absolute path of the loaded WORKFLOW.md (used for relative resolution). */
  source_path: string;
}
