/**
 * Agent-layer prompt assembly (Symphony spec §12, §10.2).
 *
 * The Agent Runner needs two things from the workflow template + normalized issue:
 *   1. the rendered turn prompt (§12.1 inputs: `workflow.prompt_template`, `issue`,
 *      OPTIONAL `attempt`), produced by the shared strict {@link PromptRenderer} so
 *      an unknown/missing binding fails loudly rather than emitting a silent blank
 *      (§12.2 strict variable + filter checking, FR15); and
 *   2. a human-readable session/turn title `<issue.identifier>: <issue.title>`
 *      (§10.2 "Include issue-identifying metadata").
 *
 * This module is a thin composition over `src/prompt` — the renderer is the single
 * source of strict-binding truth; here we only bind the agent-relevant context and
 * surface the title. Rendering failures are re-raised as {@link AgentError}
 * (`prompt_render_error`) so the runner maps prompt failures to a failed attempt
 * (§12.4) with a normalized §10.6 code, without leaking the templating internals.
 */

import type { Issue } from "../domain/types.js";
import { PromptRenderer } from "../prompt/renderer.js";
import { AgentError } from "./errors.js";

/** The rendered turn prompt plus the metadata title advertised to the agent (§10.2). */
export interface AgentPrompt {
  /** Fully rendered, strict-bound turn prompt fed to the coding agent (§12.1). */
  prompt: string;
  /** `<issue.identifier>: <issue.title>` — session/turn title metadata (§10.2). */
  title: string;
}

/** A reused strict renderer instance (configured once for strict semantics). */
const renderer = new PromptRenderer();

/**
 * Render the agent turn prompt with `issue` + `attempt` bound (§12.1).
 *
 * @param template Markdown prompt body (`workflow.prompt_template`). Empty bodies
 *                 fall back to the renderer's default prompt (§5.4).
 * @param issue    Normalized issue; nested labels/blockers are preserved so
 *                 templates can iterate (§12.2).
 * @param attempt  `null`/absent on the first run; an integer on retry/continuation
 *                 so the template can branch (§12.3).
 * @throws {AgentError} `prompt_render_error` when a binding is unknown/missing or
 *         the template is malformed (§12.4) — no silent blanks (FR15).
 */
export function buildAgentPrompt(
  template: string,
  issue: Issue,
  attempt: number | null = null,
): AgentPrompt {
  let prompt: string;
  try {
    prompt = renderer.render(template, issue, attempt);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new AgentError("prompt_render_error", message, cause);
  }
  return { prompt, title: `${issue.identifier}: ${issue.title}` };
}
