/**
 * Agent Runner (§10) — driven with a stubbed subprocess. Covers the SYM-006
 * acceptance criteria: launch contract + cwd (FR14), Safety A re-check (FR11),
 * high-trust auto-approve + user-input hard fail (FR14/D5), single-turn
 * success/failure mapping (FR16), and session_id derivation (FR16).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createAgentRunner, buildClaudeInvocation } from "../../src/agent/runner.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { sampleIssue } from "../helpers.js";
import { agentConfig, fakeSpawner, stubWorkspaceManager } from "./fake.js";

const WS = resolve("/tmp/symphony-ws/ARK-123");

const SUCCESS_LINES = [
  '{"type":"system","subtype":"init","session_id":"thread-abc","tools":[]}',
  '{"type":"assistant","message":{"role":"assistant"},"session_id":"thread-abc","uuid":"msg-1"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"thread-abc","uuid":"turn-xyz"}',
];

test("launches via `bash -lc` with cwd == workspace path [FR14]", async () => {
  const { spawn, calls } = fakeSpawner({ lines: SUCCESS_LINES });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "Do {{ issue.identifier }}",
    spawn,
  });

  const result = await runner.run(sampleIssue(), null);

  assert.equal(result.status, "succeeded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "bash");
  assert.equal(calls[0].args[0], "-lc");
  assert.equal(calls[0].cwd, WS, "cwd is exactly the workspace path");
});

test("applies high-trust headless flags and pipes the prompt over stdin [FR14/D5]", async () => {
  const { spawn, calls, process } = fakeSpawner({ lines: SUCCESS_LINES });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "Work {{ issue.identifier }}",
    spawn,
  });

  await runner.run(sampleIssue(), null);

  const invocation = calls[0].args[1];
  assert.match(invocation, /(^|\s)-p(\s|$)/, "non-interactive -p");
  assert.match(invocation, /--output-format stream-json/, "machine-readable stream");
  assert.match(invocation, /--permission-mode bypassPermissions/, "auto-approve commands + edits");
  assert.deepEqual(process()?.stdinChunks, ["Work ABC-123"]);
  assert.equal(process()?.stdinEnded, true);
});

test("Safety A: launch is refused when cwd != workspace path [FR11]", async () => {
  // prepare() returns a path that differs from the canonical workspacePathFor().
  const { spawn, calls } = fakeSpawner({ lines: SUCCESS_LINES });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(resolve("/tmp/ws/WRONG"), resolve("/tmp/ws/ARK-123")),
    promptTemplate: "x",
    spawn,
  });

  const result = await runner.run(sampleIssue(), null);

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /invalid_workspace_cwd/);
  assert.equal(calls.length, 0, "the subprocess is never spawned");
});

test("maps a successful single turn to succeeded + derives session_id [FR16]", async () => {
  const { spawn } = fakeSpawner({ lines: SUCCESS_LINES });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "x",
    spawn,
  });

  const result = await runner.run(sampleIssue(), null);

  assert.equal(result.status, "succeeded");
  assert.equal(result.session_id, "thread-abc-turn-xyz", "session_id = <thread_id>-<turn_id>");
  assert.equal(result.issue_id, "issue-uuid-1");
  assert.equal(result.workspace_path, WS);
});

test("maps an errored turn result to failed [FR16]", async () => {
  const { spawn } = fakeSpawner({
    lines: [
      '{"type":"system","subtype":"init","session_id":"t2","tools":[]}',
      '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"t2","uuid":"turn-e"}',
    ],
  });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "x",
    spawn,
  });

  const result = await runner.run(sampleIssue(), 1);

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /turn_failed/);
  assert.equal(result.session_id, "t2-turn-e");
});

test("user-input-required is a hard failure under high-trust [FR14/D5]", async () => {
  const { spawn, process } = fakeSpawner({
    lines: [
      '{"type":"system","subtype":"init","session_id":"t3"}',
      '{"type":"control_request","request_id":"1"}',
    ],
  });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "x",
    spawn,
  });

  const result = await runner.run(sampleIssue(), null);

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /turn_input_required/);
  assert.equal(process()?.killed, true, "the stalled prompt is killed, never left hanging");
});

test("a subprocess exit with no turn result maps to a port_exit failure", async () => {
  const { spawn } = fakeSpawner({ lines: [], exitCode: 1 });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "x",
    spawn,
  });

  const result = await runner.run(sampleIssue(), null);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /port_exit/);
});

test("a spawn failure maps to agent_not_found", async () => {
  const { spawn } = fakeSpawner({ throwOnSpawn: new Error("spawn bash ENOENT") });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "x",
    spawn,
  });

  const result = await runner.run(sampleIssue(), null);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /agent_not_found/);
});

test("a turn that never completes hits the turn timeout [FR16]", async () => {
  const { spawn, process } = fakeSpawner({ lines: [], neverClose: true });
  const runner = createAgentRunner({
    config: agentConfig({ turn_timeout_ms: 25 }),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "x",
    spawn,
  });

  const result = await runner.run(sampleIssue(), null);
  assert.equal(result.status, "timeout");
  assert.match(result.error ?? "", /turn_timeout/);
  assert.equal(process()?.killed, true);
});

test("a prompt render failure fails the attempt without spawning [FR15]", async () => {
  const { spawn, calls } = fakeSpawner({ lines: SUCCESS_LINES });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "Hello {{ nope }}",
    spawn,
  });

  const result = await runner.run(sampleIssue(), null);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /prompt_render_error/);
  assert.equal(calls.length, 0);
});

test("forwards normalized events to the onEvent callback [§10.4]", async () => {
  const events: AgentEvent[] = [];
  const { spawn } = fakeSpawner({ lines: SUCCESS_LINES });
  const runner = createAgentRunner({
    config: agentConfig(),
    workspaceManager: stubWorkspaceManager(WS),
    promptTemplate: "x",
    spawn,
    onEvent: (e) => events.push(e),
  });

  await runner.run(sampleIssue(), null);
  const names = events.map((e) => e.event);
  assert.deepEqual(names, ["session_started", "notification", "turn_completed"]);
});

test("buildClaudeInvocation is idempotent and respects overrides", () => {
  const fromDefault = buildClaudeInvocation("claude");
  assert.match(fromDefault, /^claude -p --output-format stream-json --verbose --permission-mode bypassPermissions$/);
  // Pre-supplied flags are not duplicated.
  const custom = buildClaudeInvocation("claude --print --output-format=stream-json --dangerously-skip-permissions --verbose");
  assert.equal((custom.match(/--output-format/g) ?? []).length, 1);
  assert.doesNotMatch(custom, /(^|\s)-p(\s|$)/); // --print already present, -p not added
  assert.doesNotMatch(custom, /bypassPermissions/); // skip-permissions already present
});
