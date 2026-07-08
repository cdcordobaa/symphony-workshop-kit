import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../../src/config/config.js";
import { parseWorkflow } from "../../src/config/loader.js";
import type { LogRecord } from "../../src/domain/interfaces.js";
import type { ServiceConfig } from "../../src/domain/types.js";
import { createLogger } from "../../src/observability/logger.js";
import { NotionTrackerClient } from "../../src/tracker/notion-tracker-client.js";
import { TrackerError } from "../../src/tracker/errors.js";
import type { NotionMcp, NotionRawRow } from "../../src/tracker/notion-mcp.js";

const SECRET = "ntn_super-secret-token-value";

/** Build a real ServiceConfig with a literal secret auth so FR21 can be exercised. */
function config(frontMatter = `tracker:\n  kind: notion\n  auth: "${SECRET}"`): ServiceConfig {
  return resolveConfig(parseWorkflow(["---", frontMatter, "---", "body"].join("\n"), "/repo/WORKFLOW.md"));
}

/** Capturing logger + the raw records + a helper to render everything as one blob. */
function captureLogger() {
  const records: LogRecord[] = [];
  const logger = createLogger({ sinks: [{ write: (r) => void records.push(r) }], level: "debug" });
  return { logger, records, blob: () => JSON.stringify(records) };
}

/** A controllable in-memory transport. */
function fakeMcp(rows: NotionRawRow[], opts: { throwOn?: "states" | "ids" } = {}): NotionMcp & {
  stateCalls: string[][];
  idCalls: string[][];
} {
  const stateCalls: string[][] = [];
  const idCalls: string[][] = [];
  return {
    stateCalls,
    idCalls,
    async queryByStates(states) {
      stateCalls.push(states);
      if (opts.throwOn === "states") throw new Error("notion 503");
      return rows.filter((r) => states.includes(String(r.Status)));
    },
    async queryByIds(ids) {
      idCalls.push(ids);
      if (opts.throwOn === "ids") throw new Error("notion 503");
      return rows.filter((r) => typeof r.id === "string" && ids.includes(r.id));
    },
  };
}

const ROWS: NotionRawRow[] = [
  { id: "a", "userDefined:ID": 1, Status: "Todo", Name: "A", Priority: 1 },
  { id: "b", "userDefined:ID": 2, Status: "Done", Name: "B", Priority: 3 },
  { id: "c", "userDefined:ID": 3, Status: "In Progress", Name: "C", Priority: 2 },
];

test("fetchCandidateIssues returns only rows whose Status ∈ active_states [FR3]", async () => {
  const { logger } = captureLogger();
  const mcp = fakeMcp(ROWS);
  const client = new NotionTrackerClient({ transport: mcp, config: config(), logger });

  const issues = await client.fetchCandidateIssues();

  assert.deepEqual(mcp.stateCalls, [["Todo", "In Progress"]]);
  assert.deepEqual(
    issues.map((i) => i.identifier).sort(),
    ["DEV-1", "DEV-3"],
  );
  assert.ok(!issues.some((i) => i.state === "Done"));
});

test("fetchIssueStatesByIds returns the current state for known ids [FR4]", async () => {
  const { logger } = captureLogger();
  const mcp = fakeMcp(ROWS);
  const client = new NotionTrackerClient({ transport: mcp, config: config(), logger });

  const issues = await client.fetchIssueStatesByIds(["b"]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.id, "b");
  assert.equal(issues[0]!.state, "Done");
});

test("empty inputs short-circuit to [] without a transport call", async () => {
  const { logger } = captureLogger();
  const mcp = fakeMcp(ROWS);
  const client = new NotionTrackerClient({ transport: mcp, config: config(), logger });

  assert.deepEqual(await client.fetchIssueStatesByIds([]), []);
  assert.deepEqual(await client.fetchIssuesByStates([]), []);
  assert.equal(mcp.idCalls.length, 0);
  assert.equal(mcp.stateCalls.length, 0);
});

test("fetchIssuesByStates queries the requested states (terminal cleanup)", async () => {
  const { logger } = captureLogger();
  const mcp = fakeMcp(ROWS);
  const client = new NotionTrackerClient({ transport: mcp, config: config(), logger });

  const issues = await client.fetchIssuesByStates(["Done"]);
  assert.deepEqual(mcp.stateCalls, [["Done"]]);
  assert.deepEqual(issues.map((i) => i.identifier), ["DEV-2"]);
});

test("a transient transport failure surfaces as a recoverable TrackerError (no crash) [NFR reliability]", async () => {
  const { logger } = captureLogger();
  const mcp = fakeMcp(ROWS, { throwOn: "states" });
  const client = new NotionTrackerClient({ transport: mcp, config: config(), logger });

  await assert.rejects(client.fetchCandidateIssues(), (err: unknown) => {
    assert.ok(err instanceof TrackerError);
    assert.equal(err.recoverable, true);
    return true;
  });
});

test("tracker.auth is read from config and NEVER logged, even on failure [FR21]", async () => {
  const { logger, blob } = captureLogger();
  const cfg = config();
  assert.equal(cfg.tracker.auth, SECRET); // read from resolved config

  const mcp = fakeMcp(ROWS, { throwOn: "states" });
  const client = new NotionTrackerClient({ transport: mcp, config: cfg, logger });

  await assert.rejects(client.fetchCandidateIssues());
  // The secret must not appear in any emitted log record.
  assert.ok(!blob().includes(SECRET), "auth token leaked into logs");
});

test("an unsupported tracker.kind is rejected at construction", () => {
  const { logger } = captureLogger();
  const mcp = fakeMcp(ROWS);
  assert.throws(
    () => new NotionTrackerClient({ transport: mcp, config: config("tracker:\n  kind: jira"), logger }),
    (err: unknown) => {
      assert.ok(err instanceof TrackerError);
      assert.equal(err.code, "unsupported_tracker_kind");
      return true;
    },
  );
});
