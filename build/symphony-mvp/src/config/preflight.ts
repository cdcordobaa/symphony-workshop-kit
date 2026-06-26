/**
 * Dispatch Preflight Validation (SYMPHONY-SPEC §6.3; FR-WL-6).
 *
 * Runs at startup and before each dispatch tick. Validates only what is needed
 * to poll and launch workers (Notion variant):
 *  - workflow loads/parses (the caller has already produced a WorkflowDefinition),
 *  - `tracker.kind` present and supported (`notion`),
 *  - Notion auth present after `$` resolution,
 *  - Notion database id present,
 *  - agent launch command present.
 */

import type { ServiceConfig, WorkflowDefinition } from "../domain/config.js";
import { SymphonyError } from "../domain/errors.js";

export const SUPPORTED_TRACKER_KINDS = ["notion"] as const;

export interface PreflightResult {
  ok: boolean;
  /** Human-readable failure reasons (one per failed check). */
  errors: string[];
}

/** Validate a resolved `ServiceConfig`. Pure; collects all failures. */
export function checkDispatchConfig(config: ServiceConfig): PreflightResult {
  const errors: string[] = [];
  const { tracker, agent } = config;

  if (!tracker.kind || tracker.kind.length === 0) {
    errors.push("tracker.kind is missing");
  } else if (
    !SUPPORTED_TRACKER_KINDS.includes(
      tracker.kind as (typeof SUPPORTED_TRACKER_KINDS)[number],
    )
  ) {
    errors.push(
      `tracker.kind '${tracker.kind}' is not supported (supported: ${SUPPORTED_TRACKER_KINDS.join(", ")})`,
    );
  }

  // Notion-specific required targets.
  if (!tracker.api_key || tracker.api_key.length === 0) {
    errors.push("tracker.api_key is missing (empty after $VAR resolution)");
  }
  if (!tracker.database || tracker.database.length === 0) {
    errors.push("tracker.database (Notion database id) is missing");
  }

  if (!agent.command || agent.command.trim().length === 0) {
    errors.push("agent.command is missing");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a loaded workflow's dispatch config.
 *
 * @returns the `PreflightResult` (non-throwing form, suitable for per-tick use).
 */
export function validateDispatchConfig(
  workflow: WorkflowDefinition,
): PreflightResult {
  return checkDispatchConfig(workflow.service);
}

/**
 * Throwing form for startup validation: fails startup with an operator-visible
 * error listing every failed check.
 */
export function assertDispatchConfig(workflow: WorkflowDefinition): void {
  const result = validateDispatchConfig(workflow);
  if (!result.ok) {
    throw new SymphonyError(
      "preflight_failed",
      "Dispatch preflight validation failed.",
      result.errors,
    );
  }
}
