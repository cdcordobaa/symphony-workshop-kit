import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Logger, MemorySink } from "../../obs/log.js";
import type { HooksConfig } from "../../domain/config.js";
import { makeIssue } from "../../../test/helpers.js";
import {
  WorkspaceManagerImpl,
  WorkspaceSafetyError,
  assertContainedInRoot,
  sanitizeWorkspaceKey,
} from "../manager.js";
import type { HookRunner, HookRunResult } from "../hooks.js";

const fixedNow = () => new Date("2026-06-02T12:00:00.000Z");

function makeLogger() {
  const sink = new MemorySink();
  const logger = new Logger({ level: "debug", sinks: [sink], now: fixedNow });
  return { logger, sink };
}

function hooksConfig(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    after_create: null,
    before_run: null,
    after_run: null,
    before_remove: null,
    timeout_ms: 1000,
    ...overrides,
  };
}

/** Hook runner stub that records calls and returns a canned result. */
function stubHookRunner(result: HookRunResult): {
  runner: HookRunner;
  calls: { script: string; cwd: string; timeoutMs: number }[];
} {
  const calls: { script: string; cwd: string; timeoutMs: number }[] = [];
  const runner: HookRunner = (req) => {
    calls.push({ script: req.script, cwd: req.cwd, timeoutMs: req.timeoutMs });
    return Promise.resolve(result);
  };
  return { runner, calls };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sym-ws-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("sanitizeWorkspaceKey (FR-WS-3c)", () => {
  it("replaces every char outside [A-Za-z0-9._-] with _", () => {
    expect(sanitizeWorkspaceKey("SYM-123")).toBe("SYM-123");
    expect(sanitizeWorkspaceKey("a b/c")).toBe("a_b_c");
    expect(sanitizeWorkspaceKey("../etc/passwd")).toBe(".._etc_passwd");
    expect(sanitizeWorkspaceKey("a:b*c?")).toBe("a_b_c_");
    expect(sanitizeWorkspaceKey("ok.name_1-2")).toBe("ok.name_1-2");
  });

  it("collapses an empty or all-illegal identifier to _", () => {
    expect(sanitizeWorkspaceKey("")).toBe("_");
    expect(sanitizeWorkspaceKey("/")).toBe("_");
  });
});

describe("assertContainedInRoot (FR-WS-3b)", () => {
  it("accepts a strict descendant of root", () => {
    expect(() =>
      assertContainedInRoot("/srv/ws", "/srv/ws/SYM-1"),
    ).not.toThrow();
  });

  it("rejects the root itself", () => {
    expect(() => assertContainedInRoot("/srv/ws", "/srv/ws")).toThrow(
      WorkspaceSafetyError,
    );
  });

  it("rejects a sibling/escape via ..", () => {
    expect(() => assertContainedInRoot("/srv/ws", "/srv/ws/../evil")).toThrow(
      WorkspaceSafetyError,
    );
    expect(() => assertContainedInRoot("/srv/ws", "/etc/passwd")).toThrow(
      WorkspaceSafetyError,
    );
  });
});

describe("WorkspaceManagerImpl.ensureWorkspace (FR-WS-1)", () => {
  it("creates <root>/<sanitized_key> and marks created_now on fresh creation", async () => {
    const { logger } = makeLogger();
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig(),
      logger,
    });
    const issue = makeIssue({ identifier: "SYM 7/x" });
    const ws = await mgr.ensureWorkspace(issue);

    expect(ws.workspace_key).toBe("SYM_7_x");
    expect(ws.path).toBe(path.join(path.resolve(tmpRoot), "SYM_7_x"));
    expect(ws.created_now).toBe(true);
    expect(fs.statSync(ws.path).isDirectory()).toBe(true);
  });

  it("reuses an existing workspace (created_now=false) on the second call", async () => {
    const { logger } = makeLogger();
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig(),
      logger,
    });
    const issue = makeIssue({ identifier: "SYM-9" });
    const first = await mgr.ensureWorkspace(issue);
    expect(first.created_now).toBe(true);
    const second = await mgr.ensureWorkspace(issue);
    expect(second.created_now).toBe(false);
    expect(second.path).toBe(first.path);
  });

  it("normalizes the workspace key so traversal cannot escape the root", async () => {
    const { logger } = makeLogger();
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig(),
      logger,
    });
    // The dangerous identifier is sanitized, so the resulting dir stays inside.
    const ws = await mgr.ensureWorkspace(makeIssue({ identifier: "../../etc" }));
    expect(ws.workspace_key).toBe(".._.._etc");
    expect(path.dirname(ws.path)).toBe(path.resolve(tmpRoot));
  });
});

