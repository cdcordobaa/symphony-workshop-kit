/**
 * smoke:tracker — evidence that the Tracker layer (SYM-004 / ARK-52) does its
 * real job (§11): query the Symphony Dev Board, filter to active states, and
 * normalize each Notion row into the §4 `Issue` model.
 *
 * The board is reachable in this environment only through the connected
 * claude.ai Notion connector (OAuth), which a standalone `tsx` process cannot
 * assume. So this smoke drives the FULL production pipeline — `SqlNotionMcp`
 * (SQL build + `{results}` parse) → `NotionTrackerClient` → normalizer — over a
 * payload captured LIVE from the real Dev Board (see the fixture's `_provenance`).
 * The only substituted seam is the raw socket; all tracker logic is real.
 *
 * Usage: `tsx smoke/tracker.ts`
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveConfig } from "../src/config/config.js";
import { parseWorkflow } from "../src/config/loader.js";
import { createLogger } from "../src/observability/logger.js";
import { NotionTrackerClient } from "../src/tracker/notion-tracker-client.js";
import { SqlNotionMcp, type NotionToolInvoker } from "../src/tracker/notion-mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const capturePath = join(here, "..", "test", "integration", "fixtures", "dev-board.capture.json");
const capture = JSON.parse(readFileSync(capturePath, "utf8"));

const SECRET = "ntn_live_token_must_never_be_printed";

/** Replay the recorded live Dev Board payloads (active query carries a WHERE clause). */
const invoke: NotionToolInvoker = async (_tool, args) => {
  const query = String((args.data as { query?: unknown }).query ?? "");
  return /where/i.test(query) ? capture.queryActive : capture.queryAll;
};

async function main(): Promise<void> {
  console.log("[smoke:tracker] source: REAL Symphony Dev Board capture");
  console.log(`  data_source: ${capture._provenance.data_source_url}`);
  console.log(`  captured_at: ${capture._provenance.captured_at}`);
  console.log(`  active_states: ${JSON.stringify(capture._provenance.active_states)}\n`);

  const config = resolveConfig(
    parseWorkflow(
      ["---", `tracker:\n  kind: notion\n  auth: "${SECRET}"`, "---", "body"].join("\n"),
      "/repo/WORKFLOW.md",
    ),
  );

  // Structured logger with the secret registered so we can prove FR21 at the end.
  const logs: string[] = [];
  const logger = createLogger({
    sinks: [{ write: (r) => void logs.push(JSON.stringify(r)) }],
    level: "debug",
    secrets: [SECRET],
  });

  const transport = new SqlNotionMcp({
    dataSourceUrl: capture._provenance.data_source_url,
    invoke,
  });
  const tracker = new NotionTrackerClient({ transport, config, logger });

  const candidates = await tracker.fetchCandidateIssues();
  console.log(`[smoke:tracker] fetchCandidateIssues() -> ${candidates.length} candidate(s):`);
  for (const issue of candidates) {
    console.log(
      `  ${issue.identifier}  state=${issue.state}  priority=${issue.priority}  ` +
        `labels=${JSON.stringify(issue.labels)}  blocked_by=${JSON.stringify(issue.blocked_by)}`,
    );
    console.log(`    normalized §4 Issue: ${JSON.stringify(issue)}`);
  }

  // State-refresh of the Done control row by its real page id (§11.1 #3 / FR4).
  const doneId = "39750d30-8227-8127-a350-c6bc3dc2522d";
  const [refreshed] = await tracker.fetchIssueStatesByIds([doneId]);
  console.log(
    `\n[smoke:tracker] fetchIssueStatesByIds(["${doneId.slice(0, 8)}…"]) -> ` +
      `${refreshed?.identifier} state=${refreshed?.state}`,
  );

  const onlyActive = candidates.length === 1 && candidates[0]!.state === "Todo";
  const noneDone = !candidates.some((i) => i.state === "Done");
  const blockedByEmpty = candidates.every((i) => Array.isArray(i.blocked_by) && i.blocked_by.length === 0);
  const secretSafe = !logs.join("").includes(SECRET);

  console.log("\n[smoke:tracker] checks:");
  console.log(`  active-state filtering (Todo in, Done out) [FR3]: ${onlyActive && noneDone}`);
  console.log(`  full §4 normalization [FR5]: ${candidates.every((i) => i.identifier && i.title && i.state)}`);
  console.log(`  blocked_by=[] when board has no relation [FR5]: ${blockedByEmpty}`);
  console.log(`  state-refresh returns current state [FR4]: ${refreshed?.state === "Done"}`);
  console.log(`  tracker.auth never logged [FR21]: ${secretSafe}`);

  const ok = onlyActive && noneDone && blockedByEmpty && refreshed?.state === "Done" && secretSafe;
  console.log(`\n[smoke:tracker] done — ${ok ? "PASS" : "FAIL"}.`);
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(`[smoke:tracker] FAILED: ${(error as Error).message}`);
  process.exit(1);
});
