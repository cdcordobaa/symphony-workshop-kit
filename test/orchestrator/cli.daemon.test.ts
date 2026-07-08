/**
 * `runCli` host-lifecycle tests (§16.1, §17.7 — FR20).
 *
 * These drive the real daemon wiring (`buildRuntime` + `Orchestrator`) with
 * injected port fakes, covering both run modes: `--once` (single immediate tick
 * then graceful stop) and the signal-driven daemon (run until a `runUntil`
 * promise, then drain). No real Notion, filesystem, Claude Code, or OS signals.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../../src/cli.js";
import type { HostIo } from "../../src/index.js";
import { writeWorkflow } from "../helpers.js";
import { captureLogger, FakeAgentRunner, FakeTracker, FakeWorkspaceManager, issue } from "./fakes.js";

const WORKFLOW = [
  "---",
  "tracker:",
  "  kind: notion",
  "  auth: literal-token",
  "  database_id: db-1",
  "  active_states: [Todo, In Progress]",
  "  terminal_states: [Done, Cancelled]",
  "polling:",
  "  interval_ms: 30000",
  "agent:",
  "  command: claude",
  "  max_concurrent_agents: 2",
  "---",
  "Prompt for {{ issue.identifier }}.",
].join("\n");

function io(): HostIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    env: {},
    cwd: "/tmp",
  };
}

test("[FR20] `--once` starts, ticks immediately (one dispatch), and returns OK", async () => {
  const path = writeWorkflow(WORKFLOW);
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agentRunner = new FakeAgentRunner();
  const workspaceManager = new FakeWorkspaceManager();
  const { logger, records } = captureLogger();

  const code = await runCli([path, "--once"], { tracker, agentRunner, workspaceManager, logger, io: io() });

  assert.equal(code, 0);
  assert.equal(agentRunner.runs.length, 1, "the immediate tick dispatched the candidate");
  assert.equal(tracker.calls.fetchCandidateIssues, 1);
  assert.ok(records.some((r) => r.context.action === "host_start" && r.context.mode === "once"));
  assert.ok(records.some((r) => r.context.action === "host_stop" && r.context.outcome === "clean"));
});

test("[FR20] the daemon runs until a shutdown signal, then drains gracefully", async () => {
  const path = writeWorkflow(WORKFLOW);
  const tracker = new FakeTracker();
  tracker.candidates = [issue({ id: "id-1", identifier: "DEV-1" })];
  const agentRunner = new FakeAgentRunner();
  const workspaceManager = new FakeWorkspaceManager();
  const { logger, records } = captureLogger();

  let release!: () => void;
  const runUntil = new Promise<void>((r) => {
    release = r;
  });

  const done = runCli([path], { tracker, agentRunner, workspaceManager, logger, io: io(), runUntil });

  // Let the immediate first tick (real setTimeout(0)) run, then signal shutdown.
  await new Promise((r) => setTimeout(r, 25));
  release();
  const code = await done;

  assert.equal(code, 0);
  assert.ok(agentRunner.runs.length >= 1, "the daemon ticked at least once before shutdown");
  assert.ok(records.some((r) => r.context.action === "host_stop" && r.context.mode === "daemon"));
});

test("a missing workflow file yields the MISSING_WORKFLOW exit code without starting a daemon", async () => {
  const code = await runCli(["/no/such/WORKFLOW.md"], { io: io() });
  assert.equal(code, 2);
});

test("a preflight failure yields STARTUP_FAILURE without starting a daemon", async () => {
  const path = writeWorkflow(
    ["---", "tracker:", "  kind: notion", "  database_id: db-1", "---", "body"].join("\n"),
  );
  const out = io();
  const code = await runCli([path], { io: out });
  assert.equal(code, 1);
  assert.ok(out.stderr.some((l) => l.includes("preflight failed")));
});
