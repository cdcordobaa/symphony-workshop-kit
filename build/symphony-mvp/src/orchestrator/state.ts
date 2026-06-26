/**
 * Orchestrator runtime-state model + single-authority mutations (U3;
 * SYMPHONY-SPEC §7, §8.3, §16.4; FR-DM-3, FR-OR-1, FR-OR-5, NFR-CONCURRENCY).
 *
 * The orchestrator is the ONLY component permitted to mutate scheduling state
 * (`running`, `claimed`, `completed`). Every mutation in the poll loop flows
 * through the small set of functions in this module so that there is exactly one
 * authority and no duplicate dispatch of the same issue (§7.4, §16.4).
 *
 * The shared `OrchestratorRuntimeState` shape and `createRuntimeState()` live in
 * U1's `domain/state.ts`; this module re-exports them and adds the MVP mutation
 * helpers. The walking skeleton uses global concurrency only — per-state caps,
 * the retry queue, and token totals are deferred (present in the type so they
 * slot in without rework).
 */

import type {
  OrchestratorRuntimeState,
  RunningEntry,
} from "../domain/state.js";
import { createRuntimeState } from "../domain/state.js";

export { createRuntimeState };
export type { OrchestratorRuntimeState, RunningEntry };

/** Number of workers currently running (issues tracked in `running`). */
export function runningCount(state: OrchestratorRuntimeState): number {
  return state.running.size;
}

/**
 * Global available dispatch slots: `max(max_concurrent_agents - running, 0)`
 * (§8.3 / FR-OR-5 global). The MVP uses the global limit only.
 */
export function availableSlots(state: OrchestratorRuntimeState): number {
  return Math.max(state.max_concurrent_agents - state.running.size, 0);
}

/** True when no global dispatch slot is free this tick (§16.2 break guard). */
export function noAvailableSlots(state: OrchestratorRuntimeState): boolean {
  return availableSlots(state) <= 0;
}

/** True when the issue is already running OR claimed (dispatch guard, §8.2). */
export function isClaimedOrRunning(
  state: OrchestratorRuntimeState,
  issueId: string,
): boolean {
  return state.running.has(issueId) || state.claimed.has(issueId);
}

/** Inputs needed to record a freshly-dispatched worker (§16.4). */
export interface RecordRunningInput {
  issue_id: string;
  issue_identifier: string;
  /** null for first run, >=1 for retries/continuation (MVP: null). */
  attempt: number | null;
  workspace_path: string;
  /** ISO-8601 timestamp the worker started. */
  started_at: string;
  /** Initial known tracker state for this issue (snapshot for reconcile). */
  last_state: string | null;
}

/**
 * Record a running worker and CLAIM the issue (§16.4). This is the single
 * authoritative dispatch mutation: it adds the `running` entry, marks the issue
 * `claimed`, and clears any prior retry entry. Callers MUST have already
 * confirmed eligibility (slot free + not claimed/running).
 */
export function recordRunning(
  state: OrchestratorRuntimeState,
  input: RecordRunningInput,
): RunningEntry {
  const entry: RunningEntry = {
    issue_id: input.issue_id,
    issue_identifier: input.issue_identifier,
    attempt: input.attempt,
    workspace_path: input.workspace_path,
    started_at: input.started_at,
    session_id: null,
    turn_count: 0,
    last_state: input.last_state,
  };
  state.running.set(input.issue_id, entry);
  state.claimed.add(input.issue_id);
  state.retry_attempts.delete(input.issue_id);
  return entry;
}

/**
 * Update the latest known session id for a running worker (from a
 * `session_started` event). No-op if the issue is no longer running.
 */
export function setSessionId(
  state: OrchestratorRuntimeState,
  issueId: string,
  sessionId: string | null,
): void {
  const entry = state.running.get(issueId);
  if (!entry) return;
  entry.session_id = sessionId;
}

/** Bump the per-worker turn counter (from a `turn_completed` event). */
export function incrementTurnCount(
  state: OrchestratorRuntimeState,
  issueId: string,
): void {
  const entry = state.running.get(issueId);
  if (!entry) return;
  entry.turn_count += 1;
}

/**
 * Update the in-memory tracker-state snapshot for a still-active running issue
 * during reconciliation (§8.5 Part B / §16.3). No-op if not running.
 */
export function updateRunningState(
  state: OrchestratorRuntimeState,
  issueId: string,
  trackerState: string,
): void {
  const entry = state.running.get(issueId);
  if (!entry) return;
  entry.last_state = trackerState;
}

/**
 * Release a claim and remove the running entry for an issue (§16.6 worker exit;
 * §16.3 reconciliation terminate). Returns the removed entry (or undefined).
 * The MVP simply lets the issue be re-picked on the next poll (no retry timer),
 * so releasing the claim fully un-reserves it.
 */
export function releaseRunning(
  state: OrchestratorRuntimeState,
  issueId: string,
): RunningEntry | undefined {
  const entry = state.running.get(issueId);
  state.running.delete(issueId);
  state.claimed.delete(issueId);
  return entry;
}

/**
 * Mark an issue completed for bookkeeping only (§16.6). This NEVER gates future
 * dispatch — the orchestrator re-evaluates eligibility against the live tracker
 * state each tick.
 */
export function markCompleted(
  state: OrchestratorRuntimeState,
  issueId: string,
): void {
  state.completed.add(issueId);
}
