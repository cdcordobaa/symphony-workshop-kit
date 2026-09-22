/**
 * Dynamic `WORKFLOW.md` watch/reload tests (§6.2, §8.1 / DEV-5).
 *
 * Every test drives the REAL {@link ConfigWatcher} + {@link Orchestrator} over an
 * **injected watch seam**: the fake `watch` captures the `onChange` callback and
 * the test fires it after rewriting the file. Nothing sleeps on a real `fs.watch`
 * event, so the whole suite is deterministic.
 *
 * The contract under test:
 *   - a good edit is re-parsed/re-resolved and its `polling.interval_ms` +
 *     `agent.max_concurrent_agents` reach the running loop without a restart;
 *   - a malformed or invalid edit is REJECTED: nothing throws, the previous good
 *     config stays in force, and an operator-visible error is logged;
 *   - `tracker.auth` is never written into a log line (FR21);
 *   - in-flight runs are not disturbed — only subsequent scheduling changes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { createConfigWatcher, reloadWorkflow, type WorkflowWatch } from "../../src/config/watcher.js";
import { resolveConfig } from "../../src/config/config.js";
import { loadWorkflowFile } from "../../src/config/loader.js";
import { createOrchestrator } from "../../src/orchestrator/orchestrator.js";
import { createStatusSurface } from "../../src/observability/status.js";
import { runCli } from "../../src/cli.js";
import type { HostIo } from "../../src/index.js";
import { writeWorkflow } from "../helpers.js";
import {
  captureLogger,
  FakeAgentRunner,
  FakeTracker,
  FakeWorkspaceManager,
  issue,
  testConfig,
} from "./fakes.js";

/* ------------------------------- fixtures -------------------------------- */

const AUTH_TOKEN = "ntn_super_secret_token_value";

/** A valid workflow with tunable poll interval / concurrency. */
function workflowText(
  opts: { intervalMs?: number; maxAgents?: number; auth?: string; body?: string } = {},
): string {
  return [
    "---",
    "tracker:",
    "  kind: notion",
    `  auth: ${opts.auth ?? AUTH_TOKEN}`,
    "  database_id: db-1",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Cancelled]",
    "polling:",
    `  interval_ms: ${opts.intervalMs ?? 30000}`,
    "agent:",
    "  command: claude",
    `  max_concurrent_agents: ${opts.maxAgents ?? 2}`,
    "---",
    opts.body ?? "Prompt for {{ issue.identifier }}.",
  ].join("\n");
}

/** Front matter that is not valid YAML at all — the "malformed edit" case. */
const MALFORMED = ["---", "tracker:", "  kind: notion", "   auth: [unclosed", "---", "Body."].join("\n");

/**
 * The injected watch seam. `fire()` invokes the subscribed `onChange` exactly the
 * way a filesystem event would, with no timers involved.
 */
function fakeWatch(): WorkflowWatch & { fire: () => void; closed: () => number; watched: () => string } {
  let handler: (() => void) | null = null;
  let closeCount = 0;
  let watchedPath = "";
  const watch = ((path: string, onChange: () => void) => {
    watchedPath = path;
    handler = onChange;
    return {
      close: () => {
        closeCount += 1;
        handler = null;
      },
    };
  }) as WorkflowWatch & { fire: () => void; closed: () => number; watched: () => string };
  watch.fire = () => {
    assert.ok(handler !== null, "watch seam has no subscriber (start() was not called?)");
    handler();
  };
  watch.closed = () => closeCount;
  watch.watched = () => watchedPath;
  return watch;
}

