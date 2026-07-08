import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SqlNotionMcp,
  parseRows,
  resolveDataSourceUrl,
  type NotionToolInvoker,
} from "../../src/tracker/notion-mcp.js";
import { TrackerError } from "../../src/tracker/errors.js";

const DS = "collection://c29d9c6a-0db6-4dcb-bb52-66a0ac769468";

const TODO_ROW = {
  id: "row-1",
  "userDefined:ID": 1,
  Status: "Todo",
  Name: "One",
  Labels: '["x"]',
  Priority: 1,
};
const DONE_ROW = {
  id: "row-2",
  "userDefined:ID": 2,
  Status: "Done",
  Name: "Two",
  Labels: null,
  Priority: 3,
};

/** An invoker that records the calls it received and returns a canned payload. */
function recordingInvoker(payload: unknown) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const invoke: NotionToolInvoker = async (tool, args) => {
    calls.push({ tool, args });
    return payload;
  };
  return { invoke, calls };
}

test("queryByStates builds parameterized SQL and never interpolates state names", async () => {
  const { invoke, calls } = recordingInvoker({ results: [TODO_ROW] });
  const mcp = new SqlNotionMcp({ dataSourceUrl: DS, invoke });

  const rows = await mcp.queryByStates(["Todo", "In Progress"]);

  assert.equal(calls.length, 1);
  const { tool, args } = calls[0]!;
  assert.equal(tool, "notion-query-data-sources");
  const data = args.data as { query: string; params: string[]; data_source_urls: string[] };
  assert.match(data.query, /WHERE "Status" IN \(\?, \?\)/);
  assert.deepEqual(data.params, ["Todo", "In Progress"]);
  assert.deepEqual(data.data_source_urls, [DS]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "row-1");
});

test("queryByStates short-circuits on empty input with no tool call", async () => {
  const { invoke, calls } = recordingInvoker({ results: [] });
  const mcp = new SqlNotionMcp({ dataSourceUrl: DS, invoke });
  assert.deepEqual(await mcp.queryByStates([]), []);
  assert.equal(calls.length, 0);
});

test("queryByIds filters the data source to the requested page ids", async () => {
  const { invoke } = recordingInvoker({ results: [TODO_ROW, DONE_ROW] });
  const mcp = new SqlNotionMcp({ dataSourceUrl: DS, invoke });

  const rows = await mcp.queryByIds(["row-2"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "row-2");
});

test("queryByIds short-circuits on empty input with no tool call", async () => {
  const { invoke, calls } = recordingInvoker({ results: [] });
  const mcp = new SqlNotionMcp({ dataSourceUrl: DS, invoke });
  assert.deepEqual(await mcp.queryByIds([]), []);
  assert.equal(calls.length, 0);
});

test("transport failures become recoverable TrackerErrors [NFR reliability]", async () => {
  const invoke: NotionToolInvoker = async () => {
    throw new Error("socket hang up");
  };
  const mcp = new SqlNotionMcp({ dataSourceUrl: DS, invoke });

  await assert.rejects(mcp.queryByStates(["Todo"]), (err: unknown) => {
    assert.ok(err instanceof TrackerError);
    assert.equal(err.code, "notion_mcp_request");
    assert.equal(err.recoverable, true);
    return true;
  });
});

test("parseRows accepts a direct envelope and a content-wrapped JSON string", () => {
  assert.equal(parseRows({ results: [TODO_ROW] }).length, 1);
  assert.equal(parseRows(JSON.stringify({ results: [TODO_ROW, DONE_ROW] })).length, 2);
  assert.equal(
    parseRows({ content: [{ type: "text", text: JSON.stringify({ results: [TODO_ROW] }) }] }).length,
    1,
  );
});

test("parseRows rejects a payload without a results array", () => {
  assert.throws(() => parseRows({ nope: true }), (err: unknown) => {
    assert.ok(err instanceof TrackerError);
    assert.equal(err.code, "notion_unknown_payload");
    return true;
  });
});

test("resolveDataSourceUrl extracts the collection URL from a database fetch", async () => {
  const fetchText = {
    text: `<database><data-sources><data-source url="{{${DS}}}">…</data-source></data-sources></database>`,
  };
  const { invoke } = recordingInvoker(fetchText);
  assert.equal(await resolveDataSourceUrl(invoke, "1c7826ea19e443b9addd794981606d56"), DS);
});
