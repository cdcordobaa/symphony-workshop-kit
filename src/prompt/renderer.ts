/**
 * Strict prompt renderer (Symphony spec §5.4 and §12).
 *
 * Uses LiquidJS with strict variable and strict filter checking, so unknown
 * variables and unknown filters fail rendering rather than silently producing
 * empty output. Template inputs are the normalized `issue` object and the
 * OPTIONAL `attempt` integer.
 */

import { Liquid, ParseError } from "liquidjs";
import type { Issue } from "../domain/types.js";
import { WorkflowError } from "../config/errors.js";

/** Default prompt used when a workflow body is empty (§5.4 fallback behavior). */
export const DEFAULT_PROMPT = "You are working on an issue from Linear.";

/**
 * Strict Liquid-compatible prompt renderer. One engine instance is reused across
 * renders; it is configured once for strict semantics.
 */
export class PromptRenderer {
  private readonly engine: Liquid;

  constructor() {
    this.engine = new Liquid({
      strictVariables: true,
      strictFilters: true,
      // Keep rendering deterministic and side-effect free.
      jsTruthy: true,
    });
  }

  /**
   * Render the prompt template with `issue` and `attempt` inputs (§12.1).
   *
   * @param template  Markdown prompt body. Empty bodies fall back to {@link DEFAULT_PROMPT}.
   * @param issue     Normalized issue (keys are strings; nested labels/blockers preserved, §12.2).
   * @param attempt   `null`/absent on first attempt; integer on retry/continuation.
   * @throws {WorkflowError} `template_parse_error` on malformed templates,
   *         `template_render_error` on unknown variables/filters or bad interpolation.
   */
  render(template: string, issue: Issue, attempt: number | null = null): string {
    const source = template.trim().length === 0 ? DEFAULT_PROMPT : template;

    let parsed;
    try {
      parsed = this.engine.parse(source);
    } catch (cause) {
      // LiquidJS surfaces unknown filters at parse time, but the spec (§5.5)
      // categorizes unknown variables/filters together under template_render_error.
      // Reserve template_parse_error for structural/tokenization problems.
      const message = messageOf(cause);
      const isUnknownFilterOrTag =
        cause instanceof ParseError && /undefined (filter|tag)/i.test(message);
      const code = isUnknownFilterOrTag ? "template_render_error" : "template_parse_error";
      throw new WorkflowError(code, message, { cause });
    }

    try {
      return this.engine.renderSync(parsed, { issue, attempt });
    } catch (cause) {
      throw new WorkflowError("template_render_error", messageOf(cause), { cause });
    }
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Convenience one-shot render using a fresh {@link PromptRenderer}. */
export function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null = null,
): string {
  return new PromptRenderer().render(template, issue, attempt);
}
