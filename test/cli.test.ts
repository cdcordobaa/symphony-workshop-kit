import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { ExitCode, resolveWorkflowPath, runHost, type HostIo } from "../src/index.js";
import { writeWorkflow } from "./helpers.js";

const VALID_WORKFLOW = [
  "---",
  "tracker:",
  "  kind: notion",
  "  auth: $NOTION_API_KEY",
  "  database_id: db-1",
  "---",
  "Prompt body for {{ issue.identifier }}.",
].join("\n");

function captureIo(env: Record<string, string | undefined> = {}, cwd = "/tmp"): HostIo & {
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    env,
    cwd,
  };
}

test("explicit positional path is used", () => {
  const sel = resolveWorkflowPath(["custom/flow.md"], "/repo");
  assert.equal(sel.path, resolve("/repo", "custom/flow.md"));
  assert.equal(sel.explicit, true);
});

test("defaults to ./WORKFLOW.md when no path argument is provided", () => {
  const sel = resolveWorkflowPath([], "/repo");
  assert.equal(sel.path, join("/repo", "WORKFLOW.md"));
  assert.equal(sel.explicit, false);
});

test("flags are not treated as the positional path", () => {
  const sel = resolveWorkflowPath(["--verbose"], "/repo");
  assert.equal(sel.explicit, false);
  assert.equal(sel.path, join("/repo", "WORKFLOW.md"));
});

test("absolute positional path is preserved", () => {
  const sel = resolveWorkflowPath(["/abs/WORKFLOW.md"], "/repo");
  assert.equal(sel.path, "/abs/WORKFLOW.md");
  assert.equal(sel.explicit, true);
});

test("runHost exits OK on a valid workflow and reports startup", () => {
  const path = writeWorkflow(VALID_WORKFLOW);
  const io = captureIo({ NOTION_API_KEY: "tok" });
  const code = runHost([path], io);
  assert.equal(code, ExitCode.OK);
  assert.ok(io.stdout.some((l) => l.includes("startup preflight passed")));
  assert.equal(io.stderr.length, 0);
});

test("runHost errors (nonzero) on a nonexistent explicit path", () => {
  const io = captureIo();
  const code = runHost(["/no/such/WORKFLOW.md"], io);
  assert.equal(code, ExitCode.MISSING_WORKFLOW);
  assert.ok(io.stderr.some((l) => l.includes("workflow file not found")));
});

test("runHost errors (nonzero) when the default ./WORKFLOW.md is missing", () => {
  const io = captureIo({}, "/nonexistent-dir-xyz");
  const code = runHost([], io);
  assert.equal(code, ExitCode.MISSING_WORKFLOW);
  assert.ok(io.stderr.some((l) => l.includes("default WORKFLOW.md")));
});

test("runHost surfaces a startup failure cleanly when preflight fails", () => {
  // Valid file, but no auth available anywhere -> preflight fails, not a crash.
  const path = writeWorkflow(
    ["---", "tracker:", "  kind: notion", "  database_id: db-1", "---", "body"].join("\n"),
  );
  const io = captureIo({});
  const code = runHost([path], io);
  assert.equal(code, ExitCode.STARTUP_FAILURE);
  assert.ok(io.stderr.some((l) => l.includes("preflight failed")));
  assert.ok(io.stderr.some((l) => l.includes("tracker.auth")));
});

test("runHost surfaces a malformed front-matter failure cleanly", () => {
  const path = writeWorkflow(["---", "- not-a-map", "---", "body"].join("\n"));
  const io = captureIo({ NOTION_API_KEY: "tok" });
  const code = runHost([path], io);
  assert.equal(code, ExitCode.STARTUP_FAILURE);
  assert.ok(io.stderr.some((l) => l.includes("workflow_front_matter_not_a_map")));
});

test("a workflow placed at the cwd default is discovered without an argument", () => {
  const path = writeWorkflow(VALID_WORKFLOW);
  // Confirm the directory-based default discovery: cwd holds the WORKFLOW.md.
  const cwd = dirname(path);
  writeFileSync(join(cwd, "WORKFLOW.md"), VALID_WORKFLOW, "utf8");
  const io = captureIo({ NOTION_API_KEY: "tok" }, cwd);
  const code = runHost([], io);
  assert.equal(code, ExitCode.OK);
});
