/**
 * Concurrency accounting (Symphony spec §8.3).
 *
 * Two caps are enforced together:
 *   - the GLOBAL cap `agent.max_concurrent_agents` (`available_slots` below), and
 *   - optional PER-STATE caps `agent.max_concurrent_agents_by_state[state]`, which
 *     bound how many agents may run for issues in a given tracked state so one
 *     state cannot starve others.
 *
 * A candidate in state `S` is dispatchable only when BOTH caps have a free slot:
 * `effective_available = min(global_available, per_state_available[S])`. A state
 * with no configured cap falls back to the global cap only (its per-state
 * availability is `Infinity`, so the `min` collapses to the global value).
 *
 * Per-state counts are taken over the `running` map by each entry's tracked state
 * (§8.3: "The runtime counts issues by their current tracked state"), recorded at
 * dispatch time on {@link import("../domain/types.js").RunningEntry.state}. Keys
 * are normalized (trimmed + lowercased) to match config, which lowercases its
 * per-state map keys. Stall detection remains deferred (PRD §5.3).
 */

import type { OrchestratorRuntimeState, ServiceConfig } from "../domain/types.js";

/** Normalize a tracker state name for case-insensitive map keys (mirrors §4.1.1). */
function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

/** `available_slots = max(max_concurrent_agents - running_count, 0)` (§8.3). */
export function availableSlots(state: OrchestratorRuntimeState): number {
  return Math.max(state.max_concurrent_agents - state.running.size, 0);
}

/** True when there is no global slot for another worker this tick (§16.2 `no_available_slots`). */
export function noAvailableSlots(state: OrchestratorRuntimeState): boolean {
  return availableSlots(state) <= 0;
}

/**
 * Count running entries grouped by their normalized tracked state (§8.3). The
 * returned map keys are lowercased so lookups line up with the config's
 * per-state cap keys.
 */
export function runningCountByState(state: OrchestratorRuntimeState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of state.running.values()) {
    const key = normalizeState(entry.state);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Per-state available slots for an issue in `stateName` (§8.3). When no per-state
 * cap is configured for the (normalized) state, the state is bounded only by the
 * global cap; that is represented as `Infinity` so `min(global, per_state)`
 * collapses to the global availability. Never returns a negative number.
 */
export function perStateAvailableSlots(
  state: OrchestratorRuntimeState,
  config: ServiceConfig,
  stateName: string,
): number {
  const key = normalizeState(stateName);
  const cap = config.agent.max_concurrent_agents_by_state[key];
  if (cap === undefined) return Number.POSITIVE_INFINITY;
  const running = runningCountByState(state).get(key) ?? 0;
  return Math.max(cap - running, 0);
}

/**
 * Effective availability for an issue in `stateName`: `min(global, per-state)`
 * (§8.3). The runtime never dispatches beyond either cap.
 */
export function effectiveAvailableSlots(
  state: OrchestratorRuntimeState,
  config: ServiceConfig,
  stateName: string,
): number {
  return Math.min(availableSlots(state), perStateAvailableSlots(state, config, stateName));
}

/** True when the per-state cap for `stateName` has no free slot this tick (§8.3). */
export function noPerStateSlots(
  state: OrchestratorRuntimeState,
  config: ServiceConfig,
  stateName: string,
): boolean {
  return perStateAvailableSlots(state, config, stateName) <= 0;
}
