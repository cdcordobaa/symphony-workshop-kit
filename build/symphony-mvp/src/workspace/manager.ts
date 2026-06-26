/**
 * Workspace Manager (U4; SYMPHONY-SPEC §9, §15.2; requirements.md FR-WS-1..3).
 *
 * Creates / reuses a sanitized per-issue workspace directory under the
 * configured workspace root and ENFORCES the three mandatory filesystem-safety
 * invariants (FR-WS-3 / §9.5 / §15.2):
 *
 *   (a) the coding agent is launched only when `cwd === workspace_path`,
 *   (b) `workspace_path` is contained within the normalized absolute
 *       `workspace_root` (any escape is rejected before launch),
 *   (c) the workspace key is sanitized to `[A-Za-z0-9._-]` (others ⇒ `_`).
 *
 * Invariant (a) is enforced at agent-launch time by the runner via
 * {@link WorkspaceManagerImpl.assertCwdMatchesWorkspace}; invariants (b) and (c)
 * are enforced here, before the directory is ever touched.
 *
 * Also runs the optional `before_run` / `after_run` hooks (FR-WS-2 partial) with
 * the workspace as cwd, bounded by `hooks.timeout_ms`:
 *   - `before_run` failure / timeout is FATAL to the run attempt,
 *   - `after_run` failure / timeout is logged and ignored.
 *
 * Out of scope for the MVP (deferred): `after_create` / `before_remove` hooks and
 * workspace population (FR-WS-2 rest / FR-WS-4).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../obs/log.js";
import { errorMessage } from "../obs/log.js";
import type { HooksConfig } from "../domain/config.js";
import type { Issue } from "../domain/issue.js";
import type { Workspace, WorkspaceManager } from "../domain/interfaces.js";
import { runShellHook, type HookRunner } from "./hooks.js";

/** Characters permitted in a sanitized workspace key (§9.5-3). */
const ALLOWED_KEY_CHARS = /[^A-Za-z0-9._-]/g;

/**
 * Sanitize an issue identifier into a workspace key (Invariant c, §9.5-3).
 * Every character outside `[A-Za-z0-9._-]` is replaced with `_`. An empty or
 * all-illegal identifier collapses to `_` so a directory name is always valid.
 */
export function sanitizeWorkspaceKey(identifier: string): string {
  const sanitized = (identifier ?? "").replace(ALLOWED_KEY_CHARS, "_");
  return sanitized.length > 0 ? sanitized : "_";
}

/**
 * Verify that `workspacePath` resolves to a location contained within
 * `workspaceRoot` (Invariant b, §9.5-2). Both inputs are normalized to absolute
 * paths first. The workspace root itself is NOT a valid workspace (the path must
 * be a strict descendant). Throws {@link WorkspaceSafetyError} on any escape.
 */
export function assertContainedInRoot(
  workspaceRoot: string,
  workspacePath: string,
): void {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(workspacePath);

  // A relative path from root to target that climbs out (`..`) or is absolute
  // means the target is outside the root subtree.
  const rel = path.relative(root, target);
  const escapes =
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel);

  if (escapes) {
    throw new WorkspaceSafetyError(
      "workspace_escapes_root",
      `workspace path "${target}" is not contained within workspace root "${root}"`,
    );
  }
}

/** Safety-invariant violation. Carries a stable category for error mapping. */
export class WorkspaceSafetyError extends Error {
  readonly category:
    | "workspace_escapes_root"
    | "invalid_workspace_cwd"
    | "workspace_io";
  constructor(
    category: WorkspaceSafetyError["category"],
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceSafetyError";
    this.category = category;
    Object.setPrototypeOf(this, WorkspaceSafetyError.prototype);
  }
}

/** Outcome of running a single hook. */
export interface HookOutcome {
  /** Whether the hook succeeded (also true when no hook was configured). */
  ok: boolean;
  /** true when no script was configured for this hook (treated as success). */
  skipped: boolean;
  /** Concise failure reason when `ok === false`. */
  error?: string;
}

/** Construction options for the workspace manager. */
export interface WorkspaceManagerOptions {
  /** Normalized absolute workspace root (`workspace.root`). */
  root: string;
  /** Workspace lifecycle hooks + timeout (`hooks.*`). */
  hooks: HooksConfig;
  /** Logger; per-issue context is derived per call. */
  logger: Logger;
  /**
   * Injectable hook runner for deterministic tests. Defaults to the real
   * `bash -lc <script>` runner.
   */
  hookRunner?: HookRunner;
}

/**
 * Concrete `WorkspaceManager`. Enforces invariants (b) + (c) on creation and
 * exposes the launch-time invariant (a) check the runner must call.
 */
export class WorkspaceManagerImpl implements WorkspaceManager {
  private readonly root: string;
  private readonly hooks: HooksConfig;
  private readonly logger: Logger;
  private readonly hookRunner: HookRunner;

  constructor(options: WorkspaceManagerOptions) {
    // Normalize root to an absolute path once (§9.1 — normalized absolute path).
    this.root = path.resolve(options.root);
    this.hooks = options.hooks;
    this.logger = options.logger;
    this.hookRunner = options.hookRunner ?? runShellHook;
  }

  /** The normalized absolute workspace root in effect. */
  get workspaceRoot(): string {
    return this.root;
  }

