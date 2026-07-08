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