interface Scheduled {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

/** A manual scheduler recording every scheduled tick (mirrors orchestrator.test.ts). */
function manualScheduler() {
  const scheduled: Scheduled[] = [];
  const live = (): Scheduled[] => scheduled.filter((s) => !s.cancelled && !s.fired);
  return {
    scheduled,
    /** Timers still armed (neither cancelled nor already fired), in scheduling order. */
    live,
    /** Fire the newest armed timer, the way the event loop would. */
    fireLatest: (): void => {
      const entry = live().at(-1);
      assert.ok(entry !== undefined, "no armed timer to fire");
      entry.fired = true;
      entry.fn();
    },
    setTimer: (fn: () => void, ms: number) => {
      const entry: Scheduled = { fn, ms, cancelled: false, fired: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimer: (handle: unknown) => {
      (handle as Scheduled).cancelled = true;
    },
  };
}

/** Flush pending micro/macrotasks so an injected-timer callback settles. */
function flush(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

/** Build an orchestrator + watcher pair over a real workflow file on disk. */
function build(path: string) {
  const tracker = new FakeTracker();
  const agentRunner = new FakeAgentRunner();
  const workspaceManager = new FakeWorkspaceManager();
  const { logger, records } = captureLogger();
  const sched = manualScheduler();
  const startup = loadWorkflowFile(path);
  const config = resolveConfig(startup, {});
  const orchestrator = createOrchestrator({
    config,
    tracker,
    agentRunner,
    workspaceManager,
    logger,
    status: createStatusSurface({ label: "test", stream: { write: () => true } }),
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const watch = fakeWatch();
  const watcher = createConfigWatcher({
    path,
    initial: { config, promptTemplate: startup.prompt_template },
    env: {},
    logger,
    watch,
    onReload: (snapshot) => orchestrator.applyConfig(snapshot.config),
  });
  return { orchestrator, watcher, watch, tracker, agentRunner, workspaceManager, records, sched, config };
}

function io(): HostIo {
  return { out: () => {}, err: () => {}, env: {}, cwd: "/tmp" };
}

/* ------------------------- a good edit takes effect ----------------------- */

test("[§6.2] a good edit re-applies polling.interval_ms to the running loop without a restart", async () => {
  const path = writeWorkflow(workflowText({ intervalMs: 30000 }));
  const { orchestrator, watcher, watch, sched } = build(path);
  watcher.start();
  orchestrator.start();
  assert.equal(sched.live().at(-1)?.ms, 0, "the first tick is immediate (FR6)");
  sched.fireLatest(); // run the immediate tick; the loop re-arms at 30000
  await flush();

  assert.equal(orchestrator.getState().poll_interval_ms, 30000);
  assert.equal(sched.live().at(-1)?.ms, 30000, "the loop is sleeping on the OLD interval");

  writeFileSync(path, workflowText({ intervalMs: 5000 }), "utf8");
  watch.fire();

  assert.equal(orchestrator.getState().poll_interval_ms, 5000, "new interval reached the loop");
  assert.equal(orchestrator.getConfig().polling.interval_ms, 5000);
  // The sleeping tick was re-armed at the shorter cadence rather than waiting out the old one.
  assert.equal(sched.live().length, 1);
  assert.equal(sched.live().at(-1)?.ms, 5000);

  await orchestrator.stop();
  watcher.stop();
});

test("[§6.2/§8.3] a good edit re-applies agent.max_concurrent_agents to dispatch gating", async () => {
  const path = writeWorkflow(workflowText({ maxAgents: 1 }));
  const { orchestrator, watcher, watch, tracker, agentRunner } = build(path);
  agentRunner.mode = "manual"; // runs stay in flight so the cap is observable
  tracker.candidates = [
    issue({ id: "id-1", identifier: "DEV-1" }),
    issue({ id: "id-2", identifier: "DEV-2" }),
  ];
  watcher.start();

  await orchestrator.tick();
  assert.equal(agentRunner.runs.length, 1, "the old cap of 1 allowed a single dispatch");

  writeFileSync(path, workflowText({ maxAgents: 3 }), "utf8");
  watch.fire();
  assert.equal(orchestrator.getState().max_concurrent_agents, 3);

  await orchestrator.tick();
  assert.equal(agentRunner.runs.length, 2, "the raised cap let the second candidate through");

  agentRunner.resolveAll();
  await flush();
  await orchestrator.stop();
  watcher.stop();
});

test("[§6.2] a reload also re-applies the tracker state sets used by later ticks", async () => {
  const path = writeWorkflow(workflowText());
  const { orchestrator, watcher, watch, tracker, agentRunner } = build(path);
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1", state: "Ready" })];
  watcher.start();

  await orchestrator.tick();
  assert.equal(agentRunner.runs.length, 0, "`Ready` is not an active state under the old config");

  const withReady = workflowText().replace(
    "  active_states: [Todo, In Progress]",
    "  active_states: [Todo, In Progress, Ready]",
  );
  writeFileSync(path, withReady, "utf8");
  watch.fire();
  assert.deepEqual(orchestrator.getConfig().tracker.active_states, ["Todo", "In Progress", "Ready"]);

  await orchestrator.tick();
  assert.equal(agentRunner.runs.length, 1, "the reloaded active states let `Ready` dispatch");

  await orchestrator.stop();
  watcher.stop();
});

/* --------------------- a bad edit is rejected, daemon lives --------------- */

test("[§6.2] a MALFORMED edit is rejected: old config kept, nothing thrown, error logged", async () => {
  const path = writeWorkflow(workflowText({ intervalMs: 30000, maxAgents: 2 }));
  const { orchestrator, watcher, watch, records, sched } = build(path);
  watcher.start();
  orchestrator.start();
  sched.fireLatest();
  await flush();

  writeFileSync(path, MALFORMED, "utf8");
  // The whole point: firing the watch on garbage must not throw.
  assert.doesNotThrow(() => watch.fire());

  assert.equal(orchestrator.getState().poll_interval_ms, 30000, "previous good interval retained");
  assert.equal(orchestrator.getState().max_concurrent_agents, 2, "previous good cap retained");
  assert.equal(watcher.current().config.polling.interval_ms, 30000);

  const rejected = records.find(
    (r) => r.context.action === "config_reload" && r.context.outcome === "rejected",
  );
  assert.ok(rejected !== undefined, "the rejection is operator-visible");
  assert.equal(rejected?.level, "error");
  assert.ok(Array.isArray(rejected?.context.errors) && (rejected?.context.errors as string[]).length > 0);

  // The daemon is still alive and still ticking on the old cadence.
  assert.equal(orchestrator.getState().poll_interval_ms, 30000);
  await orchestrator.tick();
  await orchestrator.stop();
  watcher.stop();
});

test("[§6.2/§6.3] an edit that parses but fails validation is rejected the same way", async () => {
  const path = writeWorkflow(workflowText({ intervalMs: 30000 }));
  const { orchestrator, watcher, watch, records } = build(path);
  watcher.start();

  // Valid YAML, invalid config: an unsupported tracker kind fails preflight (§6.3).
  const badKind = workflowText({ intervalMs: 1000 }).replace("  kind: notion", "  kind: jira");
  writeFileSync(path, badKind, "utf8");
  assert.doesNotThrow(() => watch.fire());

  assert.equal(orchestrator.getState().poll_interval_ms, 30000, "the 1000ms value was NOT adopted");
  assert.equal(orchestrator.getConfig().tracker.kind, "notion");
  assert.ok(
    records.some((r) => r.context.action === "config_reload" && r.context.outcome === "rejected"),
  );

  watcher.stop();
});

test("[§6.2] a type-invalid edit (non-positive interval) is rejected, not coerced", async () => {
  const path = writeWorkflow(workflowText({ intervalMs: 30000 }));
  const { orchestrator, watcher, watch } = build(path);
  watcher.start();

  writeFileSync(path, workflowText({ intervalMs: 0 }), "utf8");
  assert.doesNotThrow(() => watch.fire());

  assert.equal(orchestrator.getState().poll_interval_ms, 30000);
  watcher.stop();
});

test("[§6.2] a deleted workflow file is rejected and the previous config keeps running", async () => {
  const path = writeWorkflow(workflowText({ intervalMs: 30000 }));
  const { orchestrator, watcher, watch, records } = build(path);
  watcher.start();

  const { rmSync } = await import("node:fs");
  rmSync(path);
  assert.doesNotThrow(() => watch.fire());

  assert.equal(orchestrator.getState().poll_interval_ms, 30000);
  const rejected = records.find(
    (r) => r.context.action === "config_reload" && r.context.outcome === "rejected",
  );
  assert.ok(rejected !== undefined);
  assert.ok(String((rejected?.context.errors as string[])[0]).includes("missing_workflow_file"));

  watcher.stop();
});

test("[§6.2] an onReload that throws is contained; the watcher and daemon survive", () => {
  const path = writeWorkflow(workflowText({ intervalMs: 30000 }));
  const { logger, records } = captureLogger();
  const startup = loadWorkflowFile(path);
  const watch = fakeWatch();
  const watcher = createConfigWatcher({
    path,
    initial: { config: resolveConfig(startup, {}), promptTemplate: startup.prompt_template },
    env: {},
    logger,
    watch,
    onReload: () => {
      throw new Error("apply blew up");
    },
  });
  watcher.start();

  writeFileSync(path, workflowText({ intervalMs: 5000 }), "utf8");
  assert.doesNotThrow(() => watch.fire());

  assert.ok(
    records.some((r) => r.context.action === "config_reload" && r.context.outcome === "apply_failed"),
  );
  // The reload itself was accepted, so the watcher's current snapshot moved on.
  assert.equal(watcher.current().config.polling.interval_ms, 5000);
  watcher.stop();
});

/* ------------------------------ FR21 redaction ---------------------------- */

test("[FR21] a reload never writes tracker.auth into a log line", () => {
  const path = writeWorkflow(workflowText({ auth: AUTH_TOKEN }));
  const { watcher, watch, records } = build(path);
  watcher.start();

  // Rotate the token AND change the interval so an accepted reload definitely fires.
  const rotated = "ntn_rotated_secret_value";
  writeFileSync(path, workflowText({ auth: rotated, intervalMs: 5000 }), "utf8");
  watch.fire();
  assert.equal(watcher.current().config.tracker.auth, rotated, "the new token WAS adopted");

  // ...then a malformed edit, whose error path must not echo the token either.
  writeFileSync(path, MALFORMED, "utf8");
  watch.fire();

  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes(AUTH_TOKEN), "the original token leaked into a log record");
  assert.ok(!serialized.includes(rotated), "the rotated token leaked into a log record");

  watcher.stop();
});

/* ------------------------- in-flight runs are untouched ------------------- */

test("[§6.2] a reload does not disturb in-flight runs; only later scheduling changes", async () => {
  const path = writeWorkflow(workflowText({ intervalMs: 30000, maxAgents: 2 }));
  const { orchestrator, watcher, watch, tracker, agentRunner, workspaceManager } = build(path);
  agentRunner.mode = "manual";
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  watcher.start();

  await orchestrator.tick();
  assert.equal(orchestrator.runningCount(), 1);
  const entryBefore = orchestrator.getState().running.get("id-1");

  // Shrink the cap below the in-flight count and shorten the interval.
  writeFileSync(path, workflowText({ intervalMs: 1000, maxAgents: 1 }), "utf8");
  watch.fire();

  assert.equal(orchestrator.runningCount(), 1, "the in-flight run was not stopped");
  assert.deepEqual(orchestrator.getState().running.get("id-1"), entryBefore, "its entry is unchanged");
  assert.equal(agentRunner.runs.length, 1, "no re-launch happened");
  assert.deepEqual(workspaceManager.removed, [], "no workspace was torn down");

  // Only subsequent scheduling sees the tighter cap.
  tracker.candidates = [
    issue({ id: "id-1", identifier: "DEV-1" }),
    issue({ id: "id-2", identifier: "DEV-2" }),
  ];
  await orchestrator.tick();
  assert.equal(agentRunner.runs.length, 1, "the new cap of 1 blocked the second dispatch");

  agentRunner.resolveAll();
  await flush();
  await orchestrator.stop();
  watcher.stop();
});

/* ------------------------------ watcher hygiene --------------------------- */

test("a no-op change does not churn the loop", () => {
  const path = writeWorkflow(workflowText({ intervalMs: 30000 }));
  const { orchestrator, watcher, watch, records } = build(path);
  watcher.start();

  // Rewrite byte-identical content (what a `touch`/save-without-edit looks like).
  writeFileSync(path, workflowText({ intervalMs: 30000 }), "utf8");
  watch.fire();

  assert.ok(
    !records.some((r) => r.context.action === "config_apply"),
    "an unchanged file must not be re-applied",
  );
  assert.ok(
    records.some((r) => r.context.action === "config_reload" && r.context.outcome === "unchanged"),
  );
  assert.equal(orchestrator.getState().poll_interval_ms, 30000);
  watcher.stop();
});

test("start() is idempotent and stop() closes the injected watch handle", () => {
  const path = writeWorkflow(workflowText());
  const { watcher, watch } = build(path);
  watcher.start();
  watcher.start(); // second call is a no-op
  assert.equal(watch.watched(), path);

  watcher.stop();
  watcher.stop();
  assert.equal(watch.closed(), 1, "the handle is closed exactly once");

  // After stop, a late event (a race with shutdown) is ignored.
  assert.equal(watcher.reloadNow(), false);
});

test("reloadWorkflow reports failures instead of throwing", () => {
  const good = writeWorkflow(workflowText({ intervalMs: 5000 }));
  const okResult = reloadWorkflow(good, {});
  assert.equal(okResult.ok, true);
  assert.equal(okResult.ok === true ? okResult.config.polling.interval_ms : null, 5000);

  const bad = writeWorkflow(MALFORMED);
  const badResult = reloadWorkflow(bad, {});
  assert.equal(badResult.ok, false);
  assert.ok(badResult.ok === false && badResult.errors.length > 0);

  const missing = reloadWorkflow("/definitely/not/a/workflow/file.md", {});
  assert.equal(missing.ok, false);
});

test("applyConfig re-tunes the loop directly (interval + cap + retry cap)", () => {
  const { logger } = captureLogger();
  const sched = manualScheduler();
  const orchestrator = createOrchestrator({
    config: testConfig(),
    tracker: new FakeTracker(),
    agentRunner: new FakeAgentRunner(),
    workspaceManager: new FakeWorkspaceManager(),
    logger,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
  });

  const next = testConfig();
  next.polling = { interval_ms: 7777 };
  next.agent = { ...next.agent, max_concurrent_agents: 9, max_retry_backoff_ms: 12345 };
  orchestrator.applyConfig(next);

  assert.equal(orchestrator.getState().poll_interval_ms, 7777);
  assert.equal(orchestrator.getState().max_concurrent_agents, 9);
  assert.equal(orchestrator.getConfig().agent.max_retry_backoff_ms, 12345);
  // Nothing was scheduled: applyConfig only re-arms a tick that is already pending.
  assert.equal(sched.scheduled.length, 0);
});

/* ------------------------ the daemon wiring end-to-end -------------------- */

test("[§6.2] the running daemon adopts a good edit and rejects a bad one, then exits clean", async () => {
  const path = writeWorkflow(workflowText({ intervalMs: 30000 }));
  const tracker = new FakeTracker();
  const agentRunner = new FakeAgentRunner();
  const workspaceManager = new FakeWorkspaceManager();
  const { logger, records } = captureLogger();
  const watch = fakeWatch();

  let release = (): void => {};
  const runUntil = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });

  const exit = runCli([path], {
    tracker,
    agentRunner,
    workspaceManager,
    logger,
    io: io(),
    watch,
    runUntil,
  });
  await flush();

  // A good edit lands in the live loop...
  writeFileSync(path, workflowText({ intervalMs: 2000 }), "utf8");
  watch.fire();
  const applied = records.find((r) => r.context.action === "config_apply");
  assert.ok(applied !== undefined, "the daemon applied the reloaded config");
  assert.equal(applied?.context.poll_interval_ms, 2000);

  // ...and a malformed one does not take the daemon down.
  writeFileSync(path, MALFORMED, "utf8");
  watch.fire();
  assert.ok(
    records.some((r) => r.context.action === "config_reload" && r.context.outcome === "rejected"),
  );

  release();
  assert.equal(await exit, 0, "the daemon still shut down cleanly");
  assert.equal(watch.closed(), 1, "the watcher was stopped with the daemon");
  assert.ok(!JSON.stringify(records).includes(AUTH_TOKEN), "FR21 holds across the daemon run");
});
