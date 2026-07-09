/**
 * Retry queue + backoff unit tests (§8.4 / ARK-56).
 *
 * These exercise the pure {@link computeBackoffMs} formula and the {@link RetryQueue}
 * scheduler in isolation over an injected timer + clock and a plain entries map, so
 * timing is deterministic and no orchestrator or real timer is involved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeBackoffMs,
  DEFAULT_RETRY_BASE_MS,
  RetryQueue,
} from "../../src/orchestrator/retry.js";
import type { RetryEntry } from "../../src/domain/types.js";
import { captureLogger } from "./fakes.js";

interface Scheduled {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

/** A manual scheduler recording every armed timer for assertions. */
function manualScheduler() {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    setTimer: (fn: () => void, ms: number): Scheduled => {
      const entry: Scheduled = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimer: (handle: unknown) => {
      (handle as Scheduled).cancelled = true;
    },
  };
}

function buildQueue(
  overrides: { maxBackoffMs?: number; baseMs?: number; nowMs?: number } = {},
) {
  const entries = new Map<string, RetryEntry>();
  const sched = manualScheduler();
  const { logger, records } = captureLogger();
  const due: string[] = [];
  const queue = new RetryQueue({
    entries,
    maxBackoffMs: overrides.maxBackoffMs ?? 300000,
    baseMs: overrides.baseMs,
    onDue: (id) => due.push(id),
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    now: () => overrides.nowMs ?? 1_000_000,
    logger,
  });
  return { queue, entries, sched, records, due };
}

/* ------------------------------- backoff math ------------------------------- */

test("[§8.4] backoff doubles per attempt from the 1000ms base", () => {
  const cap = 300000;
  assert.equal(computeBackoffMs(1, cap), 1000, "attempt 1 → base");
  assert.equal(computeBackoffMs(2, cap), 2000);
  assert.equal(computeBackoffMs(3, cap), 4000);
  assert.equal(computeBackoffMs(4, cap), 8000);
  assert.equal(DEFAULT_RETRY_BASE_MS, 1000);
});

test("[§8.4] backoff is capped at agent.max_retry_backoff_ms", () => {
  const cap = 300000;
  // 1000 * 2^18 = 262_144_000, far above the cap → saturates.
  assert.equal(computeBackoffMs(19, cap), cap);
  // Exactly at/below the boundary is not clamped.
  assert.equal(computeBackoffMs(9, cap), 256000, "1000*2^8 is under the cap");
});

test("backoff clamps attempts below 1 to the base and never overflows to Infinity", () => {
  const cap = 300000;
  assert.equal(computeBackoffMs(0, cap), 1000, "attempt 0 clamps to 1");
  assert.equal(computeBackoffMs(-5, cap), 1000, "negative clamps to 1");
  assert.equal(computeBackoffMs(5000, cap), cap, "huge attempt saturates at the cap, not Infinity");
});

test("backoff honors a custom base (spec §8.4 example base 10000)", () => {
  const cap = 300000;
  assert.equal(computeBackoffMs(1, cap, 10000), 10000);
  assert.equal(computeBackoffMs(2, cap, 10000), 20000);
});

/* ------------------------------- queue: schedule ------------------------------- */

test("schedule records the entry (attempt/identifier/error/due_at) and arms a timer", () => {
  const { queue, entries, sched } = buildQueue({ nowMs: 1_000_000 });

  const entry = queue.schedule({ issueId: "id-1", identifier: "DEV-1", attempt: 2, error: "boom" });

  assert.equal(queue.size(), 1);
  assert.equal(entries.get("id-1"), entry);
  assert.equal(entry.attempt, 2);
  assert.equal(entry.identifier, "DEV-1");
  assert.equal(entry.error, "boom");
  assert.equal(entry.due_at_ms, 1_000_000 + 2000, "due_at = now + backoff(attempt 2)");
  assert.equal(sched.scheduled.length, 1, "one timer armed");
  assert.equal(sched.scheduled[0]!.ms, 2000, "armed with the backoff delay");
});

test("[AC4] re-scheduling cancels the prior timer — exactly one timer per issue", () => {
  const { queue, entries, sched } = buildQueue();

  queue.schedule({ issueId: "id-1", identifier: "DEV-1", attempt: 1, error: "e1" });
  queue.schedule({ issueId: "id-1", identifier: "DEV-1", attempt: 2, error: "e2" });

  assert.equal(sched.scheduled.length, 2, "two timers were created across the two calls");
  assert.equal(sched.scheduled[0]!.cancelled, true, "the first timer was cancelled");
  assert.equal(sched.scheduled[1]!.cancelled, false, "the second timer is live");
  assert.equal(queue.size(), 1, "still a single entry for the issue");
  assert.equal(entries.get("id-1")!.attempt, 2, "the entry reflects the latest schedule");
});

test("a matured timer fires onDue with the issue id", () => {
  const { queue, sched, due } = buildQueue();
  queue.schedule({ issueId: "id-1", identifier: "DEV-1", attempt: 1, error: null });

  sched.scheduled[0]!.fn(); // simulate the timer maturing

  assert.deepEqual(due, ["id-1"]);
});

/* ------------------------------- queue: cancel / take ------------------------------- */

test("cancel clears the timer and drops the entry; returns whether one existed", () => {
  const { queue, sched } = buildQueue();
  queue.schedule({ issueId: "id-1", identifier: "DEV-1", attempt: 1, error: null });

  assert.equal(queue.cancel("id-1"), true);
  assert.equal(sched.scheduled[0]!.cancelled, true, "timer cleared");
  assert.equal(queue.has("id-1"), false);
  assert.equal(queue.cancel("id-1"), false, "cancelling an absent issue is a no-op false");
});

test("cancelAll clears every scheduled retry", () => {
  const { queue, sched } = buildQueue();
  queue.schedule({ issueId: "a", identifier: "A", attempt: 1, error: null });
  queue.schedule({ issueId: "b", identifier: "B", attempt: 1, error: null });

  queue.cancelAll();

  assert.equal(queue.size(), 0);
  assert.ok(sched.scheduled.every((s) => s.cancelled), "all timers cleared");
});

test("take removes and returns the entry without clearing its (already-fired) timer", () => {
  const { queue, sched } = buildQueue();
  queue.schedule({ issueId: "id-1", identifier: "DEV-1", attempt: 3, error: "x" });

  const taken = queue.take("id-1");

  assert.equal(taken!.attempt, 3);
  assert.equal(queue.has("id-1"), false, "entry removed from the map");
  assert.equal(sched.scheduled[0]!.cancelled, false, "take does not clear the fired timer");
  assert.equal(queue.take("id-1"), undefined, "taking again yields undefined");
});

test("snapshot exposes the queued retries for status surfacing", () => {
  const { queue } = buildQueue();
  queue.schedule({ issueId: "a", identifier: "A", attempt: 1, error: null });
  queue.schedule({ issueId: "b", identifier: "B", attempt: 2, error: "e" });

  const snap = queue.snapshot();
  assert.deepEqual(
    snap.map((e) => [e.issue_id, e.attempt]),
    [["a", 1], ["b", 2]],
  );
});
