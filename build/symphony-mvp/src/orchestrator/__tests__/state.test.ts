import { describe, expect, it } from "vitest";
import { createRuntimeState } from "../../domain/state.js";
import {
  availableSlots,
  incrementTurnCount,
  isClaimedOrRunning,
  markCompleted,
  noAvailableSlots,
  recordRunning,
  releaseRunning,
  runningCount,
  setSessionId,
  updateRunningState,
} from "../state.js";

function record(id: string, identifier: string) {
  return {
    issue_id: id,
    issue_identifier: identifier,
    attempt: null,
    workspace_path: `/ws/${identifier}`,
    started_at: "2026-06-02T12:00:00.000Z",
    last_state: "Todo",
  };
}

describe("orchestrator state — single-authority mutations", () => {
  it("computes global available slots = max(limit - running, 0)", () => {
    const state = createRuntimeState(30000, 2);
    expect(availableSlots(state)).toBe(2);
    expect(noAvailableSlots(state)).toBe(false);

    recordRunning(state, record("i1", "A-1"));
    expect(availableSlots(state)).toBe(1);
    recordRunning(state, record("i2", "A-2"));
    expect(availableSlots(state)).toBe(0);
    expect(noAvailableSlots(state)).toBe(true);
    expect(runningCount(state)).toBe(2);
  });

  it("recordRunning claims the issue and clears a prior retry entry", () => {
    const state = createRuntimeState(30000, 5);
    state.retry_attempts.set("i1", {
      issue_id: "i1",
      identifier: "A-1",
      attempt: 1,
      due_at_ms: 0,
      timer_handle: null,
      error: null,
    });
    const entry = recordRunning(state, record("i1", "A-1"));
    expect(entry.session_id).toBeNull();
    expect(entry.turn_count).toBe(0);
    expect(isClaimedOrRunning(state, "i1")).toBe(true);
    expect(state.claimed.has("i1")).toBe(true);
    expect(state.retry_attempts.has("i1")).toBe(false);
  });

  it("tracks session id, turn count, and state snapshot on the running entry", () => {
    const state = createRuntimeState(30000, 5);
    recordRunning(state, record("i1", "A-1"));

    setSessionId(state, "i1", "thread-1-1");
    incrementTurnCount(state, "i1");
    updateRunningState(state, "i1", "In Progress");

    const entry = state.running.get("i1");
    expect(entry?.session_id).toBe("thread-1-1");
    expect(entry?.turn_count).toBe(1);
    expect(entry?.last_state).toBe("In Progress");
  });

  it("releaseRunning removes the running entry and the claim", () => {
    const state = createRuntimeState(30000, 5);
    recordRunning(state, record("i1", "A-1"));
    const removed = releaseRunning(state, "i1");
    expect(removed?.issue_id).toBe("i1");
    expect(state.running.has("i1")).toBe(false);
    expect(state.claimed.has("i1")).toBe(false);
    expect(isClaimedOrRunning(state, "i1")).toBe(false);
  });

  it("markCompleted is bookkeeping-only and does not gate dispatch", () => {
    const state = createRuntimeState(30000, 5);
    markCompleted(state, "i1");
    expect(state.completed.has("i1")).toBe(true);
    // completed does NOT imply claimed/running.
    expect(isClaimedOrRunning(state, "i1")).toBe(false);
  });

  it("mutation helpers are no-ops for unknown ids", () => {
    const state = createRuntimeState(30000, 5);
    expect(() => setSessionId(state, "nope", "x")).not.toThrow();
    expect(() => incrementTurnCount(state, "nope")).not.toThrow();
    expect(() => updateRunningState(state, "nope", "Done")).not.toThrow();
    expect(releaseRunning(state, "nope")).toBeUndefined();
  });
});
