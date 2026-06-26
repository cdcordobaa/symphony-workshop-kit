import { describe, expect, it } from "vitest";
import path from "node:path";

import { Logger, MemorySink } from "../../obs/log.js";
import type { AgentConfig } from "../../domain/config.js";
import type { AgentEvent, Workspace } from "../../domain/interfaces.js";
import { makeIssue } from "../../../test/helpers.js";
import {
  WorkspaceManagerImpl,
  WorkspaceSafetyError,
} from "../../workspace/manager.js";
import { ClaudeCodeAgentRunner } from "../runner.js";
import type {
  AgentProcess,
  AgentSpawner,
  AgentSpawnRequest,
} from "../process.js";

const fixedNow = () => new Date("2026-06-02T12:00:00.000Z");
const ROOT = "/srv/ws";

function makeLogger() {
  const sink = new MemorySink();
  const logger = new Logger({ level: "debug", sinks: [sink], now: fixedNow });
  return { logger, sink };
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    command: "claude --print --permission-mode bypassPermissions",
    max_concurrent_agents: 1,
    max_turns: 1,
    max_retry_backoff_ms: 0,
    max_concurrent_agents_by_state: {},
    turn_timeout_ms: 1000,
    read_timeout_ms: 1000,
    stall_timeout_ms: 1000,
    ...overrides,
  };
}

function workspaceFor(key = "SYM-1"): Workspace {
  return {
    path: path.join(ROOT, key),
    workspace_key: key,
    created_now: false,
  };
}

function mgr(logger: Logger): WorkspaceManagerImpl {
  return new WorkspaceManagerImpl({
    root: ROOT,
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 1000,
    },
    logger,
  });
}

/**
 * A scripted fake agent process. `lines` are emitted on stdout in order, then
 * the process exits with `exitCode` (unless a line already terminates the turn).
 * Captures the spawn request so launch contract can be asserted.
 */
class FakeAgentProcess implements AgentProcess {
  private stdoutHandlers: ((line: string) => void)[] = [];
  private stderrHandlers: ((text: string) => void)[] = [];
  private errorHandlers: ((e: Error) => void)[] = [];
  private exitHandlers: ((c: number | null, s: string | null) => void)[] = [];
  killed = false;

  constructor(
    private readonly script: {
      lines?: string[];
      stderr?: string;
      exitCode?: number | null;
      spawnError?: Error;
      hang?: boolean;
    },
  ) {}

  onStdoutLine(h: (line: string) => void): void {
    this.stdoutHandlers.push(h);
  }
  onStderr(h: (text: string) => void): void {
    this.stderrHandlers.push(h);
  }
  onError(h: (e: Error) => void): void {
    this.errorHandlers.push(h);
  }
  onExit(h: (c: number | null, s: string | null) => void): void {
    this.exitHandlers.push(h);
  }
  kill(): void {
    this.killed = true;
  }

  /** Drive the scripted output on the next microtasks. */
  start(): void {
    queueMicrotask(() => {
      if (this.script.spawnError) {
        for (const h of this.errorHandlers) h(this.script.spawnError);
        return;
      }
      if (this.script.stderr) {
        for (const h of this.stderrHandlers) h(this.script.stderr);
      }
      for (const line of this.script.lines ?? []) {
        for (const h of this.stdoutHandlers) h(line);
      }
      if (this.script.hang) return; // never exits → exercises the timeout path
      const code = this.script.exitCode ?? 0;
      for (const h of this.exitHandlers) h(code, null);
    });
  }
}

function spawnerOf(
  proc: FakeAgentProcess,
  capture?: (req: AgentSpawnRequest) => void,
): AgentSpawner {
  return (req) => {
    capture?.(req);
    proc.start();
    return proc;
  };
}

const INIT = (sid = "thread-abc") =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const SUCCESS = (sid = "thread-abc") =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sid,
    result: "ok",
  });
