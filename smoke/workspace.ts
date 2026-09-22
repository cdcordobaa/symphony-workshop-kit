/**
 * smoke:workspace — evidence that the Workspace Manager (SYM-005 / ARK-53) does
 * its real job (§9):
 *   1. creates a per-issue directory under `workspace.root`, then reuses it
 *      (`created_now` flips true → false) — FR10;
 *   2. proves the three mandatory safety invariants (§9.5) as explicit checks:
 *      A — agent `cwd == workspace_path`            (FR11)
 *      B — workspace path stays within the root     (FR12)
 *      C — workspace key sanitized to [A-Za-z0-9._-] (FR13)
 *   3. executes the §9.4 lifecycle hooks (DEV-6): `after_create` populates a newly
 *      created workspace and is skipped on reuse, a hanging hook is killed at
 *      `hooks.timeout_ms`, a failing `after_create` aborts preparation, and
 *      `before_remove` runs before deletion.
 *
 * Usage: `tsx smoke/workspace.ts`
 */

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServiceConfig } from "../src/domain/types.js";
import { createLogger } from "../src/observability/logger.js";
import { isWorkspaceError } from "../src/workspace/errors.js";
import { createWorkspaceManager } from "../src/workspace/manager.js";
import {
  assertCwdIsWorkspace,
  assertWithinRoot,
  sanitizeWorkspaceKey,
} from "../src/workspace/safety.js";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "symphony-smoke-ws-"));
  const config = { workspace: { root } } as ServiceConfig;
  const logger = createLogger({ format: "text" });
  const mgr = createWorkspaceManager({ config, logger });

  console.log("[smoke:workspace] 1) create-or-reuse per-issue directory (FR10)\n");
  const first = await mgr.prepare("ARK-53");
  const second = await mgr.prepare("ARK-53");
  const createReuseOk =
    first.created_now === true &&
    second.created_now === false &&
    first.path === second.path &&
    existsSync(first.path);
  console.log(`  root:          ${root}`);
  console.log(`  workspace:     ${first.path}`);
  console.log(`  created_now:   ${first.created_now} then ${second.created_now}`);
  console.log(`  create/reuse:  ${createReuseOk ? "PASS" : "FAIL"}`);

  console.log("\n[smoke:workspace] 2) safety invariants (§9.5)\n");

  // Invariant A — cwd == workspace path.
  let aPass = false;
  try {
    assertCwdIsWorkspace(first.path, first.path); // positive
    try {
      assertCwdIsWorkspace(resolve(root, "elsewhere"), first.path); // negative
    } catch (err) {
      aPass = isWorkspaceError(err) && err.code === "safety_cwd_mismatch";
    }
  } catch {
    aPass = false;
  }
  console.log(`  A cwd == workspace_path:        ${aPass ? "PASS" : "FAIL"}`);

  // Invariant B — containment within the normalized absolute root.
  let bPass = false;
  try {
    assertWithinRoot(root, "ARK-53"); // positive
    try {
      assertWithinRoot(root, "../escape"); // negative
    } catch (err) {
      bPass = isWorkspaceError(err) && err.code === "safety_root_escape";
    }
  } catch {
    bPass = false;
  }
  console.log(`  B path within workspace root:   ${bPass ? "PASS" : "FAIL"}`);

  // Invariant C — key sanitized to [A-Za-z0-9._-].
  const sanitized = sanitizeWorkspaceKey("feat/ARK 53:go");
  const cPass = sanitized === "feat_ARK_53_go" && /^[A-Za-z0-9._-]+$/.test(sanitized);
  console.log(`  C key sanitized:                ${cPass ? "PASS" : "FAIL"}  ("feat/ARK 53:go" -> "${sanitized}")`);

  await mgr.remove("ARK-53");

  console.log("\n[smoke:workspace] 3) workspace lifecycle hooks (§9.4)\n");
  const hooksOk = await hooksSection(logger);

  const ok = createReuseOk && aPass && bPass && cPass && hooksOk;
  console.log(
    `\n[smoke:workspace] done — ${ok ? "PASS" : "FAIL"}: create/reuse + safety invariants A/B/C + §9.4 hooks.`,
  );
  if (!ok) process.exit(1);
}

