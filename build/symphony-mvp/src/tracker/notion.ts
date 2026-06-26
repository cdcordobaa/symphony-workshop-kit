/**
 * Read-only Notion tracker adapter (U2; SYMPHONY-SPEC §11 adapted, §4.1.1,
 * §11.3; requirements.md FR-TR-1..6).
 *
 * Implements the shared `TrackerClient` interface (U1 `domain/interfaces.ts`)
 * against a Notion database, reached exclusively through the Notion MCP server
 * (`NotionMcpTransport`). Responsibilities:
 *
 *  - `fetchCandidateIssues()` — read pages of the configured database whose
 *    Status ∈ `active_states`, paginating and preserving order (FR-TR-1,4).
 *  - `fetchIssueStatesByIds(ids)` — minimal state refresh for reconciliation
 *    (FR-TR-1).
 *  - Normalize pages → `Issue` via `normalize.ts` (FR-TR-3).
 *  - Error taxonomy + signals: candidate-fetch failure ⇒ log + skip tick;
 *    refresh failure ⇒ log + keep workers (FR-TR-5).
 *
 * Read-only boundary (FR-TR-6): this module NEVER mutates Notion. The transport
 * interface exposes no write op, and nothing here calls one.
 *
 * The `TrackerClient` methods return plain arrays and never throw across the
 * boundary, which naturally encodes the spec's recovery behavior:
 *  - candidate failure ⇒ `[]` candidates ⇒ orchestrator dispatches nothing this
 *    tick (skip-tick),
 *  - refresh failure ⇒ no terminal states reported ⇒ orchestrator keeps workers.
 * Richer signal-bearing variants (`fetchCandidates` / `refreshStates`) are also
 * exposed for the orchestrator and tests to inspect the explicit signal.
 */

import type { Logger } from "../obs/log.js";
import { errorMessage } from "../obs/log.js";
import type { TrackerConfig } from "../domain/config.js";
import type { Issue, IssueStateRef } from "../domain/issue.js";
import type { TrackerClient } from "../domain/interfaces.js";
import {
  DEFAULT_PROPERTY_MAP,
  normalizePage,
  type NotionPropertyMap,
} from "./normalize.js";
import type { NotionMcpTransport } from "./transport.js";

/** Default Notion candidate page size (§11.2 page-size default). */
export const DEFAULT_PAGE_SIZE = 50;
/** Hard cap on pages fetched per candidate poll, guarding runaway pagination. */
export const DEFAULT_MAX_PAGES = 1000;

/** Tracker error categories (§11.4, adapted to Notion/MCP). */
export type TrackerErrorCategory =
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_database"
  | "notion_mcp_request"
  | "notion_mcp_pagination"
  | "notion_unknown_payload";

/** Orchestrator behavior signal on a candidate-fetch failure (§11.4). */
export type CandidateFailureSignal = "skip_tick";
/** Orchestrator behavior signal on a state-refresh failure (§11.4). */
export type RefreshFailureSignal = "keep_workers";

/** Successful candidate fetch. */
export interface CandidateFetchOk {
  ok: true;
  issues: Issue[];
}
/** Failed candidate fetch ⇒ skip dispatch this tick. */
export interface CandidateFetchErr {
  ok: false;
  signal: CandidateFailureSignal;
  category: TrackerErrorCategory;
  error: string;
}
export type CandidateFetchResult = CandidateFetchOk | CandidateFetchErr;

/** Successful state refresh (states for the ids that resolved). */
export interface RefreshOk {
  ok: true;
  states: IssueStateRef[];
}
/** Failed state refresh ⇒ keep active workers running. */
export interface RefreshErr {
  ok: false;
  signal: RefreshFailureSignal;
  category: TrackerErrorCategory;
  error: string;
}
export type RefreshResult = RefreshOk | RefreshErr;

/** Construction options for the Notion tracker. */
export interface NotionTrackerOptions {
  /** Resolved tracker config (kind/database/api_key/active_states). */
  config: TrackerConfig;
  /** Notion MCP transport (read-only). */
  transport: NotionMcpTransport;
  /** Logger (issue/tracker context). */
  logger: Logger;
  /** Property-name overrides; defaults to {@link DEFAULT_PROPERTY_MAP}. */
  propertyMap?: NotionPropertyMap;
  /** Candidate page size. Default {@link DEFAULT_PAGE_SIZE}. */
  pageSize?: number;
  /** Max pages per poll. Default {@link DEFAULT_MAX_PAGES}. */
  maxPages?: number;
}

/** Error carrying a normalized tracker category for taxonomy mapping. */
class TrackerCategorizedError extends Error {
  readonly category: TrackerErrorCategory;
  constructor(category: TrackerErrorCategory, message: string) {
    super(message);
    this.name = "TrackerCategorizedError";
    this.category = category;
  }
}

function categoryOf(err: unknown): TrackerErrorCategory {
  if (err instanceof TrackerCategorizedError) return err.category;
  return "notion_mcp_request";
}

/**
 * Read-only Notion tracker. Implements `TrackerClient`; never throws out of the
 * two interface methods.
 */
export class NotionTracker implements TrackerClient {
  private readonly config: TrackerConfig;
  private readonly transport: NotionMcpTransport;
  private readonly logger: Logger;
  private readonly propertyMap: NotionPropertyMap;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(options: NotionTrackerOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.logger = options.logger;
    this.propertyMap = options.propertyMap ?? DEFAULT_PROPERTY_MAP;
    this.pageSize =
      options.pageSize && options.pageSize > 0
        ? options.pageSize
        : DEFAULT_PAGE_SIZE;
    this.maxPages =
      options.maxPages && options.maxPages > 0
        ? options.maxPages
        : DEFAULT_MAX_PAGES;
  }

