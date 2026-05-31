import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config/config.js";
import { WorkflowError } from "../src/config/errors.js";
import { parseWorkflow } from "../src/config/loader.js";

const SRC = "/workspace/repo/WORKFLOW.md";

function configFrom(frontMatter: string, env: Record<string, string | undefined> = {}, src = SRC) {
  const raw = ["---", frontMatter, "---", "body"].join("\n");
  return resolveConfig(parseWorkflow(raw, src), env);
}

test("defaults apply when optional fields are missing", () => {
  const cfg = configFrom("tracker:\n  kind: notion");
  assert.equal(cfg.polling.interval_ms, 30_000);
  assert.equal(cfg.hooks.timeout_ms, 60_000);
  assert.equal(cfg.agent.command, "claude");
  assert.equal(cfg.agent.max_concurrent_agents, 10);
  assert.equal(cfg.agent.max_turns, 20);
  assert.equal(cfg.agent.max_retry_backoff_ms, 300_000);
  assert.deepEqual(cfg.tracker.active_states, ["Todo", "In Progress"]);
  assert.deepEqual(cfg.tracker.terminal_states, [
    "Closed",
    "Cancelled",
    "Canceled",
    "Duplicate",
    "Done",
  ]);
  assert.equal(cfg.workspace.root, resolve(tmpdir(), "symphony_workspaces"));
  assert.equal(cfg.hooks.after_create, null);
});

test("$VAR resolves only where referenced (auth + database_id)", () => {
  const env = { NOTION_API_KEY: "secret-token", NOTION_DATABASE_ID: "db-1234" };
  const cfg = configFrom(
    "tracker:\n  kind: notion\n  auth: $NOTION_API_KEY\n  database_id: ${NOTION_DATABASE_ID}",
    env,
  );
  assert.equal(cfg.tracker.auth, "secret-token");
  assert.equal(cfg.tracker.database_id, "db-1234");
});

test("a literal (non-$) auth value is left untouched", () => {
  const cfg = configFrom("tracker:\n  kind: notion\n  auth: literal-token", { NOTION_API_KEY: "x" });
  assert.equal(cfg.tracker.auth, "literal-token");
});

test("auth falls back to NOTION_API_KEY when omitted entirely", () => {
  const cfg = configFrom("tracker:\n  kind: notion", { NOTION_API_KEY: "env-token" });
  assert.equal(cfg.tracker.auth, "env-token");
});

test("$VAR that resolves to empty string makes auth missing (null)", () => {
  const cfg = configFrom("tracker:\n  kind: notion\n  auth: $NOTION_API_KEY", { NOTION_API_KEY: "" });
  assert.equal(cfg.tracker.auth, null);
});

test("~ expansion works for path fields", () => {
  const cfg = configFrom("tracker:\n  kind: notion\nworkspace:\n  root: ~/work/spaces");
  assert.equal(cfg.workspace.root, resolve(homedir(), "work/spaces"));
});

test("relative workspace.root resolves against the WORKFLOW.md directory", () => {
  const cfg = configFrom("tracker:\n  kind: notion\nworkspace:\n  root: ./ws");
  assert.equal(cfg.workspace.root, resolve(dirname(SRC), "ws"));
});

test("$VAR expansion works inside path fields too", () => {
  const cfg = configFrom("tracker:\n  kind: notion\nworkspace:\n  root: $HOME_BASE/ws", {
    HOME_BASE: "/data/home",
  });
  assert.equal(cfg.workspace.root, resolve("/data/home/ws"));
});

test("per-state concurrency map normalizes keys and drops invalid entries", () => {
  const fm = [
    "tracker:",
    "  kind: notion",
    "agent:",
    "  max_concurrent_agents_by_state:",
    '    "In Progress": 3',
    "    Todo: 0",
    "    Review: not-a-number",
    "    Done: 2",
  ].join("\n");
  const cfg = configFrom(fm);
  assert.deepEqual(cfg.agent.max_concurrent_agents_by_state, { "in progress": 3, done: 2 });
});

test("invalid max_turns fails config validation", () => {
  assert.throws(
    () => configFrom("tracker:\n  kind: notion\nagent:\n  max_turns: 0"),
    (e: unknown) => e instanceof WorkflowError && e.code === "config_validation_error",
  );
});

test("invalid hooks.timeout_ms fails config validation", () => {
  assert.throws(
    () => configFrom("tracker:\n  kind: notion\nhooks:\n  timeout_ms: -5"),
    (e: unknown) => e instanceof WorkflowError && e.code === "config_validation_error",
  );
});

test("stall_timeout_ms may be <= 0 to disable stall detection", () => {
  const cfg = configFrom("tracker:\n  kind: notion\nagent:\n  stall_timeout_ms: 0");
  assert.equal(cfg.agent.stall_timeout_ms, 0);
});
