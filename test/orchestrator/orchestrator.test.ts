/**
 * Orchestrator behavior tests (§16.2/§16.3/§16.4 — FR6, FR7, FR9, FR17 + NFR).
 *
 * Every test drives the REAL orchestrator over in-memory port fakes with an
 * injected scheduler/clock, so timing is deterministic and no real Notion,
 * filesystem, or Claude Code is touched.
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

/** Flush pending microtasks + macrotasks so an injected-timer callback settles. */
function flush(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

interface Scheduled {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

/** A manual scheduler that records every scheduled tick for assertions. */
function manualScheduler() {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    setTimer: (fn: () => void, ms: number) => {
      const entry: Scheduled = { fn, ms, cancelled: false };
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
  });
  return { orchestrator, tracker, agentRunner, workspaceManager, records, status, sched, config };
}

/* ----------------------------- FR6: immediate first tick ----------------------------- */

test("[FR6] start() schedules the first tick immediately (delay 0), then at the poll interval", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue()];
  const h = build({ tracker });

  h.orchestrator.start();
  assert.equal(h.sched.scheduled.length, 1, "one tick scheduled at startup");
  assert.equal(h.sched.scheduled[0]!.ms, 0, "the first tick fires immediately");

  // Fire the immediate tick and let it settle.
  h.sched.scheduled[0]!.fn();
  await flush();
  await flush();

  assert.equal(h.tracker.calls.fetchCandidateIssues, 1, "the immediate tick polled the tracker");
  assert.equal(h.sched.scheduled.length, 2, "a follow-up tick was scheduled");
  assert.equal(h.sched.scheduled[1]!.ms, h.config.polling.interval_ms, "rescheduled at poll interval");

  await h.orchestrator.stop();
});

/* ----------------------------- FR7/FR8: dispatch order + cap ----------------------------- */

test("[FR7/FR8] a tick dispatches eligible candidates in priority order, up to the global cap", async () => {
  const config = testConfig({ agent: { ...testConfig().agent, max_concurrent_agents: 2 } });
  const tracker = new FakeTracker();
  // Deliberately out of order; only 2 slots so the lowest-priority C must NOT run.
  tracker.candidates = [
    issue({ id: "c", identifier: "DEV-C", priority: 3 }),
    issue({ id: "a", identifier: "DEV-A", priority: 1 }),
    issue({ id: "b", identifier: "DEV-B", priority: 2 }),
  ];
  const agent = new FakeAgentRunner();
  agent.mode = "manual"; // keep workers live so the cap is observable within the tick
  const h = build({ tracker, agent, config });

  await h.orchestrator.tick();

  assert.deepEqual(
    agent.runs.map((r) => r.issue.identifier),
    ["DEV-A", "DEV-B"],
    "highest-priority two dispatched, in order; the cap blocks the third",
  );
  assert.equal(h.orchestrator.runningCount(), 2);
});

/* ----------------------------- FR9: single-authority dispatch ----------------------------- */

test("[FR9] the same issue is never dispatched twice across concurrent ticks", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  // Keep it 'active' on reconciliation so it is never terminated between ticks.
  tracker.statesById.set("id-1", issue({ id: "id-1", identifier: "DEV-1", state: "In Progress" }));
  const agent = new FakeAgentRunner();
  agent.mode = "manual";
  const h = build({ tracker, agent });

  await Promise.all([h.orchestrator.tick(), h.orchestrator.tick(), h.orchestrator.tick()]);

  assert.equal(agent.runs.length, 1, "dispatched exactly once despite three overlapping ticks");
  assert.equal(h.orchestrator.runningCount(), 1);
  assert.equal(h.orchestrator.getState().claimed.has("id-1"), true);
});

test("[FR9] a claimed issue is not re-dispatched while its worker is live", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  tracker.statesById.set("id-1", issue({ id: "id-1", identifier: "DEV-1", state: "In Progress" }));
  const agent = new FakeAgentRunner();
  agent.mode = "manual";
  const h = build({ tracker, agent });

  await h.orchestrator.tick(); // dispatch
  await h.orchestrator.tick(); // sees it running -> no second dispatch

  assert.equal(agent.runs.length, 1);
});

/* ----------------------------- FR17: terminal reconciliation ----------------------------- */

