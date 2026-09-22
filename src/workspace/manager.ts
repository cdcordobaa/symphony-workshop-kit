/**
 * Workspace Manager (Symphony spec §9, Unit 1.4).
 *
 * Owns the per-issue workspace lifecycle: it derives a deterministic path under
 * the normalized absolute `workspace.root`, creates the directory or reuses an
 * existing one, runs the §9.4 lifecycle hooks around those transitions, and
 * guards every path with the three mandatory safety invariants (§9.5). It
 * implements the {@link WorkspaceManager} port defined in ARK-49.
 *
 * Hooks (§9.4, DEV-6):
 *   - `after_create` runs exactly once, only when the directory was newly created
 *     (never on reuse). A failure or timeout is FATAL to workspace preparation —
 *     `prepare` rolls the half-built directory back and throws, so no agent ever
 *     runs in a workspace whose population did not complete.
 *   - `before_remove` runs immediately before deletion during terminal cleanup.
 *     A failure or timeout is logged and IGNORED; removal proceeds regardless.
 *
 * Scope note (PRD §5.3): `before_run` / `after_run` remain parsed-and-ignored.
 * Launching the agent is ARK-54 (which re-checks invariant A against the real
 * subprocess cwd).
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { HooksConfig, ServiceConfig } from "../domain/types.js";
import type { Logger, Workspace, WorkspaceManager } from "../domain/interfaces.js";
import { WorkspaceError } from "./errors.js";
import { DEFAULT_HOOK_TIMEOUT_MS, runWorkspaceHook, type HookSpawner } from "./hooks.js";
import { assertCwdIsWorkspace, assertWithinRoot, sanitizeWorkspaceKey } from "./safety.js";

/** Dependencies for {@link createWorkspaceManager}. */
export interface WorkspaceManagerDeps {
  /** Typed runtime config; `workspace.root` and `hooks.*` are consulted here (§9.1, §9.4). */
  config: ServiceConfig;
  /** Optional structured logger. When present, prepare/remove/hooks emit audit lines. */
  logger?: Logger;
  /** Injectable hook spawner (tests). Defaults to a real `bash -lc` subprocess. */
  spawnHook?: HookSpawner;
}

/**
 * Create a {@link WorkspaceManager} bound to `config.workspace.root`.
 *
 * The root is normalized to an absolute path once, up front; every per-issue path
 * is then derived from it and re-validated for containment (invariant B) on every
 * call, so a caller cannot smuggle a traversal through the identifier.
 */
