/**
 * Live Notion transport (REST) for the tracker — the concrete `NotionMcp` used
 * when the product runs for real against a Notion board.
 *
 * Why REST and not the claude.ai connector: the connector's Notion MCP is only
 * reachable by *Claude* processes (this CLI, spawned agents) via the user's
 * OAuth session. The orchestrator daemon is a plain Node process, so it reads
 * the board directly through the Notion REST API using a Notion internal
 * integration token (`tracker.auth`, e.g. `$NOTION_API_KEY`). The spawned agent
 * still writes ticket state back via *its* connector (spec §11.5).
 *
 * This implements the same {@link NotionMcp} port as {@link SqlNotionMcp} and
 * returns the identical flat {@link NotionRawRow} shape the normalizer consumes,
 * so nothing downstream changes.
 */

import { TrackerError } from "./errors.js";
import type { NotionMcp, NotionRawRow } from "./notion-mcp.js";

const NOTION_API = "https://api.notion.com/v1";
const DEFAULT_VERSION = "2022-06-28";

export interface RestNotionMcpOptions {
  /** Notion internal integration token (never logged). */
  token: string;
  /** Notion database id backing the board. */
  databaseId: string;
  /** Status property name on the board. Default `"Status"`. */
  statusProperty?: string;
  /** Notion API version header. Default `2022-06-28`. */
  notionVersion?: string;
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
}

/** A raw Notion REST page (only the parts we read). */
interface NotionPage {
  id?: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  properties?: Record<string, any>;
}

export class RestNotionMcp implements NotionMcp {
  private readonly token: string;
  private readonly databaseId: string;
  private readonly statusProperty: string;
  private readonly version: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: RestNotionMcpOptions) {
    this.token = options.token;
    this.databaseId = options.databaseId;
    this.statusProperty = options.statusProperty ?? "Status";
    this.version = options.notionVersion ?? DEFAULT_VERSION;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** Rows whose Status is one of `states` (filtered client-side for robustness). */
  async queryByStates(states: string[]): Promise<NotionRawRow[]> {
    if (states.length === 0) return [];
    const want = new Set(states);
    const rows: NotionRawRow[] = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const json = await this.request("POST", `/databases/${this.databaseId}/query`, body);
      for (const page of (json.results as NotionPage[]) ?? []) {
        const row = flattenPage(page, this.statusProperty);
        if (row.Status != null && want.has(String(row.Status))) rows.push(row);
      }
      cursor = json.has_more ? (json.next_cursor as string) : undefined;
    } while (cursor);
    return rows;
  }

  /** Current rows for the given Notion page ids (missing pages are skipped). */
  async queryByIds(ids: string[]): Promise<NotionRawRow[]> {
    const rows: NotionRawRow[] = [];
    for (const id of ids) {
      const page = await this.request("GET", `/pages/${id}`, undefined, true);
      if (page) rows.push(flattenPage(page as NotionPage, this.statusProperty));
    }
    return rows;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    allowMissing = false,
  ): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${NOTION_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": this.version,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network/transport failure → recoverable so the orchestrator skips the tick.
      throw new TrackerError(
        "notion_mcp_request",
        `Notion REST request failed: ${(err as Error).message}`,
        err,
      );
    }
    if (allowMissing && res.status === 404) return null;
    if (!res.ok) {
      // Note: never include the token; Notion error bodies do not echo it.
      throw new TrackerError("notion_mcp_request", `Notion REST ${method} ${path} → HTTP ${res.status}`);
    }
    return res.json();
  }
}

/** Flatten a Notion REST page into the flat {@link NotionRawRow} the normalizer reads. */
export function flattenPage(page: NotionPage, statusProperty = "Status"): NotionRawRow {
  const props = page.properties ?? {};
  const prop = (name: string) => props[name] ?? {};

  const title = (prop("Name").title ?? []) as Array<{ plain_text?: string }>;
  const statusP = prop(statusProperty);
  const labels = (prop("Labels").multi_select ?? []) as Array<{ name?: string }>;
  const uniqueId = findUniqueId(props);

  return {
    id: page.id ?? null,
    url: page.url ?? null,
    createdTime: page.created_time ?? null,
    lastEditedTime: page.last_edited_time ?? null,
    "userDefined:ID": uniqueId,
    Name: title.map((t) => t.plain_text ?? "").join("") || null,
    // Board may model Status as either a `select` or a `status` property.
    Status: statusP.select?.name ?? statusP.status?.name ?? null,
    Priority: typeof prop("Priority").number === "number" ? prop("Priority").number : null,
    Labels: labels.map((l) => l.name ?? "").filter(Boolean),
  };
}

/** The board's auto-increment id (any `unique_id` property) → number, else null. */
function findUniqueId(props: Record<string, any>): number | null {
  for (const value of Object.values(props)) {
    if (value?.type === "unique_id" && typeof value.unique_id?.number === "number") {
      return value.unique_id.number;
    }
  }
  return null;
}
