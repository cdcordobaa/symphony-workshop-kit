import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWorkflowFile, parseWorkflow } from "../src/config/loader.js";
import { WorkflowError } from "../src/config/errors.js";
import { writeWorkflow } from "./helpers.js";

const SRC = "/abs/WORKFLOW.md";

test("splits front matter from a trimmed prompt body", () => {
  const raw = ["---", "tracker:", "  kind: notion", "---", "", "  Hello body.  ", ""].join("\n");
  const wf = parseWorkflow(raw, SRC);
  assert.deepEqual(wf.config, { tracker: { kind: "notion" } });
  assert.equal(wf.prompt_template, "Hello body.");
  assert.equal(wf.source_path, SRC);
});

test("absent front matter yields an empty config and the whole file as body", () => {
  const raw = "Just a prompt body with no front matter.\n";
  const wf = parseWorkflow(raw, SRC);
  assert.deepEqual(wf.config, {});
  assert.equal(wf.prompt_template, "Just a prompt body with no front matter.");
});

test("empty front-matter block decodes to an empty config map", () => {
  const raw = ["---", "---", "body"].join("\n");
  const wf = parseWorkflow(raw, SRC);
  assert.deepEqual(wf.config, {});
  assert.equal(wf.prompt_template, "body");
});

test("non-map front matter (list) is a typed error", () => {
  const raw = ["---", "- one", "- two", "---", "body"].join("\n");
  assert.throws(
    () => parseWorkflow(raw, SRC),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "workflow_front_matter_not_a_map",
  );
});

test("non-map front matter (scalar) is a typed error", () => {
  const raw = ["---", "42", "---", "body"].join("\n");
  assert.throws(
    () => parseWorkflow(raw, SRC),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "workflow_front_matter_not_a_map",
  );
});

test("invalid YAML front matter is a typed parse error", () => {
  const raw = ["---", "tracker: : :", "  - broken", "---", "body"].join("\n");
  assert.throws(
    () => parseWorkflow(raw, SRC),
    (e: unknown) => e instanceof WorkflowError && e.code === "workflow_parse_error",
  );
});

test("an unclosed front-matter fence is a typed parse error", () => {
  const raw = ["---", "tracker:", "  kind: notion", "body without closing fence"].join("\n");
  assert.throws(
    () => parseWorkflow(raw, SRC),
    (e: unknown) => e instanceof WorkflowError && e.code === "workflow_parse_error",
  );
});

test("missing workflow file is a typed error", () => {
  assert.throws(
    () => loadWorkflowFile("/no/such/path/WORKFLOW.md"),
    (e: unknown) => e instanceof WorkflowError && e.code === "missing_workflow_file",
  );
});

test("loadWorkflowFile reads from disk and records an absolute source path", () => {
  const path = writeWorkflow(["---", "tracker:", "  kind: notion", "---", "Body."].join("\n"));
  const wf = loadWorkflowFile(path);
  assert.equal(wf.source_path, path);
  assert.equal(wf.prompt_template, "Body.");
  assert.deepEqual(wf.config, { tracker: { kind: "notion" } });
});
