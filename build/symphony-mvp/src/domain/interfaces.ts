/**
 * Cross-unit consumer interfaces (SYMPHONY-SPEC §4, §10, §11; unit-of-work §4).
 *
 * These are defined in U1 so that the tracker backend (U2) and the
 * agent/workspace backend (U4) stay swappable and decoupled from each other
 * (NFR-PORTABILITY). U3 (orchestrator) consumes ONLY these interfaces.
 *
 * Later units MUST implement these exact contracts; they MUST NOT redefine them.
 */

import type { Issue, IssueStateRef } from "./issue.js";

/**
 * Read-only tracker adapter (U2). The orchestrator is a reader/scheduler;
 * ticket writes are performed by the agent via its own tracker MCP tools
 * (FR-TR-6), not here.
 */
export interface TrackerClient {
  /**
   * Read pages of the configured tracker board in active states; paginate and
   * preserve order. (FR-TR-1, FR-TR-4)
   */
  fetchCandidateIssues(): Promise<Issue[]>;

  /**
   * Minimal state refresh for reconciliation. Returns a state ref per id that
   * could be resolved. (FR-TR-1)
   */
  fetchIssueStatesByIds(ids: string[]): Promise<IssueStateRef[]>;
}

/** Logical workspace assigned to one issue identifier (§4.1.4). */
export interface Workspace {
  /** Absolute workspace path. */
  path: string;
  /** Sanitized issue identifier used as the directory name. */
  workspace_key: string;
  /** true only when the directory was freshly created this call. */
  created_now: boolean;
}

/**
 * Per-issue workspace lifecycle + safety invariants (U4, §9). Implementations
 * MUST enforce the three FR-WS-3 invariants before any agent launch.
 */
export interface WorkspaceManager {
  /** Create-if-missing / reuse-if-present the workspace for an issue. */
  ensureWorkspace(issue: Issue): Promise<Workspace>;
  /** Remove a workspace directory (terminal cleanup). */
  removeWorkspace(workspace_key: string): Promise<void>;
}

/** Structured event emitted by an agent run (§10.4, FR-AG-5). */
export interface AgentEvent {
  type:
    | "session_started"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "notification"
    | "startup_failed"
    | "malformed";
  /** ISO-8601 timestamp. */
  timestamp: string;
  session_id?: string;
  message?: string;
  error?: string;
}

/** Outcome of a single agent run attempt (§10.7). */
export interface AgentResult {
  ok: boolean;
  session_id: string | null;
  /** Normalized error category when `ok === false` (§10.6). */
  error_category?: string;
  error?: string;
}

/** Inputs to a single agent run (one turn for the MVP). */
export interface AgentRunRequest {
  issue: Issue;
  /** null for first run, >=1 for retries/continuation. */
  attempt: number | null;
  workspace: Workspace;
  /** Fully-rendered prompt for this turn. */
  prompt: string;
}

/**
 * Abstract coding-agent runner (U4). Claude Code is the one concrete adapter
 * for the MVP. The runner launches the agent in the workspace cwd, runs a turn,
 * forwards events, and reports a normalized result. (FR-AG-1..7)
 */
export interface AgentRunner {
  run(
    request: AgentRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentResult>;
}
