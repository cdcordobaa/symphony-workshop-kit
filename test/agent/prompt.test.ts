/**
 * Agent-layer prompt assembly (§12, §10.2) — strict `issue` + `attempt` binding
 * with loud failure on missing bindings (FR15), plus the §10.2 title metadata.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentPrompt } from "../../src/agent/prompt.js";
import { AgentError, isAgentError } from "../../src/agent/errors.js";
import { sampleIssue } from "../helpers.js";

test("binds issue fields and the attempt into the rendered prompt [FR15]", () => {
  const { prompt } = buildAgentPrompt(
    "Work {{ issue.identifier }} ({{ issue.state }}){% if attempt %} retry {{ attempt }}{% endif %}",
    sampleIssue(),
    2,
  );
  assert.equal(prompt, "Work ABC-123 (Todo) retry 2");
});

test("attempt null renders the first-run branch", () => {
  const { prompt } = buildAgentPrompt(
    "{% if attempt %}retry{% else %}first{% endif %}",
    sampleIssue(),
    null,
  );
  assert.equal(prompt, "first");
});

test("a missing/unknown binding raises AgentError (no silent blank) [FR15]", () => {
  assert.throws(
    () => buildAgentPrompt("Hello {{ does_not_exist }}", sampleIssue()),
    (e: unknown) => isAgentError(e) && (e as AgentError).code === "prompt_render_error",
  );
});

test("an unknown nested issue field also raises [FR15]", () => {
  assert.throws(
    () => buildAgentPrompt("{{ issue.not_a_field }}", sampleIssue()),
    (e: unknown) => isAgentError(e) && (e as AgentError).code === "prompt_render_error",
  );
});

test("derives the §10.2 session title `<identifier>: <title>`", () => {
  const { title } = buildAgentPrompt("x", sampleIssue());
  assert.equal(title, "ABC-123: Implement the thing");
});
