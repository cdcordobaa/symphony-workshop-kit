/**
 * The three mandatory safety invariants (§9.5, §15.2) — each tested in isolation
 * with a passing case and a violating case, per the ARK-53 acceptance criteria.
 */

import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import { WorkspaceError, isWorkspaceError } from "../../src/workspace/errors.js";
import {
  assertCwdIsWorkspace,
  assertWithinRoot,
  sanitizeWorkspaceKey,
} from "../../src/workspace/safety.js";

/* -------------------------- Invariant C — sanitize ------------------------- */

test("Safety C: an allowed key passes through unchanged [FR13]", () => {
  assert.equal(sanitizeWorkspaceKey("ARK-53"), "ARK-53");
  assert.equal(sanitizeWorkspaceKey("abc_123.v2-final"), "abc_123.v2-final");
});

test("Safety C: characters outside [A-Za-z0-9._-] are replaced with _ [FR13]", () => {
  assert.equal(sanitizeWorkspaceKey("ABC 123"), "ABC_123");
  assert.equal(sanitizeWorkspaceKey("a/b\\c:d"), "a_b_c_d");
  assert.equal(sanitizeWorkspaceKey("issue#42!"), "issue_42_");
});

test("Safety C: an identifier that sanitizes to an unusable key is rejected [FR13]", () => {
  for (const bad of ["", "   ", "..", "."]) {
    assert.throws(
      () => sanitizeWorkspaceKey(bad),
      (err: unknown) => isWorkspaceError(err) && err.code === "safety_invalid_key",
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

/* ------------------------- Invariant B — containment ----------------------- */

test("Safety B: a key resolving inside the root passes and returns an absolute path [FR12]", () => {
  const root = resolve("/srv/symphony/ws");
  const path = assertWithinRoot(root, "ARK-53");
  assert.equal(path, resolve(root, "ARK-53"));
  assert.ok(path.startsWith(root + sep));
});

test("Safety B: a path escaping the root via traversal is rejected [FR12]", () => {
  const root = resolve("/srv/symphony/ws");
  assert.throws(
    () => assertWithinRoot(root, ".."),
    (err: unknown) => isWorkspaceError(err) && err.code === "safety_root_escape",
  );
  assert.throws(
    () => assertWithinRoot(root, "../../etc/passwd"),
    (err: unknown) => isWorkspaceError(err) && err.code === "safety_root_escape",
  );
});

test("Safety B: the root itself is not a valid per-issue workspace [FR12]", () => {
  const root = resolve("/srv/symphony/ws");
  assert.throws(
    () => assertWithinRoot(root, "."),
    (err: unknown) => isWorkspaceError(err) && err.code === "safety_root_escape",
  );
});

test("Safety B: a sibling directory that merely shares the root prefix is rejected [FR12]", () => {
  // `/srv/symphony/ws-evil` starts with the string `/srv/symphony/ws` but is NOT
  // contained in it — the relative-path check must catch this, not a naive prefix.
  const root = resolve("/srv/symphony/ws");
  assert.throws(
    () => assertWithinRoot(root, "../ws-evil"),
    (err: unknown) => isWorkspaceError(err) && err.code === "safety_root_escape",
  );
});

/* ---------------------------- Invariant A — cwd ---------------------------- */

test("Safety A: matching cwd and workspace path passes [FR11]", () => {
  const ws = resolve("/srv/symphony/ws/ARK-53");
  assert.doesNotThrow(() => assertCwdIsWorkspace(ws, ws));
  // equivalent-but-differently-spelled paths are normalized before comparison
  assert.doesNotThrow(() => assertCwdIsWorkspace("/srv/symphony/ws/./ARK-53", ws));
});

test("Safety A: a cwd that differs from the workspace path is rejected [FR11]", () => {
  const ws = resolve("/srv/symphony/ws/ARK-53");
  assert.throws(
    () => assertCwdIsWorkspace(resolve("/tmp/somewhere-else"), ws),
    (err: unknown) =>
      err instanceof WorkspaceError && err.code === "safety_cwd_mismatch",
  );
});
