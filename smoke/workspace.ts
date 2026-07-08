/**
 * smoke:workspace — evidence that the Workspace Manager (SYM-005 / ARK-53) does
 * its real job (§9):
 *   1. creates a per-issue directory under `workspace.root`, then reuses it
 *      (`created_now` flips true → false) — FR10;
 *   2. proves the three mandatory safety invariants (§9.5) as explicit checks:
 *      A — agent `cwd == workspace_path`            (FR11)
 *      B — workspace path stays within the root     (FR12)
 *      C — workspace key sanitized to [A-Za-z0-9._-] (FR13)
 *
 * Usage: `tsx smoke/workspace.ts`
 */

import { mkdtempSync, existsSync } from "node:fs";
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

  const ok = createReuseOk && aPass && bPass && cPass;
  console.log(
    `\n[smoke:workspace] done — ${ok ? "PASS" : "FAIL"}: create/reuse + safety invariants A/B/C.`,
  );
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(`[smoke:workspace] FAILED: ${(error as Error).message}`);
  process.exit(1);
});