  /**
   * Create-if-missing / reuse-if-present the workspace for an issue (FR-WS-1).
   * Enforces invariants (b) + (c) before any directory is created.
   */
  async ensureWorkspace(issue: Issue): Promise<Workspace> {
    const log = this.logger.forIssue({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });

    // Invariant (c): sanitize the key (§9.5-3).
    const workspace_key = sanitizeWorkspaceKey(issue.identifier);
    const workspacePath = path.join(this.root, workspace_key);

    // Invariant (b): the computed path MUST stay under the root (§9.5-2).
    assertContainedInRoot(this.root, workspacePath);

    // Ensure the root itself exists so per-issue dirs can be created under it.
    await fsp.mkdir(this.root, { recursive: true });

    // `created_now` is true ONLY if THIS call created the directory (§9.2-4).
    let created_now = false;
    if (!directoryExists(workspacePath)) {
      try {
        await fsp.mkdir(workspacePath, { recursive: false });
        created_now = true;
      } catch (err) {
        // A concurrent creation (EEXIST) means it now exists — reuse it.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new WorkspaceSafetyError(
            "workspace_io",
            `failed to create workspace "${workspacePath}": ${errorMessage(err)}`,
          );
        }
      }
    }

    log.info("workspace_ready", {
      outcome: "completed",
      workspace_key,
      workspace_path: workspacePath,
      created_now,
    });

    return { path: workspacePath, workspace_key, created_now };
  }

  /**
   * Remove a workspace directory by key (terminal cleanup). Idempotent; a
   * missing directory is not an error. The key is re-sanitized and the resolved
   * path is re-checked for containment so cleanup can never escape the root.
   */
  async removeWorkspace(workspace_key: string): Promise<void> {
    const key = sanitizeWorkspaceKey(workspace_key);
    const workspacePath = path.join(this.root, key);
    // Defense in depth: never rm -rf outside the root.
    assertContainedInRoot(this.root, workspacePath);

    try {
      await fsp.rm(workspacePath, { recursive: true, force: true });
      this.logger.info("workspace_removed", {
        outcome: "completed",
        workspace_key: key,
        workspace_path: workspacePath,
      });
    } catch (err) {
      // Cleanup failure is non-fatal; log and move on.
      this.logger.warn("workspace_remove_failed", {
        outcome: "failed",
        workspace_key: key,
        reason: errorMessage(err),
      });
    }
  }

  /**
   * Invariant (a): assert the agent will be launched with the workspace as cwd
   * (§9.5-1, §15.2). The runner MUST call this immediately before spawning the
   * agent subprocess, passing the cwd it is about to use. Throws on mismatch.
   */
  assertCwdMatchesWorkspace(cwd: string, workspacePath: string): void {
    if (path.resolve(cwd) !== path.resolve(workspacePath)) {
      throw new WorkspaceSafetyError(
        "invalid_workspace_cwd",
        `agent cwd "${cwd}" does not equal workspace path "${workspacePath}"`,
      );
    }
  }

  /**
   * Run the `before_run` hook (FR-WS-2). A configured hook that fails or times
   * out yields `{ ok: false }`; the runner MUST abort the attempt. No configured
   * hook is treated as success.
   */
  async runBeforeRun(workspace: Workspace, issue: Issue): Promise<HookOutcome> {
    return this.runHook("before_run", this.hooks.before_run, workspace, issue, {
      fatal: true,
    });
  }

  /**
   * Run the `after_run` hook (FR-WS-2). Best-effort: failure / timeout is logged
   * and ignored, so the result is informational only.
   */
  async runAfterRun(workspace: Workspace, issue: Issue): Promise<HookOutcome> {
    return this.runHook("after_run", this.hooks.after_run, workspace, issue, {
      fatal: false,
    });
  }

  /** Shared hook execution: workspace as cwd, bounded by `hooks.timeout_ms`. */
  private async runHook(
    name: "before_run" | "after_run",
    script: string | null,
    workspace: Workspace,
    issue: Issue,
    opts: { fatal: boolean },
  ): Promise<HookOutcome> {
    const log = this.logger.forIssue({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });

    if (!script || script.trim().length === 0) {
      return { ok: true, skipped: true };
    }

    // Invariant alignment: hooks run inside the workspace too (§15.4).
    assertContainedInRoot(this.root, workspace.path);

    log.info("hook_started", { hook: name, workspace_path: workspace.path });

    const result = await this.hookRunner({
      script,
      cwd: workspace.path,
      timeoutMs: this.hooks.timeout_ms,
    });

    if (result.ok) {
      log.info("hook_completed", {
        hook: name,
        outcome: "completed",
        // Output is truncated by the logger sink (§15.4 / NFR-HOOK-SAFETY).
        stdout: result.stdout,
      });
      return { ok: true, skipped: false };
    }

    const reason = result.timedOut
      ? `hook timed out after ${this.hooks.timeout_ms}ms`
      : result.error;
    log[opts.fatal ? "error" : "warn"]("hook_failed", {
      hook: name,
      outcome: "failed",
      fatal: opts.fatal,
      reason,
      stderr: result.stderr,
    });
    return { ok: false, skipped: false, error: reason };
  }
}

/** Synchronous directory-existence probe used to compute `created_now`. */
function directoryExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Factory: build a workspace manager from options. */
export function createWorkspaceManager(
  options: WorkspaceManagerOptions,
): WorkspaceManagerImpl {
  return new WorkspaceManagerImpl(options);
}
