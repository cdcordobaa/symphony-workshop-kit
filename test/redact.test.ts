import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config/config.js";
import { parseWorkflow } from "../src/config/loader.js";
import { redactConfig, SECRET_MISSING, SECRET_SET } from "../src/config/redact.js";

const SRC = "/repo/WORKFLOW.md";

function cfgFrom(frontMatter: string, env: Record<string, string | undefined> = {}) {
  const raw = ["---", frontMatter, "---", "body"].join("\n");
  return resolveConfig(parseWorkflow(raw, SRC), env);
}

const SECRET = "super-secret-notion-token-value";

test("redacted config reports auth presence, never the secret value", () => {
  const cfg = cfgFrom("tracker:\n  kind: notion\n  auth: $NOTION_API_KEY\n  database_id: db-1", {
    NOTION_API_KEY: SECRET,
  });
  // Sanity: the secret really was resolved onto the live config.
  assert.equal(cfg.tracker.auth, SECRET);

  const redacted = redactConfig(cfg);
  assert.equal(redacted.tracker.auth, SECRET_SET);

  // The serialized redacted view must not leak the secret anywhere.
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(SECRET), false);
  // database_id is an identifier, not a secret — it is preserved for operators.
  assert.equal(redacted.tracker.database_id, "db-1");
});

test("redacted config marks a missing secret as <missing>", () => {
  const cfg = cfgFrom("tracker:\n  kind: notion\n  database_id: db-1");
  assert.equal(cfg.tracker.auth, null);
  assert.equal(redactConfig(cfg).tracker.auth, SECRET_MISSING);
});

test("redaction does not mutate the source config", () => {
  const cfg = cfgFrom("tracker:\n  kind: notion\n  auth: $NOTION_API_KEY", {
    NOTION_API_KEY: SECRET,
  });
  redactConfig(cfg);
  assert.equal(cfg.tracker.auth, SECRET, "source config must retain the live secret");
});

test("non-secret fields survive redaction unchanged", () => {
  const cfg = cfgFrom("tracker:\n  kind: notion\n  auth: t\npolling:\n  interval_ms: 12345", {});
  const redacted = redactConfig(cfg);
  assert.equal(redacted.polling.interval_ms, 12_345);
  assert.equal(redacted.tracker.kind, "notion");
  assert.deepEqual(redacted.tracker.active_states, cfg.tracker.active_states);
});
