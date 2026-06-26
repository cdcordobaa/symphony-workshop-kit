/**
 * Built-in config defaults (requirements.md §7 — Notion variant; SYMPHONY-SPEC
 * §6.4 cheat sheet, adapted: `codex.*` → `agent.*`).
 */

import os from "node:os";
import path from "node:path";

export const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"] as const;
export const DEFAULT_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
] as const;

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
export const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
export const DEFAULT_READ_TIMEOUT_MS = 5_000;
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;

/**
 * Default Claude Code headless invocation (high-trust, non-interactive).
 * `{{prompt}}`-free: the prompt is delivered on stdin by the U4 runner, so the
 * default command just starts a headless print-mode session that auto-approves.
 */
export const DEFAULT_AGENT_COMMAND =
  "claude --print --permission-mode bypassPermissions";

/** Default workspace root: `<system-temp>/symphony_workspaces`. */
export function defaultWorkspaceRoot(): string {
  return path.join(os.tmpdir(), "symphony_workspaces");
}