const ERROR = (sid = "thread-abc", msg = "boom") =>
  JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: sid,
    result: msg,
  });
const INPUT_REQUIRED = (sid = "thread-abc") =>
  JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    session_id: sid,
    result: "tool requires user input / permission",
  });

function collectEvents(): {
  onEvent: (e: AgentEvent) => void;
  events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  return { onEvent: (e) => events.push(e), events };
}

describe("ClaudeCodeAgentRunner launch contract (FR-AG-1, FR-WS-3a)", () => {
  it("launches with cwd === workspace_path and the configured command", async () => {
    const { logger } = makeLogger();
    let captured: AgentSpawnRequest | null = null;
    const proc = new FakeAgentProcess({ lines: [INIT(), SUCCESS()] });
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig(),
      workspace: mgr(logger),
      logger,
      spawner: spawnerOf(proc, (r) => (captured = r)),
      now: fixedNow,
    });
    const ws = workspaceFor("SYM-1");
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: ws, prompt: "PROMPT" });
    expect(res.ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.cwd).toBe(ws.path);
    expect(captured!.command).toBe("claude --print --permission-mode bypassPermissions");
    expect(captured!.prompt).toBe("PROMPT");
  });

  it("fails before launch when invariant (a) is violated (cwd check throws)", async () => {
    const { logger } = makeLogger();
    const { onEvent, events } = collectEvents();
    let spawned = false;
    const proc = new FakeAgentProcess({ lines: [INIT(), SUCCESS()] });
    // A manager whose launch-time cwd invariant always rejects.
    const guarded = mgr(logger);
    guarded.assertCwdMatchesWorkspace = () => {
      throw new WorkspaceSafetyError(
        "invalid_workspace_cwd",
        "cwd does not equal workspace path",
      );
    };
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig(),
      workspace: guarded,
      logger,
      spawner: () => {
        spawned = true;
        proc.start();
        return proc;
      },
      now: fixedNow,
    });
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: workspaceFor(), prompt: "P" }, onEvent);
    expect(res.ok).toBe(false);
    expect(res.error_category).toBe("invalid_workspace_cwd");
    expect(spawned).toBe(false);
    expect(events.some((e) => e.type === "startup_failed")).toBe(true);
  });
});

