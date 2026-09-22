/**
 * Workspace Manager (§9.2) — create-or-reuse behavior, the §9.4 lifecycle hooks
 * (after_create / before_remove), and the safety invariants enforced end-to-end
 * through the port surface.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import type { HooksConfig, ServiceConfig } from "../../src/domain/types.js";
import { isWorkspaceError } from "../../src/workspace/errors.js";
import type { HookProcess } from "../../src/workspace/hooks.js";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
import { captureLogger } from "../orchestrator/fakes.js";
import { tempDir } from "../helpers.js";

/** Minimal ServiceConfig — the manager consults only `workspace.root`. */
function configWithRoot(root: string): ServiceConfig {
  return { workspace: { root } } as ServiceConfig;
}

test("prepare creates a per-issue directory under workspace.root [FR10]", async () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({ config: configWithRoot(root) });

  const ws = await mgr.prepare("ARK-53");

  assert.equal(ws.workspace_key, "ARK-53");
  assert.equal(ws.path, resolve(root, "ARK-53"));
  assert.equal(ws.created_now, true);
  assert.ok(ws.path.startsWith(root + sep), "path is under the root");
  assert.ok(existsSync(ws.path) && statSync(ws.path).isDirectory(), "directory exists");
});

test("prepare reuses an existing directory (created_now=false) [FR10]", async () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({ config: configWithRoot(root) });

  const first = await mgr.prepare("ARK-53");
  const second = await mgr.prepare("ARK-53");

  assert.equal(first.created_now, true);
  assert.equal(second.created_now, false);
  assert.equal(second.path, first.path);
});

test("prepare sanitizes the identifier into the directory name (Safety C) [FR13]", async () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({ config: configWithRoot(root) });

  const ws = await mgr.prepare("feat/ARK 53:go");

  assert.equal(ws.workspace_key, "feat_ARK_53_go");
  assert.equal(ws.path, resolve(root, "feat_ARK_53_go"));
  assert.ok(existsSync(ws.path));
});

test("prepare rejects a traversal identifier as a safety violation (Safety B/C) [FR12/FR13]", async () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({ config: configWithRoot(root) });

  // `..` is a traversal attempt. Sanitization (C) rejects it first as an unusable
  // key; a survivor would be caught by containment (B). Either way it must never
  // resolve to a directory outside the root.
  await assert.rejects(
    () => mgr.prepare(".."),
    (err: unknown) =>
      isWorkspaceError(err) &&
      (err.code === "safety_invalid_key" || err.code === "safety_root_escape"),
  );
});

test("workspacePathFor is deterministic and contained [FR11/FR12]", () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({ config: configWithRoot(root) });

  const p1 = mgr.workspacePathFor("ARK-53");
  const p2 = mgr.workspacePathFor("ARK-53");
  assert.equal(p1, p2);
  assert.equal(p1, resolve(root, "ARK-53"));
});

test("remove deletes the workspace and is a no-op when already absent", async () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({ config: configWithRoot(root) });

  const ws = await mgr.prepare("ARK-53");
  assert.ok(existsSync(ws.path));

  await mgr.remove("ARK-53");
  assert.ok(!existsSync(ws.path), "directory removed");

  // second remove must not throw (force: true)
  await assert.doesNotReject(() => mgr.remove("ARK-53"));
});

/* --------------------------------------------------------------------------- *
 * §9.4 workspace lifecycle hooks (DEV-6).
 * --------------------------------------------------------------------------- */

/** ServiceConfig with `workspace.root` plus the hooks under test. */
function configWithHooks(root: string, hooks: Partial<HooksConfig>): ServiceConfig {
  return {
    workspace: { root },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 10_000,
      ...hooks,
    },
  } as ServiceConfig;
}

test("after_create runs on create, inside the workspace directory [§9.4]", async () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({
    config: configWithHooks(root, { after_create: "pwd -P > where.txt\necho populated > README.md" }),
  });

  const ws = await mgr.prepare("DEV-6");

  assert.equal(ws.created_now, true);
  assert.ok(existsSync(join(ws.path, "README.md")), "after_create populated the workspace");
  // Invariant A extends to hooks: the hook's cwd IS the per-issue workspace path.
  assert.equal(readFileSync(join(ws.path, "where.txt"), "utf8").trim(), realpathSync(ws.path));
});

test("after_create does NOT run when an existing workspace is reused [§9.4]", async () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({
    config: configWithHooks(root, { after_create: "echo ran >> runs.txt" }),
  });

  const first = await mgr.prepare("DEV-6");
  const second = await mgr.prepare("DEV-6");

  assert.equal(first.created_now, true);
  assert.equal(second.created_now, false);
  const runs = readFileSync(join(first.path, "runs.txt"), "utf8").trim().split("\n");
  assert.deepEqual(runs, ["ran"], "the hook ran exactly once, on create only");
});

test("after_create is invoked as `bash -lc` with cwd == the workspace path [§9.4/FR11]", async () => {
  const root = tempDir();
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const mgr = createWorkspaceManager({
    config: configWithHooks(root, { after_create: "git clone --depth 1 $REPO ." }),
    spawnHook: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return okProcess();
    },
  });

  const ws = await mgr.prepare("DEV-6");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "bash");
  assert.deepEqual(calls[0]?.args, ["-lc", "git clone --depth 1 $REPO ."]);
  assert.equal(calls[0]?.cwd, ws.path);
  assert.equal(calls[0]?.cwd, mgr.workspacePathFor("DEV-6"));

  // Reuse must not spawn a second time.
  await mgr.prepare("DEV-6");
  assert.equal(calls.length, 1);
});

