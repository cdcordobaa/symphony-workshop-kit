import { test } from "node:test";
import assert from "node:assert/strict";
import { RestNotionMcp, flattenPage } from "../../src/tracker/notion-rest.js";
import { TrackerError } from "../../src/tracker/errors.js";

/** A Notion REST page shaped like the real Symphony Dev Board rows. */
function page(id: string, status: string, num: number, name: string, labels: string[] = []) {
  return {
    id,
    url: `https://www.notion.so/${id.replace(/-/g, "")}`,
    created_time: "2026-07-08T20:13:27.000Z",
    last_edited_time: "2026-07-08T21:00:00.000Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: name }] },
      Status: { type: "select", select: { name: status } },
      Priority: { type: "number", number: num },
      Labels: { type: "multi_select", multi_select: labels.map((l) => ({ name: l })) },
      ID: { type: "unique_id", unique_id: { prefix: "DEV", number: num } },
    },
  };
}

const DEV1 = page("39750d30-8227-8137-a614-eacc34c33b7e", "Todo", 1, "Walking-skeleton smoke: self-complete", ["demo", "walking-skeleton"]);
const DEV2 = page("39750d30-8227-8127-a350-c6bc3dc2522d", "Done", 2, "Control: already Done (must be ignored)");

function ok(bodyObj: unknown) {
  return { ok: true, status: 200, json: async () => bodyObj } as unknown as Response;
}

test("flattenPage maps a REST page to the flat NotionRawRow the normalizer reads", () => {
  const row = flattenPage(DEV1 as any);
  assert.equal(row.id, "39750d30-8227-8137-a614-eacc34c33b7e");
  assert.equal(row.Name, "Walking-skeleton smoke: self-complete");
  assert.equal(row.Status, "Todo");
  assert.equal(row.Priority, 1);
  assert.deepEqual(row.Labels, ["demo", "walking-skeleton"]);
  assert.equal(row["userDefined:ID"], 1);
  assert.equal(row.createdTime, "2026-07-08T20:13:27.000Z");
});

test("queryByStates returns only rows whose Status is in the requested set [FR3]", async () => {
  const fetchImpl = (async () => ok({ results: [DEV2, DEV1], has_more: false })) as unknown as typeof fetch;
  const mcp = new RestNotionMcp({ token: "ntn_secret", databaseId: "db1", fetchImpl });
  const todo = await mcp.queryByStates(["Todo"]);
  assert.equal(todo.length, 1);
  assert.equal(todo[0].id, DEV1.id);
  const done = await mcp.queryByStates(["Done"]);
  assert.equal(done.length, 1);
  assert.equal(done[0].id, DEV2.id);
});

test("queryByStates([]) makes no request and returns []", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return ok({ results: [] }); }) as unknown as typeof fetch;
  const mcp = new RestNotionMcp({ token: "t", databaseId: "db1", fetchImpl });
  assert.deepEqual(await mcp.queryByStates([]), []);
  assert.equal(called, false);
});

test("queryByStates paginates via next_cursor", async () => {
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body.start_cursor ?? null);
    return body.start_cursor
      ? ok({ results: [DEV2], has_more: false })
      : ok({ results: [DEV1], has_more: true, next_cursor: "cur2" });
  }) as unknown as typeof fetch;
  const mcp = new RestNotionMcp({ token: "t", databaseId: "db1", fetchImpl });
  const rows = await mcp.queryByStates(["Todo", "Done"]);
  assert.deepEqual(rows.map((r) => r.id), [DEV1.id, DEV2.id]);
  assert.deepEqual(calls, [null, "cur2"]);
});

test("queryByIds fetches each page and skips 404s", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith(DEV1.id)) return ok(DEV1);
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  const mcp = new RestNotionMcp({ token: "t", databaseId: "db1", fetchImpl });
  const rows = await mcp.queryByIds([DEV1.id, "missing-id"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Status, "Todo");
});

test("a non-2xx surfaces a recoverable TrackerError without leaking the token", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
  const mcp = new RestNotionMcp({ token: "ntn_super_secret", databaseId: "db1", fetchImpl });
  await assert.rejects(
    () => mcp.queryByStates(["Todo"]),
    (err: unknown) => {
      assert.ok(err instanceof TrackerError);
      assert.equal((err as TrackerError).recoverable, true);
      assert.ok(!String((err as Error).message).includes("ntn_super_secret"));
      return true;
    },
  );
});
