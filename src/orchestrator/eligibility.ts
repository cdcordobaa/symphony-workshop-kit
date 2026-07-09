/**
 * Dispatch eligibility (Symphony spec §8.2 "Candidate Selection Rules").
 *
 * `shouldDispatch` is a pure predicate over one issue + the current in-memory
 * state + config. It answers FR7 (only active, not-running, under the cap) and
 * FR9's precondition (never re-dispatch a claimed issue). The tick loop
 * (§16.2) additionally guards the global slot count before each call; we also
 * check it here so the predicate is correct in isolation.
 *
 * Concurrency is enforced as two caps (§8.3): the global cap, then the per-state
 * cap for the issue's tracked state — effective availability is the `min` of the
 * two. Stall handling remains deferred (PRD §5.3).
 */

import type { Issue, OrchestratorRuntimeState, ServiceConfig } from "../domain/types.js";
import { noAvailableSlots, noPerStateSlots } from "./concurrency.js";
import { stateIn } from "./state-sets.js";

/** Reason a candidate was rejected (surfaced to debug logs; not a control path). */
export type IneligibleReason =
  | "missing_required_field"
  | "not_active"
  | "terminal"
  | "already_running"
  | "already_claimed"
  | "no_slots"
  | "no_state_slots"
  | "blocked";

export interface EligibilityResult {
  eligible: boolean;
  reason?: IneligibleReason;
}

/** True when a candidate has the four fields §8.2 requires (`id`, `identifier`, `title`, `state`). */
function hasRequiredFields(issue: Issue): boolean {
  return (
    issue.id.trim().length > 0 &&
    issue.identifier.trim().length > 0 &&
    issue.title.trim().length > 0 &&
    issue.state.trim().length > 0
  );
}

/**
 * The §8.2 blocker rule, scoped to `Todo` (the walking-skeleton entry state):
 * when the issue is in `Todo`, it is not dispatchable while ANY blocker is
 * non-terminal. A blocker whose state is unknown (`null`) is treated as
 * non-terminal — we cannot confirm it is done, so we hold back (fail-safe).
 */
function blockedByNonTerminal(issue: Issue, config: ServiceConfig): boolean {
  if (issue.state.trim().toLowerCase() !== "todo") return false;
  return issue.blocked_by.some((b) => !stateIn(b.state, config.tracker.terminal_states));
}

/**
 * Evaluate every §8.2 rule and report the first failure. Rules are checked in a
 * deterministic order so debug output is stable.
 */
export function evaluateEligibility(
  issue: Issue,
  state: OrchestratorRuntimeState,
  config: ServiceConfig,
): EligibilityResult {
  if (!hasRequiredFields(issue)) return { eligible: false, reason: "missing_required_field" };
  if (stateIn(issue.state, config.tracker.terminal_states)) return { eligible: false, reason: "terminal" };
  if (!stateIn(issue.state, config.tracker.active_states)) return { eligible: false, reason: "not_active" };
  if (state.running.has(issue.id)) return { eligible: false, reason: "already_running" };
  if (state.claimed.has(issue.id)) return { eligible: false, reason: "already_claimed" };
  if (noAvailableSlots(state)) return { eligible: false, reason: "no_slots" };
  if (noPerStateSlots(state, config, issue.state)) return { eligible: false, reason: "no_state_slots" };
  if (blockedByNonTerminal(issue, config)) return { eligible: false, reason: "blocked" };
  return { eligible: true };
}

/** Boolean convenience over {@link evaluateEligibility} (§16.2 `should_dispatch`). */
export function shouldDispatch(
  issue: Issue,
  state: OrchestratorRuntimeState,
  config: ServiceConfig,
): boolean {
  return evaluateEligibility(issue, state, config).eligible;
}