export function createWorkspaceManager(deps: WorkspaceManagerDeps): WorkspaceManager {
  const { config, logger, spawnHook } = deps;
  // §9.1: workspace root is a normalized absolute path. config resolution already
  // normalizes it; we re-resolve defensively so this holds regardless of caller.
  const root = resolve(config.workspace.root);
  // `hooks` is optional on partially-built configs (tests, embedders): absent hooks
  // simply mean "nothing to run", never a crash.
  const hooks: Partial<HooksConfig> = config.hooks ?? {};
  const hookTimeoutMs = hooks.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS;

  /**
   * Deterministic absolute workspace path for an identifier (§9.2 steps 1–2).
   * Applies invariant C (sanitize) then invariant B (containment) before returning.
   */
  function workspacePathFor(identifier: string): string {
    const workspace_key = sanitizeWorkspaceKey(identifier); // invariant C
    return assertWithinRoot(root, workspace_key); // invariant B (returns absolute path)
  }

  return {
    workspacePathFor,

    /** Create-or-reuse the per-issue workspace, running `after_create` on create (§9.2, §9.4). */
    async prepare(identifier: string): Promise<Workspace> {
      const workspace_key = sanitizeWorkspaceKey(identifier); // invariant C
      const path = assertWithinRoot(root, workspace_key); // invariant B

      const created_now = await ensureDirectory(path);
      logger?.info(created_now ? "workspace created" : "workspace reused", {
        issue_identifier: identifier,
        action: "workspace_prepare",
        outcome: created_now ? "created" : "reused",
        workspace_key,
        workspace_path: path,
      });

      // §9.4: `after_create` runs ONLY for a freshly created workspace — a reused
      // one is already populated and re-running the hook would be destructive.
      const script = hookScript(hooks.after_create);
      if (created_now && script !== null) {
        const result = await runWorkspaceHook({
          hook: "after_create",
          script,
          cwd: path, // invariant A holds for hooks too: they run INSIDE the workspace.
          timeoutMs: hookTimeoutMs,
          spawn: spawnHook,
          logger,
          issueIdentifier: identifier,
        });

        if (result.outcome !== "ok") {
          // Fatal to workspace creation (§9.4). Roll the directory back so the next
          // `prepare` re-creates it and re-runs the hook instead of silently reusing
          // a half-populated workspace.
          await rollbackCreatedWorkspace(path, identifier, logger);
          throw new WorkspaceError(
            result.outcome === "timeout" ? "hook_timeout" : "hook_failed",
            `after_create hook ${result.outcome} for workspace ${JSON.stringify(path)}` +
              ` (exit_code=${String(result.exit_code)}, duration_ms=${result.duration_ms});` +
              ` workspace preparation aborted.`,
          );
        }
      }

      return { path, workspace_key, created_now };
    },

    /**
     * Remove a per-issue workspace, running `before_remove` first (§9.4). A hook
     * failure or timeout is logged and ignored — removal always proceeds. A missing
     * directory is a no-op (and skips the hook, which has no `cwd` to run in). The
     * path is re-validated for containment so a bug elsewhere can never turn
     * removal into a delete outside the root.
     */
    async remove(identifier: string): Promise<void> {
      const workspace_key = sanitizeWorkspaceKey(identifier); // invariant C
      const path = assertWithinRoot(root, workspace_key); // invariant B

      const script = hookScript(hooks.before_remove);
      if (script !== null && (await isDirectory(path))) {
        // Outcome is intentionally not inspected: §9.4 says log and ignore.
        await runWorkspaceHook({
          hook: "before_remove",
          script,
          cwd: path,
          timeoutMs: hookTimeoutMs,
          spawn: spawnHook,
          logger,
          issueIdentifier: identifier,
        });
      }

      try {
        await rm(path, { recursive: true, force: true });
        logger?.info("workspace removed", {
          issue_identifier: identifier,
          action: "workspace_remove",
          outcome: "removed",
          workspace_key,
          workspace_path: path,
        });
      } catch (error) {
        throw new WorkspaceError(
          "workspace_io_error",
          `failed to remove workspace ${JSON.stringify(path)}: ${(error as Error).message}`,
          error,
        );
      }
    },
  };
}

/**
 * Invariant A guard, re-exported at the manager surface for the launch site
 * (ARK-54): assert the resolved `cwd` a subprocess will use equals `workspacePath`.
 */
export { assertCwdIsWorkspace };

/* --------------------------------------------------------------------------- */

/** A hook script worth running: configured and not blank. Otherwise `null`. */
function hookScript(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.trim().length === 0 ? null : value;
}

/** `true` when `path` exists and is a directory; `false` for anything else. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Best-effort rollback of a workspace whose `after_create` hook failed. The path
 * has already passed invariants B and C, and was created by this very call, so
 * this can only delete inside the workspace root. A rollback failure is logged and
 * swallowed: the caller is already failing preparation with the hook error, which
 * is the more useful diagnosis.
 */
async function rollbackCreatedWorkspace(
  path: string,
  identifier: string,
  logger?: Logger,
): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    logger?.info("workspace rolled back after failed after_create hook", {
      issue_identifier: identifier,
      action: "workspace_rollback",
      outcome: "removed",
      workspace_path: path,
    });
  } catch (error) {
    logger?.warn("workspace rollback failed (ignored)", {
      issue_identifier: identifier,
      action: "workspace_rollback",
      outcome: "failed",
      workspace_path: path,
      error: (error as Error)?.message ?? String(error),
    });
  }
}

/**
 * Ensure `path` exists as a directory. Returns `true` iff the directory was
 * created during this call (§9.2 step 4 — the `created_now` flag that gates
 * `after_create`), `false` if an existing directory was reused.
 */
async function ensureDirectory(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    if (!st.isDirectory()) {
      throw new WorkspaceError(
        "workspace_io_error",
        `workspace path ${JSON.stringify(path)} exists but is not a directory.`,
      );
    }
    return false; // reused
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        "workspace_io_error",
        `failed to stat workspace ${JSON.stringify(path)}: ${(error as Error).message}`,
        error,
      );
    }
    // Directory does not exist yet — create it (and any missing parents up to root).
    try {
      await mkdir(path, { recursive: true });
    } catch (mkdirError) {
      throw new WorkspaceError(
        "workspace_io_error",
        `failed to create workspace ${JSON.stringify(path)}: ${(mkdirError as Error).message}`,
        mkdirError,
      );
    }
    return true; // created
  }
}
