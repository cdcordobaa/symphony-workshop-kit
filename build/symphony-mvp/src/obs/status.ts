/**
 * Simple terminal status surface (U5; SYMPHONY-SPEC §13.4, FR-OB-4).
 *
 * Renders a human-readable summary PURELY from the orchestrator's in-memory
 * `OrchestratorRuntimeState`. Per §13.4 this surface is OPTIONAL and MUST NOT
 * be required for correctness — it only reads state, never mutates it, and the
 * orchestrator does not depend on its output.
 *
 * Deliberately no HTTP server, no JSON API, no dashboard (out of scope §13.7).
 */

import type {
  OrchestratorRuntimeState,
  RunningEntry,
} from "../domain/state.js";

/** Options controlling the rendered status text. */
export interface RenderStatusOptions {
  /**
   * Stable header timestamp. Pass a fixed value for deterministic snapshots;
   * omit to leave the header time out entirely.
   */
  now?: string;
  /** Cap on the number of running rows listed (rest summarized). Default 20. */
  maxRows?: number;
}

/**
 * Produce a readable terminal summary of orchestrator state: a counts header
 * plus one row per running issue. Pure and side-effect free.
 */
export function renderStatus(
  state: OrchestratorRuntimeState,
  options: RenderStatusOptions = {},
): string {
  const maxRows = options.maxRows ?? 20;
  const running = [...state.running.values()];

  const lines: string[] = [];
  const header = options.now
    ? `Symphony status @ ${options.now}`
    : "Symphony status";
  lines.push(header);
  lines.push(
    `running=${state.running.size} ` +
      `claimed=${state.claimed.size} ` +
      `completed=${state.completed.size} ` +
      `slots=${state.running.size}/${state.max_concurrent_agents} ` +
      `interval_ms=${state.poll_interval_ms}`,
  );

  if (running.length === 0) {
    lines.push("(no running agents)");
    return lines.join("\n");
  }

  const shown = running.slice(0, maxRows);
  for (const entry of shown) {
    lines.push(`  - ${formatRunningRow(entry)}`);
  }
  if (running.length > shown.length) {
    lines.push(`  …and ${running.length - shown.length} more`);
  }

  return lines.join("\n");
}

/** Format one running issue row from state only. */
function formatRunningRow(entry: RunningEntry): string {
  const attempt = entry.attempt === null ? "1" : String(entry.attempt);
  const session = entry.session_id ?? "-";
  const stateName = entry.last_state ?? "-";
  return (
    `${entry.issue_identifier} ` +
    `(id=${entry.issue_id}) ` +
    `state=${stateName} ` +
    `attempt=${attempt} ` +
    `turns=${entry.turn_count} ` +
    `session=${session} ` +
    `started_at=${entry.started_at}`
  );
}