test("[FR17] a running issue that reaches a terminal state is stopped and its workspace cleaned", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1", state: "Todo" })];
  const agent = new FakeAgentRunner();
  agent.mode = "manual"; // worker stays live so reconciliation is what stops it
  const workspace = new FakeWorkspaceManager();
  const h = build({ tracker, agent, workspace });

  await h.orchestrator.tick(); // dispatch DEV-1
  assert.equal(h.orchestrator.runningCount(), 1);

  // The issue reaches Done; it also drops out of the active candidate set.
  tracker.candidates = [];
  tracker.statesById.set("id-1", issue({ id: "id-1", identifier: "DEV-1", state: "Done" }));

  await h.orchestrator.reconcile();

  assert.equal(h.orchestrator.runningCount(), 0, "the run was stopped");
  assert.equal(h.orchestrator.getState().claimed.has("id-1"), false, "claim released");
  assert.deepEqual(workspace.removed, ["DEV-1"], "terminal reconciliation cleaned the workspace");
  assert.ok(
    h.records.some(
      (r) => r.context.action === "reconcile_terminate" && r.context.outcome === "terminal",
    ),
    "a terminal-reconciliation log line was emitted",
  );
});

test("reconcile keeps workers running when the state refresh fails", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner();
  agent.mode = "manual";
  const h = build({ tracker, agent });

  await h.orchestrator.tick();
  assert.equal(h.orchestrator.runningCount(), 1);

  tracker.failStates = new Error("notion refresh 503");
  await h.orchestrator.reconcile();

  assert.equal(h.orchestrator.runningCount(), 1, "worker kept on refresh failure");
});

test("reconcile stops a worker whose issue left both active and terminal, keeping the workspace", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agent = new FakeAgentRunner();
  agent.mode = "manual";
  const workspace = new FakeWorkspaceManager();
  const h = build({ tracker, agent, workspace });

  await h.orchestrator.tick();
  tracker.statesById.set("id-1", issue({ id: "id-1", identifier: "DEV-1", state: "Backlog" }));
  await h.orchestrator.reconcile();

  assert.equal(h.orchestrator.runningCount(), 0, "stopped");
  assert.deepEqual(workspace.removed, [], "workspace preserved for a non-terminal exit");
});

/* ----------------------------- NFR: tracker failure survival ----------------------------- */

test("[NFR] an induced tracker failure skips the tick and the daemon survives", async () => {
  const tracker = new FakeTracker();
  tracker.failCandidates = new Error("notion candidate fetch failed");
  const agent = new FakeAgentRunner();
  const h = build({ tracker, agent });

  await h.orchestrator.tick(); // must not throw

  assert.equal(agent.runs.length, 0, "nothing dispatched on a failed fetch");
  assert.equal(h.orchestrator.runningCount(), 0);
  assert.ok(
    h.records.some((r) => r.level === "warn" && r.context.action === "fetch_candidates"),
    "the skipped tick was logged",
  );

  // Recovery: the very next tick works, proving the daemon survived.
  tracker.failCandidates = null;
  tracker.candidates = [issue()];
  await h.orchestrator.tick();
  assert.equal(agent.runs.length, 1, "the daemon recovered and dispatched on the next tick");
});

test("a failed dispatch preflight skips dispatch but still reconciles", async () => {
  const config = testConfig({
    tracker: { ...testConfig().tracker, auth: null }, // preflight fails on missing auth
  });
  const tracker = new FakeTracker();
  tracker.candidates = [issue()];
  const agent = new FakeAgentRunner();
  const h = build({ tracker, agent, config });

  await h.orchestrator.tick();

  assert.equal(agent.runs.length, 0, "dispatch skipped on preflight failure");
  assert.equal(tracker.calls.fetchCandidateIssues, 0, "candidates not even fetched");
  assert.ok(h.records.some((r) => r.context.action === "preflight" && r.level === "error"));
});

/* ----------------------------- FR20: graceful shutdown ----------------------------- */

test("[FR20] stop() cancels the pending tick, drains workers, and is idempotent", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue()];
  const agent = new FakeAgentRunner(); // auto: worker resolves promptly
  const h = build({ tracker, agent });

  h.orchestrator.start();
  h.sched.scheduled[0]!.fn();
  await flush();
  await flush();

  await h.orchestrator.stop();
  const scheduledAfterStop = h.sched.scheduled.length;
  await h.orchestrator.stop(); // idempotent: no throw, no new scheduling

  assert.equal(h.sched.scheduled.length, scheduledAfterStop, "no ticks scheduled after stop");
  assert.ok(
    h.records.some((r) => r.context.action === "shutdown" && r.context.outcome === "clean"),
    "a clean-shutdown line was emitted",
  );
});