  /** Validate the tracker config required to talk to Notion (§11.4). */
  private assertConfigured(): void {
    if (this.config.kind !== "notion") {
      throw new TrackerCategorizedError(
        "unsupported_tracker_kind",
        `unsupported tracker kind: ${String(this.config.kind)}`,
      );
    }
    if (!this.config.api_key) {
      throw new TrackerCategorizedError(
        "missing_tracker_api_key",
        "notion tracker api_key is missing after resolution",
      );
    }
    if (!this.config.database) {
      throw new TrackerCategorizedError(
        "missing_tracker_database",
        "notion tracker database id is missing",
      );
    }
  }

  /** Lowercased active-state set for membership checks (§4.2). */
  private activeStateSet(): Set<string> {
    return new Set(this.config.active_states.map((s) => s.toLowerCase()));
  }

  /**
   * Fetch active-state candidate issues with explicit success/skip signal.
   * Paginates, preserving order, and never throws (FR-TR-1,4,5).
   */
  async fetchCandidates(): Promise<CandidateFetchResult> {
    try {
      this.assertConfigured();
      const database = this.config.database as string;
      const activeStates = this.config.active_states;
      const activeSet = this.activeStateSet();

      const issues: Issue[] = [];
      let cursor: string | null = null;
      let pageCount = 0;

      do {
        const result = await this.transport.queryDatabase({
          database,
          states: activeStates,
          statusProperty: this.propertyMap.status,
          startCursor: cursor,
          pageSize: this.pageSize,
        });

        if (result === null || typeof result !== "object") {
          throw new TrackerCategorizedError(
            "notion_unknown_payload",
            "notion mcp returned a non-object query result",
          );
        }
        if (!Array.isArray(result.pages)) {
          throw new TrackerCategorizedError(
            "notion_unknown_payload",
            "notion mcp query result is missing a pages array",
          );
        }

        for (const page of result.pages) {
          const issue = normalizePage(page, this.propertyMap);
          if (issue === null) {
            this.logger.warn("tracker_page_skipped", {
              outcome: "skipped",
              reason: "page missing id or status",
            });
            continue;
          }
          // Defensive: enforce the active-state filter even if the transport
          // did not (states compared after lowercasing, §4.2).
          if (!activeSet.has(issue.state.toLowerCase())) continue;
          issues.push(issue);
        }

        pageCount += 1;
        if (result.has_more) {
          if (result.next_cursor === null || result.next_cursor === undefined) {
            throw new TrackerCategorizedError(
              "notion_mcp_pagination",
              "notion mcp reported has_more but returned no next_cursor",
            );
          }
          cursor = result.next_cursor;
        } else {
          cursor = null;
        }

        if (pageCount >= this.maxPages && cursor !== null) {
          this.logger.warn("tracker_pagination_capped", {
            outcome: "capped",
            pages: pageCount,
            reason: `max_pages ${this.maxPages} reached`,
          });
          break;
        }
      } while (cursor !== null);

      this.logger.info("tracker_candidates_fetched", {
        outcome: "completed",
        count: issues.length,
        pages: pageCount,
      });
      return { ok: true, issues };
    } catch (err) {
      const category = categoryOf(err);
      const error = errorMessage(err);
      this.logger.error("tracker_candidate_fetch_failed", {
        outcome: "failed",
        signal: "skip_tick",
        category,
        reason: error,
      });
      return { ok: false, signal: "skip_tick", category, error };
    }
  }

  /**
   * `TrackerClient` candidate read. Never throws: a failure yields `[]` so the
   * orchestrator simply dispatches nothing this tick (skip-tick, FR-TR-5).
   */
  async fetchCandidateIssues(): Promise<Issue[]> {
    const result = await this.fetchCandidates();
    return result.ok ? result.issues : [];
  }

  /**
   * Refresh issue states by id with explicit success/keep-workers signal.
   * Never throws (FR-TR-1,5).
   */
  async refreshStates(ids: string[]): Promise<RefreshResult> {
    const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
    if (unique.length === 0) {
      return { ok: true, states: [] };
    }
    try {
      this.assertConfigured();
      const pages = await this.transport.fetchPagesByIds(unique);
      if (!Array.isArray(pages)) {
        throw new TrackerCategorizedError(
          "notion_unknown_payload",
          "notion mcp returned a non-array page set for id refresh",
        );
      }

      const states: IssueStateRef[] = [];
      for (const page of pages) {
        const issue = normalizePage(page, this.propertyMap);
        if (issue === null) continue;
        states.push({
          id: issue.id,
          identifier: issue.identifier,
          state: issue.state,
        });
      }

      this.logger.info("tracker_states_refreshed", {
        outcome: "completed",
        requested: unique.length,
        resolved: states.length,
      });
      return { ok: true, states };
    } catch (err) {
      const category = categoryOf(err);
      const error = errorMessage(err);
      this.logger.error("tracker_state_refresh_failed", {
        outcome: "failed",
        signal: "keep_workers",
        category,
        reason: error,
      });
      return { ok: false, signal: "keep_workers", category, error };
    }
  }

  /**
   * `TrackerClient` state refresh. Never throws: a failure yields `[]`, so the
   * orchestrator resolves no terminal states and keeps its workers (FR-TR-5).
   */
  async fetchIssueStatesByIds(ids: string[]): Promise<IssueStateRef[]> {
    const result = await this.refreshStates(ids);
    return result.ok ? result.states : [];
  }
}

/** Factory: build a read-only Notion tracker from options. */
export function createNotionTracker(
  options: NotionTrackerOptions,
): NotionTracker {
  return new NotionTracker(options);
}
