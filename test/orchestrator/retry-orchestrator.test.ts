/**
 * Retry integration tests (§8.4 / §16.6 / ARK-56).
 *
 * These drive the REAL orchestrator over in-memory fakes with an injected
 * scheduler, exercising the failure → schedule → due → {re-dispatch | requeue |
 * drop} path end to end. `tick()`/`reconcile()`/the retry timer are driven
 * explicitly so no real timer fires; the ONLY timers the shared scheduler records
 * here are retry timers (ticks are never scheduled because `start()` is not used).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrchestrator } from "../../src/orchestrator/orchestrator.js";
import { createStatusSurface } from "../../src/observability/status.js";
import {
  captureLogger,
  FakeAgentRunner,
  FakeTracker,
  FakeWorkspaceManager,
  issue,
  testConfig,
} from "./fakes.js";

/** Flush pending microtasks + macrotasks so a detached worker/timer callback settles. */
function flush(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

interface Scheduled {
  /** Fire the timer once (mirrors a real one-shot setTimeout maturing). */
  fire: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

function manualScheduler() {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    setTimer: (fn: () => void, ms: number): Scheduled => {
      const entry: Scheduled = {
        ms,
        cancelled: false,
        fired: false,
        fire: () => {
          entry.fired = true;
          fn();
        },
      };
      scheduled.push(entry);
      return entry;
    },
    clearTimer: (handle: unknown) => {
      (handle as Scheduled).cancelled = true;
    },
  };
}

function build(overrides: {
  tracker?: FakeTracker;
  agent?: FakeAgentRunner;
  workspace?: FakeWorkspaceManager;
  config?: ReturnType<typeof testConfig>;
} = {}) {
  const config = overrides.config ?? testConfig();
  const tracker = overrides.tracker ?? new FakeTracker();
  const agentRunner = overrides.agent ?? new FakeAgentRunner();
  const workspaceManager = overrides.workspace ?? new FakeWorkspaceManager();
  const { logger, records } = captureLogger();
  const status = createStatusSurface({ label: "test", stream: { write: () => true } });
  const sched = manualScheduler();
  const orchestrator = createOrchestrator({
    config,
    tracker,
    agentRunner,
    workspaceManager,
    logger,
    status,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    nowMs: () => 1_000_000,
  });
  return { orchestrator, tracker, agentRunner, workspaceManager, records, status, sched, config };
}

/** The single live (unfired, uncancelled) retry timer (ticks aren't scheduled here). */
function retryTimer(sched: ReturnType<typeof manualScheduler>): Scheduled {
  const live = sched.scheduled.filter((s) => !s.cancelled && !s.fired);
  assert.equal(live.length, 1, "exactly one live retry timer is expected");
  return live[0]!;
}

/* ------------------------- AC1: failed run schedules a backoff retry ------------------------- */

test("[AC1] a failed run schedules a retry (attempt 1, base delay) and keeps the claim", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner();
  agent.status = "failed"; // the attempt resolves failed
  const h = build({ tracker, agent });

  await h.orchestrator.tick(); // dispatch id-1
  await flush();
  await flush(); // let the detached worker resolve → onWorkerExit

  assert.equal(h.orchestrator.runningCount(), 0, "the failed worker left the running set");
  assert.equal(h.orchestrator.getState().claimed.has("id-1"), true, "claim kept — issue is RetryQueued");

  const entry = h.orchestrator.getState().retry_attempts.get("id-1");
  assert.ok(entry, "a retry entry was queued");
  assert.equal(entry!.attempt, 1, "first failure → attempt 1");
  assert.equal(retryTimer(h.sched).ms, 1000, "armed with the base backoff (1000ms)");

  assert.ok(
    h.records.some(
      (r) => r.context.action === "worker_exit" && r.context.outcome === "retry_scheduled",
    ),
    "a retry-scheduled log line was emitted",
  );
  // AC5: the retry is reflected on the status surface.
  assert.deepEqual(
    h.status.activeRuns().map((r) => [r.issue_identifier, r.phase]),
    [["DEV-1", "retrying"]],
  );
});

test("[AC1] an agent error (thrown) is treated as a failed run and scheduled for retry", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner();
  agent.throwError = new Error("agent crashed");
  const h = build({ tracker, agent });

  await h.orchestrator.tick();
  await flush();
  await flush();

  assert.ok(h.orchestrator.getState().retry_attempts.has("id-1"), "thrown error queued a retry");
  assert.ok(
    h.records.some((r) => r.context.action === "worker_exit" && r.context.outcome === "error"),
    "the worker error was logged",
  );
});

test("backoff grows across successive failures, capped at max_retry_backoff_ms", async () => {
  const config = testConfig({
    agent: { ...testConfig().agent, max_concurrent_agents: 1, max_retry_backoff_ms: 3000 },
  });
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner();
  agent.status = "failed";
  const h = build({ tracker, agent, config });

  await h.orchestrator.tick(); // attempt null → fails → retry attempt 1 (1000ms)
  await flush();
  await flush();
  assert.equal(retryTimer(h.sched).ms, 1000);

  retryTimer(h.sched).fire(); // re-dispatch attempt 1 → fails → retry attempt 2 (2000ms)
  await flush();
  await flush();
  assert.equal(h.orchestrator.getState().retry_attempts.get("id-1")!.attempt, 2);
  assert.equal(retryTimer(h.sched).ms, 2000);

  retryTimer(h.sched).fire(); // re-dispatch attempt 2 → fails → retry attempt 3 (4000ms → capped 3000)
  await flush();
  await flush();
  assert.equal(h.orchestrator.getState().retry_attempts.get("id-1")!.attempt, 3);
  assert.equal(retryTimer(h.sched).ms, 3000, "backoff capped at max_retry_backoff_ms");
});