describe("WorkspaceManagerImpl.assertCwdMatchesWorkspace (FR-WS-3a)", () => {
  it("passes when cwd equals workspace path", () => {
    const { logger } = makeLogger();
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig(),
      logger,
    });
    const wsPath = path.join(tmpRoot, "SYM-1");
    expect(() => mgr.assertCwdMatchesWorkspace(wsPath, wsPath)).not.toThrow();
  });

  it("throws invalid_workspace_cwd when cwd differs from workspace path", () => {
    const { logger } = makeLogger();
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig(),
      logger,
    });
    const wsPath = path.join(tmpRoot, "SYM-1");
    try {
      mgr.assertCwdMatchesWorkspace("/somewhere/else", wsPath);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceSafetyError);
      expect((err as WorkspaceSafetyError).category).toBe("invalid_workspace_cwd");
    }
  });
});

describe("hooks (FR-WS-2)", () => {
  it("treats an unconfigured before_run as success (skipped)", async () => {
    const { logger } = makeLogger();
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig(),
      logger,
    });
    const ws = await mgr.ensureWorkspace(makeIssue());
    const outcome = await mgr.runBeforeRun(ws, makeIssue());
    expect(outcome).toEqual({ ok: true, skipped: true });
  });

  it("runs before_run with workspace as cwd and the configured timeout", async () => {
    const { logger } = makeLogger();
    const { runner, calls } = stubHookRunner({
      ok: true,
      code: 0,
      timedOut: false,
      stdout: "done",
      stderr: "",
      error: "",
    });
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig({ before_run: "echo hi", timeout_ms: 4321 }),
      logger,
      hookRunner: runner,
    });
    const ws = await mgr.ensureWorkspace(makeIssue());
    const outcome = await mgr.runBeforeRun(ws, makeIssue());
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(ws.path);
    expect(calls[0]?.timeoutMs).toBe(4321);
    expect(calls[0]?.script).toBe("echo hi");
  });

  it("before_run failure returns ok=false so the attempt aborts", async () => {
    const { logger, sink } = makeLogger();
    const { runner } = stubHookRunner({
      ok: false,
      code: 1,
      timedOut: false,
      stdout: "",
      stderr: "boom",
      error: "hook exited with code 1",
    });
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig({ before_run: "exit 1" }),
      logger,
      hookRunner: runner,
    });
    const ws = await mgr.ensureWorkspace(makeIssue());
    const outcome = await mgr.runBeforeRun(ws, makeIssue());
    expect(outcome.ok).toBe(false);
    const rec = sink.records.find((r) => r.event === "hook_failed");
    expect(rec?.level).toBe("error");
    expect(rec?.context.fatal).toBe(true);
  });

  it("after_run failure is logged at warn and ignored (non-fatal)", async () => {
    const { logger, sink } = makeLogger();
    const { runner } = stubHookRunner({
      ok: false,
      code: null,
      timedOut: true,
      stdout: "",
      stderr: "",
      error: "hook timed out after 1000ms",
    });
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig({ after_run: "sleep 100" }),
      logger,
      hookRunner: runner,
    });
    const ws = await mgr.ensureWorkspace(makeIssue());
    const outcome = await mgr.runAfterRun(ws, makeIssue());
    expect(outcome.ok).toBe(false);
    const rec = sink.records.find((r) => r.event === "hook_failed");
    expect(rec?.level).toBe("warn");
    expect(rec?.context.fatal).toBe(false);
  });
});

describe("removeWorkspace", () => {
  it("removes the workspace directory and is idempotent", async () => {
    const { logger } = makeLogger();
    const mgr = new WorkspaceManagerImpl({
      root: tmpRoot,
      hooks: hooksConfig(),
      logger,
    });
    const ws = await mgr.ensureWorkspace(makeIssue({ identifier: "SYM-rm" }));
    expect(fs.existsSync(ws.path)).toBe(true);
    await mgr.removeWorkspace(ws.workspace_key);
    expect(fs.existsSync(ws.path)).toBe(false);
    // Second removal does not throw.
    await expect(mgr.removeWorkspace(ws.workspace_key)).resolves.toBeUndefined();
  });
});
