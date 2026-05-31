import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROMPT, PromptRenderer, renderPrompt } from "../src/prompt/renderer.js";
import { WorkflowError } from "../src/config/errors.js";
import { sampleIssue } from "./helpers.js";

test("renders issue fields and iterates labels/blockers", () => {
  const out = renderPrompt(
    [
      "Issue {{ issue.identifier }}: {{ issue.title }} [{{ issue.state }}]",
      "{% for l in issue.labels %}#{{ l }} {% endfor %}",
      "{% for b in issue.blocked_by %}blocked-by {{ b.identifier }} {% endfor %}",
    ].join("\n"),
    sampleIssue(),
  );
  assert.match(out, /Issue ABC-123: Implement the thing \[Todo\]/);
  assert.match(out, /#backend #mvp/);
  assert.match(out, /blocked-by ABC-100/);
});

test("attempt is null on first run and an integer on retries", () => {
  const tpl = "{% if attempt %}retry #{{ attempt }}{% else %}first run{% endif %}";
  assert.equal(renderPrompt(tpl, sampleIssue(), null), "first run");
  assert.equal(renderPrompt(tpl, sampleIssue(), 3), "retry #3");
});

test("unknown variables fail rendering (strict mode)", () => {
  assert.throws(
    () => renderPrompt("Hello {{ does_not_exist }}", sampleIssue()),
    (e: unknown) => e instanceof WorkflowError && e.code === "template_render_error",
  );
});

test("unknown nested issue properties fail rendering (strict mode)", () => {
  assert.throws(
    () => renderPrompt("{{ issue.not_a_field }}", sampleIssue()),
    (e: unknown) => e instanceof WorkflowError && e.code === "template_render_error",
  );
});

test("unknown filters fail rendering (strict mode)", () => {
  assert.throws(
    () => renderPrompt("{{ issue.title | no_such_filter }}", sampleIssue()),
    (e: unknown) => e instanceof WorkflowError && e.code === "template_render_error",
  );
});

test("malformed templates raise a parse error", () => {
  assert.throws(
    () => renderPrompt("{% if %}", sampleIssue()),
    (e: unknown) => e instanceof WorkflowError && e.code === "template_parse_error",
  );
});

test("an empty body falls back to the default prompt", () => {
  assert.equal(new PromptRenderer().render("   \n  ", sampleIssue()), DEFAULT_PROMPT);
});

test("known built-in filters still work", () => {
  assert.equal(renderPrompt("{{ issue.identifier | downcase }}", sampleIssue()), "abc-123");
});