/**
 * §9.4 hooks (DEV-6): run the four behaviors that matter for real workspace
 * population — create runs the hook, reuse does not, a hang is killed at the
 * timeout, a failure aborts preparation, and `before_remove` runs before deletion.
 */
async function hooksSection(logger: ReturnType<typeof createLogger>): Promise<boolean> {
  const hooksConfig = (root: string, hooks: Record<string, unknown>): ServiceConfig =>
    ({
      workspace: { root },
      hooks: {
        after_create: null,
        before_run: null,
        after_run: null,
        before_remove: null,
        timeout_ms: 10_000,
        ...hooks,
      },
    }) as ServiceConfig;

  // after_create populates on create, and is NOT re-run on reuse.
  const populateRoot = mkdtempSync(join(tmpdir(), "symphony-smoke-hook-"));
  const populate = createWorkspaceManager({
    config: hooksConfig(populateRoot, {
      after_create: "pwd -P > hook-cwd.txt; echo populated >> runs.txt",
    }),
    logger,
  });
  const ws = await populate.prepare("DEV-6");
  await populate.prepare("DEV-6"); // reuse — must not re-run the hook
  const runs = readFileSync(join(ws.path, "runs.txt"), "utf8").trim().split("\n");
  const hookCwd = readFileSync(join(ws.path, "hook-cwd.txt"), "utf8").trim();
  const createOk = runs.length === 1 && hookCwd === resolve(hookCwd);
  console.log(`  after_create on create:         ${createOk ? "PASS" : "FAIL"}  (ran ${runs.length}x; cwd=${hookCwd})`);

  // A hanging hook is killed at hooks.timeout_ms and fails preparation.
  const hangRoot = mkdtempSync(join(tmpdir(), "symphony-smoke-hook-"));
  const hang = createWorkspaceManager({
    config: hooksConfig(hangRoot, { after_create: "sleep 30", timeout_ms: 300 }),
    logger,
  });
  const hangStart = Date.now();
  let timeoutOk = false;
  try {
    await hang.prepare("DEV-6");
  } catch (err) {
    timeoutOk = isWorkspaceError(err) && err.code === "hook_timeout";
  }
  const hangElapsed = Date.now() - hangStart;
  timeoutOk = timeoutOk && hangElapsed < 5_000 && !existsSync(resolve(hangRoot, "DEV-6"));
  console.log(`  hanging hook killed at timeout:  ${timeoutOk ? "PASS" : "FAIL"}  (${hangElapsed}ms, timeout_ms=300)`);

  // A failing after_create aborts preparation (no agent in a half-built workspace).
  const failRoot = mkdtempSync(join(tmpdir(), "symphony-smoke-hook-"));
  const failing = createWorkspaceManager({
    config: hooksConfig(failRoot, { after_create: "exit 3" }),
    logger,
  });
  let failOk = false;
  try {
    await failing.prepare("DEV-6");
  } catch (err) {
    failOk = isWorkspaceError(err) && err.code === "hook_failed";
  }
  failOk = failOk && !existsSync(resolve(failRoot, "DEV-6"));
  console.log(`  failing after_create aborts prep:${failOk ? " PASS" : " FAIL"}  (workspace rolled back)`);

  // before_remove runs before deletion; its evidence is written outside the workspace.
  const removeRoot = mkdtempSync(join(tmpdir(), "symphony-smoke-hook-"));
  const evidence = join(mkdtempSync(join(tmpdir(), "symphony-smoke-hook-")), "before-remove.txt");
  const removing = createWorkspaceManager({
    config: hooksConfig(removeRoot, { before_remove: `ls hook-cwd.txt > ${JSON.stringify(evidence)}` }),
    logger,
  });
  const doomed = await removing.prepare("DEV-6");
  writeFileSync(join(doomed.path, "hook-cwd.txt"), "x", "utf8");
  await removing.remove("DEV-6");
  const removeOk =
    existsSync(evidence) &&
    readFileSync(evidence, "utf8").trim() === "hook-cwd.txt" &&
    !existsSync(doomed.path);
  console.log(`  before_remove then delete:       ${removeOk ? "PASS" : "FAIL"}`);

  return createOk && timeoutOk && failOk && removeOk;
}

main().catch((error) => {
  console.error(`[smoke:workspace] FAILED: ${(error as Error).message}`);
  process.exit(1);
});
