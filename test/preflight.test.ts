import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config/config.js";
import { parseWorkflow } from "../src/config/loader.js";
import { preflightConfig, preflightWorkflowFile } from "../src/config/preflight.js";
import { writeWorkflow } from "./helpers.js";

function cfgFrom(frontMatter: string, env: Record<string, string | undefined> = {}) {
  const raw = ["---", frontMatter, "---", "body"].join("\n");
  return resolveConfig(parseWorkflow(raw, "/repo/WORKFLOW.md"), env);
}

const VALID = "tracker:\n  kind: notion\n  auth: $NOTION_API_KEY\n  database_id: db-1";
const VALID_ENV = { NOTION_API_KEY: "tok" };

test("preflight passes on a valid Notion workflow", () => {
  const result = preflightConfig(cfgFrom(VALID, VALID_ENV));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("preflight fails when tracker.kind is missing", () => {
  const result = preflightConfig(cfgFrom("tracker:\n  auth: t\n  database_id: db-1"));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("tracker.kind")));
});

test("preflight fails for an unsupported tracker.kind", () => {
  const result = preflightConfig(
    cfgFrom("tracker:\n  kind: linear\n  auth: t\n  database_id: db-1"),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.toLowerCase().includes("unsupported")));
});

test("preflight fails when Notion auth is absent", () => {
  const result = preflightConfig(cfgFrom("tracker:\n  kind: notion\n  database_id: db-1"));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("tracker.auth")));
});

test("preflight fails when database_id is absent", () => {
  const result = preflightConfig(cfgFrom("tracker:\n  kind: notion\n  auth: t"));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("tracker.database_id")));
});

test("preflight fails when agent.command is explicitly empty", () => {
  const result = preflightConfig(
    cfgFrom("tracker:\n  kind: notion\n  auth: t\n  database_id: db-1\nagent:\n  command: \"\""),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("agent.command")));
});

test("preflightWorkflowFile maps a missing file into operator-visible errors", () => {
  const result = preflightWorkflowFile("/no/such/WORKFLOW.md");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("missing_workflow_file")));
});

test("preflightWorkflowFile passes end-to-end on a real valid file", () => {
  const path = writeWorkflow(["---", VALID, "---", "Prompt body"].join("\n"));
  const result = preflightWorkflowFile(path, VALID_ENV);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});
