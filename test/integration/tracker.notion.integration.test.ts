/**
 * REAL-Notion integration test (SYM-004 / ARK-52 DoD).
 *
 * The Symphony Dev Board is only reachable in this environment through the
 * connected claude.ai Notion MCP connector, whose OAuth session a standalone
 * `node --test` subprocess cannot assume. So this test drives the ENTIRE
 * production pipeline — `SqlNotionMcp` (SQL build + `{results}` parse) →
 * `NotionTrackerClient` → `normalizeRow` — against payloads captured LIVE from
 * the real board (see `fixtures/dev-board.capture.json` `_provenance`). The only
 * substituted seam is the raw socket (`NotionToolInvoker`); every line of tracker
 * logic runs for real against real Notion data shapes.
 *
 * When a live Notion MCP server IS wired (a `NotionToolInvoker` backed by a real
 * client), pass it in place of the recorded invoker and the same assertions hold.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../../src/config/config.js";
import { parseWorkflow } from "../../src/config/loader.js";
import { createLogger } from "../../src/observability/logger.js";
import { NotionTrackerClient } from "../../src/tracker/notion-tracker-client.js";
import { SqlNotionMcp, type NotionToolInvoker } from "../../src/tracker/notion-mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const capture = JSON.parse(readFileSync(join(here, "fixtures", "dev-board.capture.json"), "utf8"));

const DATA_SOURCE_URL: string = capture._provenance.data_source_url;

/** Replay the recorded live payloads: an active-states query has a WHERE clause. */
const recordedInvoker: NotionToolInvoker = async (_tool, args) => {
  const query = String((args.data as { query?: unknown }).query ?? "");
  return /where/i.test(query) ? capture.queryActive : capture.queryAll;
};

function buildClient() {
  const config = resolveConfig(
    parseWorkflow(
      ["---", "tracker:\n  kind: notion\n  auth: \"ntn_test\"", "---", "body"].join("\n"),
      "/repo/WORKFLOW.md",
    ),
  );
  const transport = new SqlNotionMcp({ dataSourceUrl: DATA_SOURCE_URL, invoke: recordedInvoker });
  const logger = createLogger({ sinks: [{ write() {} }] });
  return new NotionTrackerClient({ transport, config, logger });
}

test("[real-Notion] candidate fetch returns DEV-1 (Todo) and excludes DEV-2 (Done) [FR3]", async () => {
  const issues = await buildClient().fetchCandidateIssues();

  assert.equal(issues.length, 1, "only the Todo row is an active candidate");
  const dev1 = issues[0]!;
  assert.equal(dev1.identifier, "DEV-1");
  assert.equal(dev1.state, "Todo");
  assert.ok(!issues.some((i) => i.state === "Done"), "the Done control row must be ignored");
});

test("[real-Notion] a live Dev Board row normalizes to a fully-populated §4 Issue [FR5]", async () => {
  const [dev1] = await buildClient().fetchCandidateIssues();

  assert.equal(dev1!.id, "39750d30-8227-8137-a614-eacc34c33b7e");
  assert.equal(dev1!.title, "Walking-skeleton smoke: self-complete");
  assert.equal(dev1!.priority, 1);
  assert.deepEqual(dev1!.labels, ["demo", "walking-skeleton"]);
  // The real board has no blocked-by relation -> [] (FR5 absence case).
  assert.deepEqual(dev1!.blocked_by, []);
  assert.equal(dev1!.created_at, "2026-07-08T20:13:27.000Z");
});

test("[real-Notion] state-refresh returns the current state for a known id [FR4]", async () => {
  const client = buildClient();
  const refreshed = await client.fetchIssueStatesByIds(["39750d30-8227-8127-a350-c6bc3dc2522d"]);

  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0]!.identifier, "DEV-2");
  assert.equal(refreshed[0]!.state, "Done");
});
