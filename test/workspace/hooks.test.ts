/**
 * Workspace lifecycle hook execution (§9.4, DEV-6) — the shell contract itself:
 * cwd, `bash -lc`, timeout enforcement, exit-code reporting, and the logging /
 * secret-hygiene rules. Manager-level failure semantics live in manager.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  runWorkspaceHook,
  type HookProcess,
  type HookSpawner,
} from "../../src/workspace/hooks.js";
import { captureLogger } from "../orchestrator/fakes.js";
import { tempDir } from "../helpers.js";

test("a hook runs in the workspace directory and reports ok [§9.4]", async () => {
  const cwd = tempDir();

  const result = await runWorkspaceHook({
    hook: "after_create",
    script: "pwd -P > where.txt",
    cwd,
    timeoutMs: 10_000,
  });

  assert.equal(result.outcome, "ok");
  assert.equal(result.exit_code, 0);
  assert.ok(result.duration_ms >= 0);
  assert.equal(readFileSync(join(cwd, "where.txt"), "utf8").trim(), realpathSync(cwd));
});

test("a non-zero hook is reported as failed with its exit code [§9.4]", async () => {
  const result = await runWorkspaceHook({
    hook: "after_create",
    script: "exit 3",
    cwd: tempDir(),
    timeoutMs: 10_000,
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.exit_code, 3);
});

test("a hanging hook is killed at hooks.timeout_ms and reported as a timeout [§9.4]", async () => {
  const cwd = tempDir();
  const marker = join(cwd, "finished.txt");

  const started = Date.now();
  const result = await runWorkspaceHook({
    hook: "after_create",
    script: `sleep 5; touch ${JSON.stringify(marker)}`,
    cwd,
    timeoutMs: 150,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, "timeout");
  assert.equal(result.exit_code, null);
  assert.ok(elapsed < 4_000, `returned at the deadline, not after the hook (elapsed=${elapsed}ms)`);

  // The hook was actually killed: its post-sleep side effect never happens.
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(existsSync(marker), false, "killed hook produced no side effect");
});

test("a hook is invoked as `bash -lc <script>` with cwd = the workspace [§9.4]", async () => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const spawn: HookSpawner = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return stubProcess({ closeWith: 0 });
  };

  const result = await runWorkspaceHook({
    hook: "before_remove",
    script: "echo hi",
    cwd: "/tmp/symphony-ws/DEV-6",
    timeoutMs: 1_000,
    spawn,
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(calls, [
    { command: "bash", args: ["-lc", "echo hi"], cwd: "/tmp/symphony-ws/DEV-6" },
  ]);
});

test("a spawn failure is reported as failed, never thrown [§9.4]", async () => {
  const emitError: HookSpawner = () => stubProcess({ errorWith: new Error("bash not found") });
  const throwing: HookSpawner = () => {
    throw new Error("spawn EACCES");
  };

  const emitted = await runWorkspaceHook({
    hook: "after_create",
    script: "true",
    cwd: tempDir(),
    timeoutMs: 1_000,
    spawn: emitError,
  });
  assert.equal(emitted.outcome, "failed");
  assert.equal(emitted.exit_code, null);
  assert.match(String(emitted.error), /bash not found/);

  const thrown = await runWorkspaceHook({
    hook: "after_create",
    script: "true",
    cwd: tempDir(),
    timeoutMs: 1_000,
    spawn: throwing,
  });
  assert.equal(thrown.outcome, "failed");
  assert.match(String(thrown.error), /spawn EACCES/);
});

test("an unset or invalid timeout falls back to the §9.4 default", async () => {
  const { logger, records } = captureLogger();

  const result = await runWorkspaceHook({
    hook: "after_create",
    script: "true",
    cwd: tempDir(),
    timeoutMs: 0, // invalid -> default, so this must NOT time out instantly
    logger,
  });

  assert.equal(result.outcome, "ok");
  const start = records.find((r) => r.message === "workspace hook start");
  assert.equal(start?.context["timeout_ms"], DEFAULT_HOOK_TIMEOUT_MS);
});

test("each hook logs action, outcome, exit code and duration [§9.4]", async () => {
  const { logger, records } = captureLogger();

  await runWorkspaceHook({
    hook: "before_remove",
    script: "exit 2",
    cwd: tempDir(),
    timeoutMs: 10_000,
    logger,
    issueIdentifier: "DEV-6",
  });

  const start = records.find((r) => r.message === "workspace hook start");
  assert.equal(start?.context["action"], "workspace_hook");
  assert.equal(start?.context["hook"], "before_remove");

  const done = records.find((r) => r.message === "workspace hook failed");
  assert.equal(done?.level, "warn");
  assert.equal(done?.context["action"], "workspace_hook");
  assert.equal(done?.context["outcome"], "failed");
  assert.equal(done?.context["exit_code"], 2);
  assert.equal(done?.context["issue_identifier"], "DEV-6");
  assert.equal(typeof done?.context["duration_ms"], "number");
});

test("hook stdout/stderr is never logged (secret hygiene, FR21)", async () => {
  const { logger, records } = captureLogger();

  await runWorkspaceHook({
    hook: "after_create",
    script: "echo sk-live-SUPERSECRET; echo sk-live-SUPERSECRET 1>&2",
    cwd: tempDir(),
    timeoutMs: 10_000,
    logger,
  });

  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes("SUPERSECRET"), false, "hook output must not reach the logs");
});

/* --------------------------------------------------------------------------- */

/** A minimal {@link HookProcess} stub: no real subprocess, scripted terminal event. */
function stubProcess(options: { closeWith?: number; errorWith?: Error }): HookProcess {
  const listeners: { close?: (code: number | null) => void; error?: (err: Error) => void } = {};
  const proc: HookProcess = {
    stdout: null,
    stderr: null,
    on(event: string, listener: (arg: never) => void) {
      if (event === "close") listeners.close = listener as (code: number | null) => void;
      if (event === "error") listeners.error = listener as (err: Error) => void;
    },
    kill: () => true,
  } as HookProcess;

  setImmediate(() => {
    if (options.errorWith !== undefined) listeners.error?.(options.errorWith);
    else listeners.close?.(options.closeWith ?? 0);
  });
  return proc;
}