/* ------------------------- AC2: due retry re-dispatches with incremented attempt ------------------------- */

test("[AC2] a due, still-eligible retry re-dispatches with the incremented attempt when a slot is free", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner();
  agent.status = "failed";
  const h = build({ tracker, agent });

  await h.orchestrator.tick(); // dispatch (attempt null) → fails → retry attempt 1
  await flush();
  await flush();
  assert.equal(agent.runs.length, 1);
  assert.equal(agent.runs[0]!.attempt, null, "first run used the null (first-run) attempt");

  // Keep the re-dispatched worker live so we can observe the running state.
  agent.mode = "manual";
  retryTimer(h.sched).fire(); // retry becomes due
  await flush();
  await flush();

  assert.equal(agent.runs.length, 2, "the due retry re-dispatched the issue");
  assert.equal(agent.runs[1]!.attempt, 1, "re-dispatched with the incremented attempt (1)");
  assert.equal(h.orchestrator.runningCount(), 1, "the re-dispatched worker is running");
  assert.equal(h.orchestrator.getState().retry_attempts.has("id-1"), false, "retry entry consumed");
  assert.deepEqual(
    h.status.activeRuns().map((r) => [r.issue_identifier, r.phase]),
    [["DEV-1", "running"]],
    "status flipped from retrying back to running",
  );
});

/* ------------------------- AC3: drop-on-terminal releases the claim ------------------------- */

test("[AC3] a due retry whose issue is missing/terminal is dropped and its claim released", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner();
  agent.status = "failed";
  const h = build({ tracker, agent });

  await h.orchestrator.tick(); // fails → retry queued, claim held
  await flush();
  await flush();
  assert.equal(h.orchestrator.getState().claimed.has("id-1"), true);

  // The issue reached a terminal state → it drops out of the active candidate set.
  tracker.candidates = [];
  retryTimer(h.sched).fire();
  await flush();
  await flush();

  assert.equal(h.orchestrator.getState().claimed.has("id-1"), false, "claim released");
  assert.equal(h.orchestrator.getState().retry_attempts.has("id-1"), false, "retry dropped");
  assert.equal(agent.runs.length, 1, "the terminal issue was NOT re-dispatched");
  assert.deepEqual(h.status.activeRuns(), [], "status cleared for the dropped issue");
  assert.ok(
    h.records.some((r) => r.context.action === "retry_drop" && r.context.outcome === "released"),
    "a retry-drop log line was emitted",
  );
});

/* ------------------------- §8.4 step 4b: no free slot requeues at attempt+1 ------------------------- */

test("[§8.4] a due retry with no free slot requeues at attempt+1 without re-dispatching", async () => {
  const config = testConfig({ agent: { ...testConfig().agent, max_concurrent_agents: 1 } });
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner();
  agent.status = "failed";
  const h = build({ tracker, agent, config });

  await h.orchestrator.tick(); // id-1 fails → retry attempt 1
  await flush();
  await flush();

  // Occupy the single slot with a different, long-running issue.
  agent.status = "succeeded";
  agent.mode = "manual";
  tracker.candidates = [
    issue({ id: "id-1", identifier: "DEV-1" }),
    issue({ id: "id-2", identifier: "DEV-2" }),
  ];
  await h.orchestrator.tick(); // dispatches id-2 (id-1 is claimed → skipped)
  await flush();
  assert.equal(h.orchestrator.runningCount(), 1, "the only slot is taken by id-2");

  const before = agent.runs.length;
  retryTimer(h.sched).fire(); // id-1 retry due, but no slot
  await flush();
  await flush();

  assert.equal(agent.runs.length, before, "id-1 was NOT re-dispatched — no slot");
  const entry = h.orchestrator.getState().retry_attempts.get("id-1");
  assert.ok(entry, "id-1 was requeued");
  assert.equal(entry!.attempt, 2, "requeued at attempt + 1");
  assert.equal(entry!.error, "no available orchestrator slots");
  assert.ok(
    h.records.some((r) => r.context.action === "retry_due" && String(r.message).includes("no available slots")),
    "a no-slots requeue was logged",
  );
});

/* ------------------------- clean exit does NOT schedule a retry ------------------------- */

test("a clean (succeeded) exit releases the claim and schedules no retry", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner(); // default status "succeeded"
  const h = build({ tracker, agent });

  await h.orchestrator.tick();
  await flush();
  await flush();

  assert.equal(h.orchestrator.getState().retry_attempts.has("id-1"), false, "no retry on a clean exit");
  assert.equal(h.orchestrator.getState().claimed.has("id-1"), false, "claim released on a clean exit");
  assert.equal(h.orchestrator.getState().completed.has("id-1"), true, "completion recorded");
});

/* ------------------------- shutdown cancels retry timers ------------------------- */

test("stop() cancels any pending retry timer so none fires after shutdown", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner();
  agent.status = "failed";
  const h = build({ tracker, agent });

  await h.orchestrator.tick();
  await flush();
  await flush();
  const timer = retryTimer(h.sched);

  await h.orchestrator.stop();

  assert.equal(timer.cancelled, true, "the pending retry timer was cancelled at shutdown");
  assert.equal(h.orchestrator.getState().retry_attempts.size, 0, "retry queue drained on stop");
});
