/**
 * Notion tracker adapter (Symphony spec §11, Unit 1.3 / ARK-52).
 *
 * A read-only implementation of the {@link TrackerClient} port (§11.1) over the
 * Notion MCP transport. It performs the three REQUIRED operations and normalizes
 * every row into the §4 {@link Issue} model (§11.2 "normalized outputs MUST match
 * the domain model regardless of transport").
 *
 * Boundaries:
 *   - READ ONLY. No state/comment/PR writes — those belong to the coding agent
 *     via its own tools (§11.5). This class exposes no mutation surface.
 *   - Transport-agnostic: depends only on the {@link NotionMcp} port, never on a
 *     tool name, SQL string, or data-source URL (PRD §10 binding stays hidden).
 *   - Recoverable by contract: all failures are {@link TrackerError}s, so the
 *     orchestrator can log-and-skip a tick (§11.4) rather than crash.
 *   - Secret-safe (FR21): `tracker.auth` is read from resolved config and held
 *     privately; it is NEVER passed to the logger or included in any message.
 */

import type { TrackerClient } from "../domain/interfaces.js";
import type { Logger } from "../domain/interfaces.js";
import type { Issue } from "../domain/types.js";
import type { ServiceConfig } from "../domain/types.js";
import { TrackerError } from "./errors.js";
import type { NotionMcp } from "./notion-mcp.js";
import { normalizeRow, type NormalizeOptions } from "./normalize.js";

export interface NotionTrackerClientOptions extends NormalizeOptions {
  transport: NotionMcp;
  config: ServiceConfig;
  logger: Logger;
}

/** The supported tracker kind for this adapter. */
const SUPPORTED_KIND = "notion";

export class NotionTrackerClient implements TrackerClient {
  private readonly transport: NotionMcp;
  private readonly activeStates: string[];
  private readonly logger: Logger;
  private readonly normalizeOptions: NormalizeOptions;
  /** Held privately for FR21; the transport owns actual authentication. Never logged. */
  private readonly auth: string | null;

  constructor(options: NotionTrackerClientOptions) {
    const { tracker } = options.config;
    const kind = tracker.kind.trim().toLowerCase();
    if (kind !== "" && kind !== SUPPORTED_KIND) {
      throw new TrackerError(
        "unsupported_tracker_kind",
        `NotionTrackerClient supports tracker.kind="${SUPPORTED_KIND}", got "${tracker.kind}".`,
      );
    }
    this.transport = options.transport;
    this.activeStates = tracker.active_states;
    this.auth = tracker.auth; // read from resolved config (FR21); intentionally never logged.
    this.logger = options.logger;
    this.normalizeOptions = {
      identifierPrefix: options.identifierPrefix,
      blockedByProperty: options.blockedByProperty,
    };
  }

  /** Issues in the configured active states (§11.1 #1, FR3). */
  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues = await this.query(this.activeStates, "fetchCandidateIssues");
    this.logger.debug("tracker fetched candidate issues", {
      action: "fetch_candidate_issues",
      count: issues.length,
      active_states: this.activeStates,
    });
    return issues;
  }

  /** Issues in the given states; startup terminal cleanup (§11.1 #2). Empty → `[]`, no call. */
  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    return this.query(stateNames, "fetchIssuesByStates");
  }

  /** Current states for the given issue ids; active-run reconciliation (§11.1 #3, FR4). Empty → `[]`, no call. */
  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    let rows;
    try {
      rows = await this.transport.queryByIds(issueIds);
    } catch (error) {
      throw asTrackerError(error);
    }
    return this.normalizeAll(rows);
  }

  /** Shared query-by-states path with error wrapping. */
  private async query(states: string[], action: string): Promise<Issue[]> {
    let rows;
    try {
      rows = await this.transport.queryByStates(states);
    } catch (error) {
      this.logger.warn("tracker query failed (recoverable)", {
        action,
        error_code: error instanceof TrackerError ? error.code : "notion_mcp_request",
      });
      throw asTrackerError(error);
    }
    return this.normalizeAll(rows);
  }

  private normalizeAll(rows: Awaited<ReturnType<NotionMcp["queryByStates"]>>): Issue[] {
    return rows.map((row) => normalizeRow(row, this.normalizeOptions));
  }
}

/** Coerce any thrown value into a recoverable {@link TrackerError}. */
function asTrackerError(error: unknown): TrackerError {
  if (error instanceof TrackerError) return error;
  return new TrackerError(
    "notion_mcp_request",
    `Notion tracker operation failed: ${(error as Error)?.message ?? String(error)}`,
    error,
  );
}
