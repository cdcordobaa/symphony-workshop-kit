/**
 * Eligibility, sort, and concurrency unit tests (§8.2, §8.3 / FR7, FR8).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeState } from "../../src/domain/types.js";
import { evaluateEligibility, shouldDispatch } from "../../src/orchestrator/eligibility.js";
import { sortForDispatch } from "../../src/orchestrator/sort.js";
import { availableSlots, noAvailableSlots } from "../../src/orchestrator/concurrency.js";
import { issue, testConfig } from "./fakes.js";

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
