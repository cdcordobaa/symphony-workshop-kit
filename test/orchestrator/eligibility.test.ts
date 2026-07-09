/**
 * Eligibility, sort, and concurrency unit tests (§8.2, §8.3 / FR7, FR8).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeState } from "../../src/domain/types.js";
import type { OrchestratorRuntimeState, RunningEntry } from "../../src/domain/types.js";
import { evaluateEligibility, shouldDispatch } from "../../src/orchestrator/eligibility.js";
import { sortForDispatch } from "../../src/orchestrator/sort.js";
import {
  availableSlots,
  effectiveAvailableSlots,
  noAvailableSlots,
  perStateAvailableSlots,
  runningCountByState,
} from "../../src/orchestrator/concurrency.js";
import { issue, testConfig } from "./fakes.js";

/** Register a running entry in state `S` under `id` (per-state accounting fixture). */
function markRunning(state: OrchestratorRuntimeState, id: string, issueState: string): void {
  const entry: RunningEntry = {
    issue_id: id,
    issue_identifier: id.toUpperCase(),
    attempt: null,
    state: issueState,
    workspace_path: `/tmp/${id}`,
    started_at: "2026-01-01T00:00:00.000Z",
    session: null,
  };
  state.running.set(id, entry);
}

/* ------------------------------- sort (FR8) ------------------------------- */

