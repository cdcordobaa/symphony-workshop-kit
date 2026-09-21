/**
 * Stall detection (§8.4 brief / spec §8.5 Part A, §10.6) — DEV-4.
 *
 * A run that produces no agent output for `agent.stall_timeout_ms` must be ended
 * rather than left hanging until `turn_timeout_ms`. These tests drive the real
 * runner over the injectable spawner plus a manual timer scheduler (the fake
 * clock), so nothing depends on wall-clock time:
 *
 *   (a) a stream that goes quiet past the threshold fails as `turn_stalled`;
 *   (b) a stream that keeps emitting past the threshold does NOT stall;
 *   (c) the child process is actually killed;
 *   plus `stall_timeout_ms <= 0` disables detection, and stall stays distinct
 *   from the untouched `turn_timeout_ms` path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createAgentRunner } from "../../src/agent/runner.js";
import { sampleIssue } from "../helpers.js";
import {
  agentConfig,
  controlledSpawner,
  manualTimers,
  stubWorkspaceManager,
  type ManualTimers,
} from "./fake.js";
import { captureLogger } from "../orchestrator/fakes.js";

const WS = resolve("/tmp/symphony-ws/ARK-123");

const INIT = '{"type":"system","subtype":"init","session_id":"thread-abc","tools":[]}';
const CHATTER = '{"type":"assistant","message":{"role":"assistant"},"session_id":"thread-abc","uuid":"msg-1"}';
const RESULT =
  '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"thread-abc","uuid":"turn-xyz"}';

/** Let the runner's async prelude (workspace prepare + spawn) settle. */
function flush(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

/** Start a run over a controlled child + manual clock; returns once the child is spawned. */
async function startRun(stallTimeoutMs = 300_000) {
  const { spawn, calls, process } = controlledSpawner();
  const timers: ManualTimers = manualTimers();
  const { logger, records } = captureLogger();
  const runner = createAgentRunner({
    config: agentConfig({ stall_timeout_ms: stallTimeoutMs }),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "Do {{ issue.identifier }}",
    spawn,
    logger,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const running = runner.run(sampleIssue(), null);
  await flush(); // the child is spawned and the first stall window is armed
  const proc = process();
  assert.ok(proc, "the child process was spawned");
  return { running, proc, timers, calls, records };
}

test("(a) a stream that goes quiet past the threshold fails as stalled [§8.5 Part A]", async () => {
  const { running, proc, timers, records } = await startRun(300_000);

  // One event, then silence. The window is armed and nobody resets it again.
  proc.emitLine(INIT);
  assert.equal(timers.pending().length, 1, "exactly one live inactivity window");
  assert.equal(timers.pending()[0]?.ms, 300_000, "armed with agent.stall_timeout_ms");

  timers.fireAll(); // the inactivity window elapses

  const result = await running;
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /turn_stalled/, "a distinct stalled reason, not turn_timeout");
  assert.doesNotMatch(result.error ?? "", /turn_timeout/);
  assert.match(result.error ?? "", /no agent output for 300000ms/);
  assert.equal(result.session_id, "thread-abc-0", "the partial session id is still reported");

  // Logged through the existing structured logger with the required context (§13.1).
  const stall = records.find((r) => r.context["action"] === "agent_stall");
  assert.ok(stall, "a structured agent_stall record was emitted");
  assert.equal(stall?.level, "warn");
  assert.equal(stall?.context["issue_id"], "issue-uuid-1");
  assert.equal(stall?.context["issue_identifier"], "ABC-123");
  assert.equal(stall?.context["session_id"], "thread-abc-0");
  assert.equal(stall?.context["stall_timeout_ms"], 300_000);
});

test("(b) a stream that keeps emitting past the threshold does not stall", async () => {
  const { running, proc, timers } = await startRun(300_000);

  const atLaunch = timers.armed[0];
  assert.ok(atLaunch, "the window is armed at launch, before any event");

  proc.emitLine(INIT);
  assert.equal(atLaunch.cancelled, true, "the launch window is reset by the first event");
  atLaunch.fire(); // a stale window must stay silent

  const afterInit = timers.pending()[0];
  proc.emitLine(CHATTER);
  assert.equal(afterInit?.cancelled, true, "every event resets the window");
  afterInit?.fire();

  // Output kept flowing right up to the terminal result: the run completes normally.
  proc.emitLine(RESULT);
  proc.emit("close", 0);

  const result = await running;
  assert.equal(result.status, "succeeded", "output was flowing — the stall timer must not fire");
  assert.equal(result.session_id, "thread-abc-turn-xyz");
  assert.equal(proc.killed, false, "a healthy run is never killed");
  assert.equal(timers.pending().length, 0, "the window is disarmed once the attempt settles");
  assert.equal(timers.armed.length, 4, "armed at launch + re-armed on each of the 3 events");
});

test("(c) the stalled child process is actually killed", async () => {
  const { running, proc, timers } = await startRun(1_000);

  proc.emitLine(INIT);
  timers.fireAll();
  await running;

  assert.equal(proc.killed, true, "the child is terminated, not left hanging");
  assert.deepEqual(proc.killSignals, ["SIGTERM"]);
});

test("a stalled run ignores the child's later close — the stalled reason stands", async () => {
  const { running, proc, timers } = await startRun(1_000);

  timers.fireAll(); // stalls before any event ever arrives (elapsed measured from launch)
  proc.emit("close", 143); // the SIGTERM'd child exits afterwards

  const result = await running;
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /turn_stalled/);
  assert.doesNotMatch(result.error ?? "", /port_exit/, "the close path must not overwrite it");
});

test("stall_timeout_ms <= 0 disables stall detection entirely [§5.3]", async () => {
  const { running, proc, timers } = await startRun(0);

  assert.equal(timers.armed.length, 0, "no inactivity window is ever armed");
  proc.emitLine(INIT);
  proc.emitLine(RESULT);
  assert.equal(timers.armed.length, 0, "events do not arm one either");
  proc.emit("close", 0);

  const result = await running;
  assert.equal(result.status, "succeeded");
});

test("turn_timeout_ms behavior is intact and distinct from stall [FR16]", async () => {
  // Stall detection off, a real 25ms turn timeout on: the run still times out.
  const { spawn, process } = controlledSpawner();
  const runner = createAgentRunner({
    config: agentConfig({ turn_timeout_ms: 25, stall_timeout_ms: 0 }),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "x",
    spawn,
  });

  const result = await runner.run(sampleIssue(), null);
  assert.equal(result.status, "timeout");
  assert.match(result.error ?? "", /turn_timeout/);
  assert.doesNotMatch(result.error ?? "", /turn_stalled/);
  assert.equal(process()?.killed, true);
});
