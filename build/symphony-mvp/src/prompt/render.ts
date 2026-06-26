/**
 * Strict prompt renderer (SYMPHONY-SPEC §5.4, §12; FR-WL-5, FR-PR-1).
 *
 * Liquid-compatible semantics with STRICT variable + filter checking: unknown
 * variables or filters MUST fail rendering. Inputs are the normalized `issue`
 * object and the `attempt` integer/null. Nested arrays/maps (labels, blockers)
 * are preserved so templates can iterate.
 *
 * This primitive is defined in U1 and reused by U4 (agent runner).
 */

import { Liquid } from "liquidjs";
import type { Issue } from "../domain/issue.js";
import { SymphonyError } from "../domain/errors.js";

/**
 * Minimal default prompt used ONLY when the prompt body is empty (§5.4).
 * Read/parse failures are config errors, not silent fallbacks (FR-PR-3).
 */
export const FALLBACK_PROMPT = "You are working on an issue from the tracker.";

/** A strict Liquid engine: undefined variables and filters throw. */
function createEngine(): Liquid {
  return new Liquid({
    strictVariables: true,
    strictFilters: true,
    // Keep output literal: do not trim/auto-escape the prompt content.
    jsTruthy: true,
  });
}

/**
 * Convert the issue into a plain template context with string keys and
 * preserved nested structures (§12.2). Returns a new object; does not mutate.
 */
export function toTemplateContext(
  issue: Issue,
  attempt: number | null,
): Record<string, unknown> {
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      state: issue.state,
      branch_name: issue.branch_name,
      url: issue.url,
      labels: [...issue.labels],
      blocked_by: issue.blocked_by.map((b) => ({
        id: b.id,
        identifier: b.identifier,
        state: b.state,
      })),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    },
    // null/absent on first attempt; integer on retry/continuation.
    attempt: attempt ?? null,
  };
}

/**
 * Render a prompt template with the given issue + attempt.
 *
 * @throws SymphonyError `render_failed` on any rendering error (e.g. unknown
 *         variable or filter). The orchestrator treats this as a worker failure.
 */
export function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
): string {
  const effective = template.trim().length === 0 ? FALLBACK_PROMPT : template;
  const engine = createEngine();
  const context = toTemplateContext(issue, attempt);

  try {
    return engine.parseAndRenderSync(effective, context);
  } catch (err) {
    throw new SymphonyError(
      "render_failed",
      `Prompt rendering failed: ${(err as Error).message}`,
    );
  }
}