test("sortForDispatch: priority ascending, null priority sorts last", () => {
  const out = sortForDispatch([
    issue({ id: "a", identifier: "A", priority: null, created_at: "2026-01-01T00:00:00Z" }),
    issue({ id: "b", identifier: "B", priority: 3, created_at: "2026-01-01T00:00:00Z" }),
    issue({ id: "c", identifier: "C", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
  ]);
  assert.deepEqual(out.map((i) => i.identifier), ["C", "B", "A"]);
});

test("sortForDispatch: equal priority breaks ties by created_at oldest-first", () => {
  const out = sortForDispatch([
    issue({ id: "new", identifier: "NEW", priority: 2, created_at: "2026-05-01T00:00:00Z" }),
    issue({ id: "old", identifier: "OLD", priority: 2, created_at: "2026-01-01T00:00:00Z" }),
  ]);
  assert.deepEqual(out.map((i) => i.identifier), ["OLD", "NEW"]);
});

test("sortForDispatch: identifier is the final deterministic tie-breaker", () => {
  const out = sortForDispatch([
    issue({ id: "2", identifier: "DEV-2", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
    issue({ id: "1", identifier: "DEV-1", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
  ]);
  assert.deepEqual(out.map((i) => i.identifier), ["DEV-1", "DEV-2"]);
});

test("sortForDispatch: does not mutate the input array", () => {
  const input = [issue({ priority: 3 }), issue({ id: "x", identifier: "X", priority: 1 })];
  const snapshot = input.map((i) => i.identifier);
  sortForDispatch(input);
  assert.deepEqual(input.map((i) => i.identifier), snapshot);
});

/* --------------------------- concurrency (FR7) ---------------------------- */

test("availableSlots respects the global cap and never goes negative", () => {
  const config = testConfig({
    agent: { ...testConfig().agent, max_concurrent_agents: 2 },
  });
  const state = createRuntimeState(config);
  assert.equal(availableSlots(state), 2);
  state.running.set("a", {} as never);
  assert.equal(availableSlots(state), 1);
  state.running.set("b", {} as never);
  state.running.set("c", {} as never); // over cap
  assert.equal(availableSlots(state), 0);
  assert.equal(noAvailableSlots(state), true);
});

/* --------------------------- eligibility (§8.2) --------------------------- */

function freshState(config = testConfig()) {
  return createRuntimeState(config);
}

test("eligibility: an active, unclaimed, unblocked issue under the cap is dispatchable", () => {
  const config = testConfig();
  assert.equal(shouldDispatch(issue(), freshState(config), config), true);
});

test("eligibility: a terminal-state issue is never dispatchable", () => {
  const config = testConfig();
  const res = evaluateEligibility(issue({ state: "Done" }), freshState(config), config);
  assert.equal(res.eligible, false);
  assert.equal(res.reason, "terminal");
});

test("eligibility: a non-active (unknown) state is rejected", () => {
  const config = testConfig();
  const res = evaluateEligibility(issue({ state: "Triage" }), freshState(config), config);
  assert.equal(res.eligible, false);
  assert.equal(res.reason, "not_active");
});

test("eligibility: an already-running issue is rejected (single authority precondition)", () => {
  const config = testConfig();
  const state = freshState(config);
  state.running.set("id-1", {} as never);
  const res = evaluateEligibility(issue({ id: "id-1" }), state, config);
  assert.equal(res.reason, "already_running");
});

test("eligibility: a claimed (but not yet running) issue is rejected", () => {
  const config = testConfig();
  const state = freshState(config);
  state.claimed.add("id-1");
  const res = evaluateEligibility(issue({ id: "id-1" }), state, config);
  assert.equal(res.reason, "already_claimed");
});

test("eligibility: no global slots -> rejected", () => {
  const config = testConfig({ agent: { ...testConfig().agent, max_concurrent_agents: 1 } });
  const state = freshState(config);
  state.running.set("other", {} as never);
  const res = evaluateEligibility(issue(), state, config);
  assert.equal(res.reason, "no_slots");
});

test("eligibility: missing a required field -> rejected", () => {
  const config = testConfig();
  const res = evaluateEligibility(issue({ title: "  " }), freshState(config), config);
  assert.equal(res.reason, "missing_required_field");
});

test("eligibility: a Todo blocked by a non-terminal blocker is held back (§8.2 blocker rule)", () => {
  const config = testConfig();
  const blocked = issue({
    state: "Todo",
    blocked_by: [{ id: "b", identifier: "DEV-9", state: "In Progress" }],
  });
  const res = evaluateEligibility(blocked, freshState(config), config);
  assert.equal(res.reason, "blocked");
});

test("eligibility: a Todo whose blockers are all terminal is dispatchable", () => {
  const config = testConfig();
  const ok = issue({
    state: "Todo",
    blocked_by: [{ id: "b", identifier: "DEV-9", state: "Done" }],
  });
  assert.equal(shouldDispatch(ok, freshState(config), config), true);
});

test("eligibility: the blocker rule does not apply to non-Todo active states", () => {
  const config = testConfig();
  const inProgress = issue({
    state: "In Progress",
    blocked_by: [{ id: "b", identifier: "DEV-9", state: "In Progress" }],
  });
  assert.equal(shouldDispatch(inProgress, freshState(config), config), true);
});

/* --------------------- per-state concurrency (§8.3) ----------------------- */

/** A config with a generous global cap and the given per-state overrides. */
function perStateConfig(byState: Record<string, number>, global = 10) {
  const base = testConfig();
  return testConfig({
    agent: { ...base.agent, max_concurrent_agents: global, max_concurrent_agents_by_state: byState },
  });
}

test("runningCountByState: counts running entries by normalized state", () => {
  const state = createRuntimeState(perStateConfig({}));
  markRunning(state, "a", "In Progress");
  markRunning(state, "b", "in progress"); // different casing → same bucket
  markRunning(state, "c", "Todo");
  const counts = runningCountByState(state);
  assert.equal(counts.get("in progress"), 2);
  assert.equal(counts.get("todo"), 1);
});

test("perStateAvailableSlots: no configured cap → Infinity (global-only fallback)", () => {
  const config = perStateConfig({ "in progress": 1 });
  const state = createRuntimeState(config);
  // "Todo" has no per-state cap: bounded only by the global cap.
  assert.equal(perStateAvailableSlots(state, config, "Todo"), Number.POSITIVE_INFINITY);
});

test("perStateAvailableSlots: cap minus running, case-insensitive, never negative", () => {
  const config = perStateConfig({ "in progress": 2 });
  const state = createRuntimeState(config);
  assert.equal(perStateAvailableSlots(state, config, "In Progress"), 2);
  markRunning(state, "a", "In Progress");
  assert.equal(perStateAvailableSlots(state, config, "In Progress"), 1);
  markRunning(state, "b", "In Progress");
  markRunning(state, "c", "In Progress"); // over the per-state cap
  assert.equal(perStateAvailableSlots(state, config, "In Progress"), 0);
});

test("effectiveAvailableSlots is min(global, per-state)", () => {
  // Per-state is the tighter bound.
  const cfgPerStateTight = perStateConfig({ "in progress": 1 }, 10);
  const s1 = createRuntimeState(cfgPerStateTight);
  assert.equal(effectiveAvailableSlots(s1, cfgPerStateTight, "In Progress"), 1);

  // Global is the tighter bound.
  const cfgGlobalTight = perStateConfig({ "in progress": 5 }, 2);
  const s2 = createRuntimeState(cfgGlobalTight);
  assert.equal(effectiveAvailableSlots(s2, cfgGlobalTight, "In Progress"), 2);

  // No per-state cap → equals global availability.
  const s3 = createRuntimeState(cfgGlobalTight);
  assert.equal(effectiveAvailableSlots(s3, cfgGlobalTight, "Todo"), 2);
});

test("eligibility: per-state cap blocks a 2nd same-state issue while global has room [§8.3 AC1]", () => {
  const config = perStateConfig({ "in progress": 1 }, 10);
  const state = createRuntimeState(config);
  markRunning(state, "running-ip", "In Progress"); // one In-Progress agent live
  const second = issue({ id: "second", identifier: "DEV-2", state: "In Progress" });
  const res = evaluateEligibility(second, state, config);
  assert.equal(res.eligible, false);
  assert.equal(res.reason, "no_state_slots");
  // Global still has 9 free slots — the block is purely the per-state cap.
  assert.equal(availableSlots(state), 9);
});

test("eligibility: per-state cap is independent across states [§8.3]", () => {
  const config = perStateConfig({ "in progress": 1 }, 10);
  const state = createRuntimeState(config);
  markRunning(state, "running-ip", "In Progress"); // saturates the In-Progress cap
  // A Todo candidate has no per-state cap and is unaffected by the In-Progress saturation.
  const todo = issue({ id: "t", identifier: "DEV-3", state: "Todo" });
  assert.equal(shouldDispatch(todo, state, config), true);
});

test("eligibility: a state with no configured cap falls back to the global cap only [§8.3 AC2]", () => {
  const config = perStateConfig({ "in progress": 1 }, 3);
  const state = createRuntimeState(config);
  markRunning(state, "a", "Todo");
  markRunning(state, "b", "Todo"); // two Todo agents; no per-state Todo cap
  const todo = issue({ id: "c", identifier: "DEV-9", state: "Todo" });
  // Still one global slot free (3 - 2), and no per-state Todo cap → dispatchable.
  assert.equal(shouldDispatch(todo, state, config), true);
  markRunning(state, "c", "Todo"); // now global is saturated
  const fourth = issue({ id: "d", identifier: "DEV-10", state: "Todo" });
  const res = evaluateEligibility(fourth, state, config);
  assert.equal(res.eligible, false);
  assert.equal(res.reason, "no_slots"); // bounded by global, not per-state
});

test("eligibility: global cap wins when it is the tighter bound (min interaction) [§8.3 AC3]", () => {
  // Per-state cap (5) is loose; the global cap (1) is what blocks.
  const config = perStateConfig({ "in progress": 5 }, 1);
  const state = createRuntimeState(config);
  markRunning(state, "a", "In Progress");
  const res = evaluateEligibility(
    issue({ id: "b", identifier: "DEV-2", state: "In Progress" }),
    state,
    config,
  );
  assert.equal(res.eligible, false);
  assert.equal(res.reason, "no_slots"); // global checked first; effective avail = min(0, 4) = 0
});

test("eligibility: within the per-state cap, a same-state issue is dispatchable [§8.3]", () => {
  const config = perStateConfig({ "in progress": 2 }, 10);
  const state = createRuntimeState(config);
  markRunning(state, "a", "In Progress"); // 1 of 2 In-Progress slots used
  const second = issue({ id: "b", identifier: "DEV-2", state: "In Progress" });
  assert.equal(shouldDispatch(second, state, config), true);
});
