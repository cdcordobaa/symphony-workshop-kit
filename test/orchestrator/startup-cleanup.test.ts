/**
 * Startup terminal-workspace cleanup tests (§8.6 / DEV-3).
 *
 * Drives the REAL {@link Orchestrator.cleanupTerminalWorkspaces} over in-memory
 * port fakes. Covers the three acceptance criteria: terminal workspaces are
 * removed, a tracker fetch failure logs a warning and startup continues, and
 * non-terminal issues' workspaces are left untouched.
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

function build(overrides: {
  tracker?: FakeTracker;
  workspace?: FakeWorkspaceManager;
  config?: ReturnType<typeof testConfig>;
} = {}) {
  const config = overrides.config ?? testConfig();
  const tracker = overrides.tracker ?? new FakeTracker();
  const workspaceManager = overrides.workspace ?? new FakeWorkspaceManager();
  const { logger, records } = captureLogger();
  const status = createStatusSurface({ label: "test", stream: { write: () => true } });
  const orchestrator = createOrchestrator({
    config,
    tracker,
    agentRunner: new FakeAgentRunner(),
    workspaceManager,
    logger,
    status,
    setTimer: (fn, _ms) => fn as unknown,
    clearTimer: () => {},
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return { orchestrator, tracker, workspaceManager, records, config };
}

/* ------------------------- AC1: terminal workspaces removed ------------------------- */

test("[§8.6] removes the workspace of every terminal-state issue on startup", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [
    issue({ id: "id-done", identifier: "DEV-9", state: "Done" }),
    issue({ id: "id-cancelled", identifier: "DEV-10", state: "Cancelled" }),
  ];
  const { orchestrator, workspaceManager, tracker: t } = build({ tracker });

  await orchestrator.cleanupTerminalWorkspaces();

  // Queried the tracker with exactly the configured terminal states.
  assert.equal(t.calls.fetchIssuesByStates, 1);
  assert.deepEqual(t.byStatesArgs[0], ["Done", "Cancelled"]);
  // Removed the workspace for each terminal issue.
  assert.deepEqual(workspaceManager.removed.sort(), ["DEV-10", "DEV-9"]);
});

/* --------------------- AC2: fetch failure logs a warning + continues --------------------- */

test("[§8.6] a tracker fetch failure logs a warning and startup still proceeds", async () => {
  const tracker = new FakeTracker();
  tracker.failByStates = new Error("notion unreachable");
  const { orchestrator, workspaceManager, records } = build({ tracker });

  // Must not throw — startup continues.
  await assert.doesNotReject(orchestrator.cleanupTerminalWorkspaces());

  // Nothing removed, and a warning was logged.
  assert.deepEqual(workspaceManager.removed, []);
  const warned = records.find(
    (r) => r.level === "warn" && r.context.action === "startup_cleanup",
  );
  assert.ok(warned, "expected a startup_cleanup warning to be logged");
  assert.match(String(warned?.context.error), /notion unreachable/);
});

/* ------------------- AC3: non-terminal workspaces are preserved ------------------- */

test("[§8.6] non-terminal issues' workspaces are not removed", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [
    issue({ id: "id-todo", identifier: "DEV-1", state: "Todo" }),
    issue({ id: "id-progress", identifier: "DEV-2", state: "In Progress" }),
    issue({ id: "id-done", identifier: "DEV-3", state: "Done" }),
  ];
  const { orchestrator, workspaceManager } = build({ tracker });

  await orchestrator.cleanupTerminalWorkspaces();

  // Only the terminal (Done) workspace is removed; active ones are untouched.
  assert.deepEqual(workspaceManager.removed, ["DEV-3"]);
  assert.ok(!workspaceManager.removed.includes("DEV-1"));
  assert.ok(!workspaceManager.removed.includes("DEV-2"));
});

/* --------------- robustness: one bad removal does not abort the sweep --------------- */

test("[§8.6] a per-workspace removal failure is logged and the sweep continues", async () => {
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-done", identifier: "DEV-9", state: "Done" })];
  const workspace = new FakeWorkspaceManager();
  workspace.removeError = new Error("EACCES");
  const { orchestrator, records } = build({ tracker, workspace });

  await assert.doesNotReject(orchestrator.cleanupTerminalWorkspaces());

  const warned = records.find(
    (r) => r.level === "warn" && r.message.includes("workspace removal failed"),
  );
  assert.ok(warned, "expected a per-workspace removal warning");
  // Sweep still reports completion.
  const done = records.find((r) => r.message === "startup terminal-workspace cleanup complete");
  assert.ok(done, "expected the cleanup-complete summary log");
});
