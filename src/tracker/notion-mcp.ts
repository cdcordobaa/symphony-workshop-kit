/**
 * Notion MCP transport seam (Symphony spec §11.1–11.2, adapted Linear → Notion).
 *
 * The orchestrator talks to Notion through a Model Context Protocol server. The
 * exact server (the connected `claude.ai` Notion connector vs. a standalone
 * `@notionhq/notion-mcp-server`) and the data-source-vs-database binding are
 * Construction details (PRD §10) that MUST NOT leak upward. So this module
 * exposes two layers:
 *
 *   1. {@link NotionToolInvoker} — the raw MCP boundary: "call this tool with
 *      these args, hand me back whatever JSON it returns". This is the single
 *      seam mocked in tests and backed by a real MCP client in production.
 *   2. {@link NotionMcp} — the narrow, tracker-facing port (query by states /
 *      query by ids). {@link SqlNotionMcp} implements it on top of an invoker by
 *      building parameterized SQL for the connector's `query_data_sources` tool
 *      and parsing the `{ results: [...] }` envelope into {@link NotionRawRow}s.
 *
 * The {@link NotionTrackerClient} depends only on {@link NotionMcp}; it never
 * sees a tool name, a SQL string, or a data-source URL.
 */

import { TrackerError } from "./errors.js";

/**
 * A single Notion row as returned by the connector's SQL query mode. Only the
 * fields the normalizer reads are named; everything else is passed through.
 * `Labels` arrives as a JSON-encoded string (e.g. `'["demo","x"]'`) or `null`.
 */
export interface NotionRawRow {
  /** Notion page id (stable internal id). */
  id?: string | null;
  url?: string | null;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  /** Board auto-increment id; combined with a prefix to form the identifier. */
  "userDefined:ID"?: number | string | null;
  Name?: string | null;
  Status?: string | null;
  Priority?: number | string | null;
  Labels?: string | string[] | null;
  [key: string]: unknown;
}

/**
 * The raw MCP tool boundary. Given a tool name and its arguments, return the
 * tool's parsed JSON result. Implementations wrap a real MCP client; tests pass
 * a function that returns canned or recorded payloads.
 */
export type NotionToolInvoker = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Tracker-facing transport port. Both methods are read-only and return raw rows
 * for the normalizer; an empty input yields `[]` with no tool call (§11.1).
 */
export interface NotionMcp {
  /** Rows whose `Status` is one of `states`. */
  queryByStates(states: string[]): Promise<NotionRawRow[]>;
  /** Current rows for the given Notion page ids. */
  queryByIds(ids: string[]): Promise<NotionRawRow[]>;
}

/** Tool name for the connector's SQL query mode (claude.ai Notion connector). */
const QUERY_TOOL = "notion-query-data-sources";

export interface SqlNotionMcpOptions {
  /** Fully-qualified data-source URL, e.g. `collection://<uuid>`. */
  dataSourceUrl: string;
  /** Raw MCP invoker (real client in prod; fake/recorded in tests). */
  invoke: NotionToolInvoker;
}

/**
 * {@link NotionMcp} backed by the connector's `notion-query-data-sources` (SQL)
 * tool. Builds parameterized SQL so state names are never string-interpolated,
 * then parses the `{ results }` envelope. Transport/parse failures become
 * recoverable {@link TrackerError}s.
 */
export class SqlNotionMcp implements NotionMcp {
  private readonly dataSourceUrl: string;
  private readonly invoke: NotionToolInvoker;

  constructor(options: SqlNotionMcpOptions) {
    this.dataSourceUrl = options.dataSourceUrl;
    this.invoke = options.invoke;
  }

  async queryByStates(states: string[]): Promise<NotionRawRow[]> {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    const query =
      `SELECT * FROM "${this.dataSourceUrl}" WHERE "Status" IN (${placeholders})`;
    return this.run(query, [...states]);
  }

  async queryByIds(ids: string[]): Promise<NotionRawRow[]> {
    if (ids.length === 0) return [];
    // `id` is not a queryable SQLite column in the connector's schema, so we read
    // the (small) data source and filter by page id in memory. Correct for the
    // active-run reconciliation use case (§11.1) where `ids` is a handful.
    const wanted = new Set(ids);
    const query = `SELECT * FROM "${this.dataSourceUrl}"`;
    const rows = await this.run(query, []);
    return rows.filter((row) => typeof row.id === "string" && wanted.has(row.id));
  }

  /** Invoke the SQL tool and parse its `{ results }` envelope into rows. */
  private async run(query: string, params: string[]): Promise<NotionRawRow[]> {
    let payload: unknown;
    try {
      payload = await this.invoke(QUERY_TOOL, {
        data: { mode: "sql", data_source_urls: [this.dataSourceUrl], query, params },
      });
    } catch (error) {
      throw new TrackerError(
        "notion_mcp_request",
        `Notion MCP query failed: ${(error as Error)?.message ?? String(error)}`,
        error,
      );
    }
    return parseRows(payload);
  }
}

/**
 * Extract the `results` array from a tool payload, tolerating the couple of
 * envelope shapes an MCP tool may hand back (direct object, or a `content`
 * text-block wrapping a JSON string).
 */
export function parseRows(payload: unknown): NotionRawRow[] {
  const envelope = coerceEnvelope(payload);
  const results = (envelope as { results?: unknown })?.results;
  if (!Array.isArray(results)) {
    throw new TrackerError(
      "notion_unknown_payload",
      "Notion MCP payload did not contain a `results` array.",
    );
  }
  return results.filter((row): row is NotionRawRow => typeof row === "object" && row !== null);
}

/** Normalize the outer payload to a plain object with a `results` field. */
function coerceEnvelope(payload: unknown): unknown {
  if (typeof payload === "string") return safeJson(payload);
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    // MCP tool-call results are sometimes wrapped as `{ content: [{ type, text }] }`.
    if (Array.isArray(obj.content)) {
      const text = obj.content
        .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : undefined))
        .find((t): t is string => typeof t === "string");
      if (text !== undefined) return safeJson(text);
    }
    return obj;
  }
  throw new TrackerError("notion_unknown_payload", "Notion MCP payload was not an object.");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TrackerError("notion_unknown_payload", "Notion MCP payload was not valid JSON.", error);
  }
}

/**
 * Resolve a Notion database id into its primary data-source URL by fetching the
 * database and reading the first `<data-source url="collection://…">` tag. The
 * database id and the data-source id differ (PRD §10); production wiring calls
 * this once at startup so the tracker can be handed a ready {@link SqlNotionMcp}.
 */
export async function resolveDataSourceUrl(
  invoke: NotionToolInvoker,
  databaseId: string,
): Promise<string> {
  let payload: unknown;
  try {
    payload = await invoke("notion-fetch", { id: databaseId });
  } catch (error) {
    throw new TrackerError(
      "notion_mcp_request",
      `Notion MCP fetch failed while resolving data source: ${(error as Error)?.message ?? String(error)}`,
      error,
    );
  }
  const text = extractText(payload);
  const match = text.match(/collection:\/\/[0-9a-f-]{36}/i);
  if (!match) {
    throw new TrackerError(
      "notion_unknown_payload",
      `Could not resolve a data-source URL for database ${databaseId}.`,
    );
  }
  return match[0];
}

/** Pull a text blob out of a fetch payload (object `.text` or content blocks). */
function extractText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.content)) {
      return obj.content
        .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : ""))
        .filter((t): t is string => typeof t === "string")
        .join("\n");
    }
  }
  return "";
}