describe("ClaudeCodeAgentRunner turn outcomes (FR-AG-3,4,5)", () => {
  it("success: emits session_started + turn_completed and session_id=<thread>-1", async () => {
    const { logger } = makeLogger();
    const { onEvent, events } = collectEvents();
    const proc = new FakeAgentProcess({ lines: [INIT("thread-abc"), SUCCESS("thread-abc")] });
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig(),
      workspace: mgr(logger),
      logger,
      spawner: spawnerOf(proc),
      now: fixedNow,
    });
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: workspaceFor(), prompt: "P" }, onEvent);
    expect(res.ok).toBe(true);
    expect(res.session_id).toBe("thread-abc-1");
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["session_started", "turn_completed"]),
    );
    const started = events.find((e) => e.type === "session_started");
    expect(started?.session_id).toBe("thread-abc-1");
  });

  it("failure: a turn error maps to ok=false with category turn_failed", async () => {
    const { logger } = makeLogger();
    const { onEvent, events } = collectEvents();
    const proc = new FakeAgentProcess({ lines: [INIT(), ERROR("thread-abc", "kaboom")] });
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig(),
      workspace: mgr(logger),
      logger,
      spawner: spawnerOf(proc),
      now: fixedNow,
    });
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: workspaceFor(), prompt: "P" }, onEvent);
    expect(res.ok).toBe(false);
    expect(res.error_category).toBe("turn_failed");
    expect(res.error).toContain("kaboom");
    expect(events.some((e) => e.type === "turn_failed")).toBe(true);
  });

  it("high-trust: user-input-required is a hard failure (turn_input_required)", async () => {
    const { logger } = makeLogger();
    const proc = new FakeAgentProcess({ lines: [INIT(), INPUT_REQUIRED()] });
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig(),
      workspace: mgr(logger),
      logger,
      spawner: spawnerOf(proc),
      now: fixedNow,
    });
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: workspaceFor(), prompt: "P" });
    expect(res.ok).toBe(false);
    expect(res.error_category).toBe("turn_input_required");
  });

  it("timeout: a hanging turn maps to ok=false with category turn_timeout", async () => {
    const { logger } = makeLogger();
    const proc = new FakeAgentProcess({ lines: [INIT()], hang: true });
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig({ turn_timeout_ms: 20 }),
      workspace: mgr(logger),
      logger,
      spawner: spawnerOf(proc),
      now: fixedNow,
    });
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: workspaceFor(), prompt: "P" });
    expect(res.ok).toBe(false);
    expect(res.error_category).toBe("turn_timeout");
    expect(proc.killed).toBe(true);
  });

  it("spawn failure (command not found) maps to startup_failed/agent_not_found", async () => {
    const { logger } = makeLogger();
    const { onEvent, events } = collectEvents();
    const proc = new FakeAgentProcess({ spawnError: new Error("spawn bash ENOENT") });
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig(),
      workspace: mgr(logger),
      logger,
      spawner: spawnerOf(proc),
      now: fixedNow,
    });
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: workspaceFor(), prompt: "P" }, onEvent);
    expect(res.ok).toBe(false);
    expect(res.error_category).toBe("agent_not_found");
    expect(events.some((e) => e.type === "startup_failed")).toBe(true);
  });

  it("non-zero exit with no result line maps to port_exit failure", async () => {
    const { logger } = makeLogger();
    const proc = new FakeAgentProcess({ lines: [INIT()], exitCode: 3 });
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig(),
      workspace: mgr(logger),
      logger,
      spawner: spawnerOf(proc),
      now: fixedNow,
    });
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: workspaceFor(), prompt: "P" });
    expect(res.ok).toBe(false);
    expect(res.error_category).toBe("port_exit");
  });
});

describe("ClaudeCodeAgentRunner prompt rendering (FR-PR-1,2)", () => {
  it("renders from issue+attempt when no prompt is supplied", async () => {
    const { logger } = makeLogger();
    let captured: AgentSpawnRequest | null = null;
    const proc = new FakeAgentProcess({ lines: [INIT(), SUCCESS()] });
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig(),
      workspace: mgr(logger),
      logger,
      spawner: spawnerOf(proc, (r) => (captured = r)),
      now: fixedNow,
    });
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: workspaceFor(), prompt: "" });
    expect(res.ok).toBe(true);
    // Falls back to the default prompt (renderer FALLBACK_PROMPT) — non-empty.
    expect(captured!.prompt.length).toBeGreaterThan(0);
  });

  it("a prompt render failure fails the attempt without launching", async () => {
    const { logger } = makeLogger();
    const { onEvent, events } = collectEvents();
    let spawned = false;
    const proc = new FakeAgentProcess({ lines: [INIT(), SUCCESS()] });
    const runner = new ClaudeCodeAgentRunner({
      agent: agentConfig(),
      workspace: mgr(logger),
      logger,
      // Strict renderer throws on an unknown variable. No pre-rendered prompt is
      // supplied, so the runner renders this template and must fail the attempt.
      promptTemplate: "Hello {{ nope.unknown }}",
      spawner: () => {
        spawned = true;
        proc.start();
        return proc;
      },
      now: fixedNow,
    });
    const res = await runner.run({ issue: makeIssue(), attempt: null, workspace: workspaceFor(), prompt: "" }, onEvent);
    expect(res.ok).toBe(false);
    expect(res.error_category).toBe("render_failed");
    expect(spawned).toBe(false);
    expect(events.some((e) => e.type === "startup_failed")).toBe(true);
  });
});
