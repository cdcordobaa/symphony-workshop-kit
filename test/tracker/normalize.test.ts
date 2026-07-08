import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeBlockedBy,
  normalizeLabels,
  normalizeRow,
  parseTimestamp,
} from "../../src/tracker/normalize.js";
import { TrackerError } from "../../src/tracker/errors.js";
import type { NotionRawRow } from "../../src/tracker/notion-mcp.js";

/** A row shaped exactly like the real Symphony Dev Board SQL result (DEV-1). */
function devRow(overrides: Partial<NotionRawRow> = {}): NotionRawRow {
  return {
    id: "39750d30-8227-8137-a614-eacc34c33b7e",
    url: "https://app.notion.com/39750d3082278137a614eacc34c33b7e",
    createdTime: "2026-07-08 20:13:27Z",
    "userDefined:ID": 1,
    Labels: '["demo","walking-skeleton"]',
    Priority: 1,
    Status: "Todo",
    Name: "Walking-skeleton smoke: self-complete",
    ...overrides,
  };
}

test("normalizeRow populates every §4 Issue field from a real Notion row [FR5]", () => {
  const issue = normalizeRow(devRow());

  assert.equal(issue.id, "39750d30-8227-8137-a614-eacc34c33b7e");
  assert.equal(issue.identifier, "DEV-1");
  assert.equal(issue.title, "Walking-skeleton smoke: self-complete");
  assert.equal(issue.state, "Todo");
  assert.equal(issue.priority, 1);
  assert.deepEqual(issue.labels, ["demo", "walking-skeleton"]);
  assert.deepEqual(issue.blocked_by, []);
  assert.equal(issue.url, "https://app.notion.com/39750d3082278137a614eacc34c33b7e");
  assert.equal(issue.created_at, "2026-07-08T20:13:27.000Z");
  // Fields the board does not carry are explicitly null, not undefined.
  assert.equal(issue.description, null);
  assert.equal(issue.branch_name, null);
  assert.equal(issue.updated_at, null);
});

test("normalizeRow honors a custom identifier prefix", () => {
  const issue = normalizeRow(devRow({ "userDefined:ID": 42 }), { identifierPrefix: "SYM" });
  assert.equal(issue.identifier, "SYM-42");
});

test("normalizeRow falls back to the page id when no numeric board id exists", () => {
  const issue = normalizeRow(devRow({ "userDefined:ID": null }));
  assert.equal(issue.identifier, "39750d30-8227-8137-a614-eacc34c33b7e");
});

test("normalizeRow throws a recoverable TrackerError when the page id is missing", () => {
  assert.throws(() => normalizeRow(devRow({ id: null })), (err: unknown) => {
    assert.ok(err instanceof TrackerError);
    assert.equal(err.code, "notion_normalize_error");
    assert.equal(err.recoverable, true);
    return true;
  });
});

test("normalizeLabels lowercases and tolerates JSON-string, array, null, and empty [FR5]", () => {
  assert.deepEqual(normalizeLabels('["Demo","Walking-Skeleton"]'), ["demo", "walking-skeleton"]);
  assert.deepEqual(normalizeLabels(["A", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeLabels(null), []);
  assert.deepEqual(normalizeLabels(""), []);
  assert.deepEqual(normalizeLabels("single"), ["single"]);
  // Notion option objects with a `name` field.
  assert.deepEqual(normalizeLabels([{ name: "Backend" }]), ["backend"]);
});

test("normalizeBlockedBy maps a relation to BlockerRef[]; absence yields [] [FR5]", () => {
  // Present: array of best-effort relation objects.
  assert.deepEqual(
    normalizeBlockedBy([{ id: "iss-0", identifier: "DEV-9", state: "In Progress" }]),
    [{ id: "iss-0", identifier: "DEV-9", state: "In Progress" }],
  );
  // Present: array of bare ids.
  assert.deepEqual(normalizeBlockedBy(["iss-7"]), [{ id: "iss-7", identifier: null, state: null }]);
  // Absent (the real Dev Board case): undefined / null / non-array -> [].
  assert.deepEqual(normalizeBlockedBy(undefined), []);
  assert.deepEqual(normalizeBlockedBy(null), []);
  assert.deepEqual(normalizeBlockedBy("nope"), []);
});

test("normalizeRow reads blocked_by from a configured relation property when present [FR5]", () => {
  const row = devRow({ "Blocked By": [{ id: "iss-0", identifier: "DEV-2", state: "Done" }] });
  const issue = normalizeRow(row);
  assert.deepEqual(issue.blocked_by, [{ id: "iss-0", identifier: "DEV-2", state: "Done" }]);
});

test("priority keeps integers only; non-integers become null (§11.3)", () => {
  assert.equal(normalizeRow(devRow({ Priority: 3 })).priority, 3);
  assert.equal(normalizeRow(devRow({ Priority: "2" })).priority, 2);
  assert.equal(normalizeRow(devRow({ Priority: 1.5 })).priority, null);
  assert.equal(normalizeRow(devRow({ Priority: null })).priority, null);
});

test("parseTimestamp accepts the connector's space-separated form and rejects garbage", () => {
  assert.equal(parseTimestamp("2026-07-08 20:13:27Z"), "2026-07-08T20:13:27.000Z");
  assert.equal(parseTimestamp("2026-07-08T20:13:27.000Z"), "2026-07-08T20:13:27.000Z");
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp("not-a-date"), null);
});
