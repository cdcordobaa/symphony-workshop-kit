/**
 * Workspace Manager (Symphony spec §9, Unit 1.4).
 *
 * Owns the per-issue workspace lifecycle: it derives a deterministic path under
 * the normalized absolute `workspace.root`, creates the directory or reuses an
 * existing one, and guards every path with the three mandatory safety invariants
 * (§9.5). It implements the {@link WorkspaceManager} port defined in ARK-49.
 *
 * Scope note (PRD §5.3): `after_create` / `before_remove` hooks, workspace
 * population, and the startup terminal-workspace cleanup sweep are deferred to a
 * later unit. This manager only prepares and guards the workspace; launching the
 * agent is ARK-54 (which re-checks invariant A against the real subprocess cwd).
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServiceConfig } from "../domain/types.js";
import type { Logger, Workspace, WorkspaceManager } from "../domain/interfaces.js";
import { WorkspaceError } from "./errors.js";
import { assertCwdIsWorkspace, assertWithinRoot, sanitizeWorkspaceKey } from "./safety.js";

/** Dependencies for {@link createWorkspaceManager}. */
export interface WorkspaceManagerDeps {
  /** Typed runtime config; only `workspace.root` is consulted here (§9.1). */
  config: ServiceConfig;
  /** Optional structured logger. When present, prepare/remove emit an audit line. */
  logger?: Logger;
}

/**
 * Create a {@link WorkspaceManager} bound to `config.workspace.root`.
 *
 * The root is normalized to an absolute path once, up front; every per-issue path
 * is then derived from it and re-validated for containment (invariant B) on every
 * call, so a caller cannot smuggle a traversal through the identifier.
 */
export function createWorkspaceManager(deps: WorkspaceManagerDeps): WorkspaceManager {
  const { config, logger } = deps;
  // §9.1: workspace root is a normalized absolute path. config resolution already
  // normalizes it; we re-resolve defensively so this holds regardless of caller.
  const root = resolve(config.workspace.root);

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

    /** Create-or-reuse the per-issue workspace (§9.2). */
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
      // NOTE: after_create hook (§9.4) intentionally NOT run here — deferred (PRD §5.3).
      return { path, workspace_key, created_now };
    },

    /**
     * Remove a per-issue workspace. `before_remove` hooks are deferred (PRD §5.3);
     * a missing directory is a no-op. The path is re-validated for containment so a
     * bug elsewhere can never turn removal into a delete outside the root.
     */
    async remove(identifier: string): Promise<void> {
      const workspace_key = sanitizeWorkspaceKey(identifier); // invariant C
      const path = assertWithinRoot(root, workspace_key); // invariant B
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
