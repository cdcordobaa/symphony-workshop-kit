/**
 * Notion MCP transport boundary (U2; requirements.md FR-TR-2, §11.2 adapted).
 *
 * The Notion tracker talks to Notion exclusively through the **Notion MCP**
 * server. This interface is the seam between our read-only adapter logic and the
 * concrete MCP client/library, which the task spec leaves to "implementation
 * time". Keeping it abstract:
 *
 *  - lets the tracker be unit-tested against an in-memory mock (no network),
 *  - keeps the read-only boundary auditable (the interface exposes NO write op),
 *  - lets the MCP client library be swapped without touching tracker logic.
 *
 * Auth: the transport is constructed with the configured Notion auth (resolved
 * from `$VAR` upstream by U1). No code here reads a token from disk.
 */

import type { NotionPage } from "./normalize.js";

/** One page of a paginated database query, preserving Notion's result order. */
export interface NotionQueryPage {
  /** Pages in this slice, in tracker order. */
  pages: NotionPage[];
  /** Cursor to pass back for the next page; null/absent ⇒ no more pages. */
  next_cursor: string | null;
  /** Whether another page is available. */
  has_more: boolean;
}

/** Parameters for a single database/data-source query call. */
export interface NotionQueryParams {
  /** Configured Notion database / data-source identifier (FR-TR-3). */
  database: string;
  /** Status names to include (the configured `active_states`). */
  states: string[];
  /** Name of the Status property to filter on. */
  statusProperty: string;
  /** Opaque pagination cursor from the previous page; null for the first page. */
  startCursor: string | null;
  /** Max pages per request (network/pagination tuning). */
  pageSize: number;
}

/**
 * Read-only Notion MCP transport. Implementations MUST NOT expose any mutation:
 * ticket writes are performed by the Claude Code agent via its own MCP tools
 * (FR-TR-6), never here.
 */
export interface NotionMcpTransport {
  /**
   * Query one page of the configured database for pages whose Status is in
   * `states`. Implementations apply the network timeout (§11.2 / FR-TR-4).
   */
  queryDatabase(params: NotionQueryParams): Promise<NotionQueryPage>;

  /**
   * Fetch raw pages by their Notion page ids (used for reconciliation refresh).
   * Implementations SHOULD return only the pages that resolved; unknown ids are
   * simply omitted.
   */
  fetchPagesByIds(ids: string[]): Promise<NotionPage[]>;
}
