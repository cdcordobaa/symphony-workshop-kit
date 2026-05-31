/**
 * Dispatch preflight validation (Symphony spec §6.3, Notion variant).
 *
 * This is the scheduler preflight run at startup and before each dispatch tick.
 * It validates only what is needed to poll and launch workers — not a full audit.
 * Failures are operator-visible: startup fails on a bad config; a per-tick failure
 * skips dispatch for that tick while reconciliation stays active.
 */

import type { ServiceConfig } from "../domain/types.js";
import { isWorkflowError } from "./errors.js";
import { resolveConfig } from "./config.js";
import { loadWorkflowFile } from "./loader.js";

/** Tracker kinds this build can dispatch to. */
export const SUPPORTED_TRACKER_KINDS: ReadonlySet<string> = new Set(["notion"]);

/** Outcome of a preflight run. `errors` is empty iff `ok` is `true`. */
export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate an already-resolved {@link ServiceConfig} (§6.3 validation checks,
 * adapted for the Notion tracker):
 *   - `tracker.kind` is present and supported.
 *   - `tracker.auth` is present after `$` resolution.
 *   - `tracker.database_id` is present (REQUIRED for the Notion tracker).
 *   - `agent.command` is present and non-empty.
 */
export function preflightConfig(config: ServiceConfig): PreflightResult {
  const errors: string[] = [];

  const kind = config.tracker.kind.trim();
  if (kind.length === 0) {
    errors.push("tracker.kind is required for dispatch.");
  } else if (!SUPPORTED_TRACKER_KINDS.has(kind.toLowerCase())) {
    errors.push(
      `Unsupported tracker.kind "${kind}"; supported: ${[...SUPPORTED_TRACKER_KINDS].join(", ")}.`,
    );
  }

  if (config.tracker.auth === null) {
    errors.push(
      "tracker.auth is missing (set a literal token, a non-empty $VAR, or NOTION_API_KEY in the environment).",
    );
  }

  if (config.tracker.database_id === null) {
    errors.push("tracker.database_id is required for the Notion tracker.");
  }

  if (config.agent.command.trim().length === 0) {
    errors.push("agent.command must be present and non-empty.");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Full preflight from a workflow file path: loads + resolves + validates, mapping
 * any load/parse/config error into the operator-visible `errors` list so the
 * scheduler can treat "workflow fails to load" as a preflight failure (§6.3).
 */
export function preflightWorkflowFile(
  path: string,
  env: Record<string, string | undefined> = process.env,
): PreflightResult {
  let config: ServiceConfig;
  try {
    config = resolveConfig(loadWorkflowFile(path), env);
  } catch (error) {
    const message = isWorkflowError(error)
      ? `[${error.code}] ${error.message}`
      : `Failed to load workflow: ${(error as Error).message}`;
    return { ok: false, errors: [message] };
  }
  return preflightConfig(config);
}
