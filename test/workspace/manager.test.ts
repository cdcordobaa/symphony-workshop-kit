/**
 * Workspace Manager (§9.2) — create-or-reuse behavior and the safety invariants
 * enforced end-to-end through the port surface.
 */

import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import type { ServiceConfig } from "../../src/domain/types.js";
import { isWorkspaceError } from "../../src/workspace/errors.js";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
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
