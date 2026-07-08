/**
 * Orchestrator layer (Symphony spec §7, §8, §16 — Unit 1.7 / ARK-55).
 *
 * The integrating spine: a single fixed-interval poll loop with eligibility,
 * dispatch sorting, single-authority in-memory state, and terminal-state
 * reconciliation. It depends only on the §4 domain ports (tracker, workspace,
 * agent, observability) so any conforming implementation can be wired in.
 */

export { Orchestrator, createOrchestrator } from "./orchestrator.js";
export type { OrchestratorDeps, TimerHandle } from "./orchestrator.js";
export { sortForDispatch } from "./sort.js";
export { availableSlots, noAvailableSlots } from "./concurrency.js";
export {
  shouldDispatch,
  evaluateEligibility,
  type EligibilityResult,
  type IneligibleReason,
} from "./eligibility.js";
export { stateIn, stateSet } from "./state-sets.js";
