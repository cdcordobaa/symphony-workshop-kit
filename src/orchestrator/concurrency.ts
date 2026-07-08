/**
 * Concurrency accounting (Symphony spec §8.3).
 *
 * This unit implements the GLOBAL cap only (`agent.max_concurrent_agents`).
 * Per-state caps (`max_concurrent_agents_by_state`) and stall detection are
 * explicitly deferred (PRD §5.3) and intentionally not consulted here.
 */

import type { OrchestratorRuntimeState } from "../domain/types.js";

/** `available_slots = max(max_concurrent_agents - running_count, 0)` (§8.3). */
export function availableSlots(state: OrchestratorRuntimeState): number {
  return Math.max(state.max_concurrent_agents - state.running.size, 0);
}

/** True when there is no global slot for another worker this tick (§16.2 `no_available_slots`). */
export function noAvailableSlots(state: OrchestratorRuntimeState): boolean {
  return availableSlots(state) <= 0;
}