test("a failing after_create aborts workspace preparation [§9.4]", async () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({
    config: configWithHooks(root, { after_create: "exit 3" }),
  });

  await assert.rejects(
    () => mgr.prepare("DEV-6"),
    (err: unknown) =>
      isWorkspaceError(err) && err.code === "hook_failed" && /exit_code=3/.test(err.message),
  );

  // Rolled back, so a later attempt re-creates and re-runs the hook rather than
  // silently reusing a half-built workspace.
  assert.equal(existsSync(resolve(root, "DEV-6")), false, "half-built workspace removed");
});

test("a hanging after_create is killed at hooks.timeout_ms and aborts preparation [§9.4]", async () => {
  const root = tempDir();
  const marker = join(root, "hook-finished.txt");
  const mgr = createWorkspaceManager({
    config: configWithHooks(root, {
      after_create: `sleep 5; touch ${JSON.stringify(marker)}`,
      timeout_ms: 150,
    }),
  });

  const started = Date.now();
  await assert.rejects(
    () => mgr.prepare("DEV-6"),
    (err: unknown) => isWorkspaceError(err) && err.code === "hook_timeout",
  );
  assert.ok(Date.now() - started < 4_000, "prepare failed at the deadline, not after the hook");
  assert.equal(existsSync(resolve(root, "DEV-6")), false, "half-built workspace removed");

  await new Promise((r) => setTimeout(r, 800));
  assert.equal(existsSync(marker), false, "the timed-out hook was actually killed");
});

test("before_remove runs before the workspace is deleted [§9.4]", async () => {
  const root = tempDir();
  const evidence = join(tempDir(), "before-remove.txt"); // outside the doomed workspace
  const mgr = createWorkspaceManager({
    config: configWithHooks(root, {
      // Records that the workspace still existed when the hook ran.
      before_remove: `ls HELLO.md > ${JSON.stringify(evidence)}`,
    }),
  });

  const ws = await mgr.prepare("DEV-6");
  writeFileSync(join(ws.path, "HELLO.md"), "hi", "utf8");

  await mgr.remove("DEV-6");

  assert.equal(readFileSync(evidence, "utf8").trim(), "HELLO.md");
  assert.equal(existsSync(ws.path), false, "workspace removed");
});

test("a failing before_remove is logged and removal still proceeds [§9.4]", async () => {
  const root = tempDir();
  const { logger, records } = captureLogger();
  const mgr = createWorkspaceManager({
    config: configWithHooks(root, { before_remove: "exit 7" }),
    logger,
  });

  const ws = await mgr.prepare("DEV-6");
  await assert.doesNotReject(() => mgr.remove("DEV-6"));

  assert.equal(existsSync(ws.path), false, "removal proceeded despite the hook failure");
  const failed = records.find(
    (r) => r.message === "workspace hook failed" && r.context["hook"] === "before_remove",
  );
  assert.equal(failed?.context["exit_code"], 7);
});

test("a hanging before_remove times out without blocking removal [§9.4]", async () => {
  const root = tempDir();
  const mgr = createWorkspaceManager({
    config: configWithHooks(root, { before_remove: "sleep 5", timeout_ms: 150 }),
  });

  const ws = await mgr.prepare("DEV-6");
  const started = Date.now();
  await mgr.remove("DEV-6");

  assert.ok(Date.now() - started < 4_000, "removal did not wait for the hanging hook");
  assert.equal(existsSync(ws.path), false, "workspace removed");
});

test("before_remove is skipped when there is no workspace to remove [§9.4]", async () => {
  const root = tempDir();
  let spawned = 0;
  const mgr = createWorkspaceManager({
    config: configWithHooks(root, { before_remove: "echo hi" }),
    spawnHook: () => {
      spawned += 1;
      return okProcess();
    },
  });

  await assert.doesNotReject(() => mgr.remove("DEV-6"));
  assert.equal(spawned, 0, "no hook for a workspace that does not exist");
});

test("blank or absent hooks are not executed [§9.4]", async () => {
  const root = tempDir();
  let spawned = 0;
  const spawnHook = () => {
    spawned += 1;
    return okProcess();
  };

  const blank = createWorkspaceManager({
    config: configWithHooks(root, { after_create: "   \n  ", before_remove: "" }),
    spawnHook,
  });
  await blank.prepare("DEV-6");
  await blank.remove("DEV-6");

  // A config without a `hooks` block at all (embedders/tests) must not crash.
  const none = createWorkspaceManager({ config: configWithRoot(root), spawnHook });
  const ws = await none.prepare("DEV-7");
  assert.equal(ws.created_now, true);
  await none.remove("DEV-7");

  assert.equal(spawned, 0);
});

/** A stub hook process that closes successfully on the next tick. */
function okProcess(): HookProcess {
  const listeners: { close?: (code: number | null) => void } = {};
  const proc = {
    stdout: null,
    stderr: null,
    on(event: string, listener: (code: number | null) => void) {
      if (event === "close") listeners.close = listener;
    },
    kill: () => true,
  } as unknown as HookProcess;
  setImmediate(() => listeners.close?.(0));
  return proc;
}
