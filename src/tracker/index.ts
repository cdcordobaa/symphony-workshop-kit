/**
 * Tracker layer (Symphony spec §11) — Unit 1.3 / ARK-52.
 *
 * Read-only Notion tracker adapter implementing the §11.1 {@link TrackerClient}
 * port over an MCP transport, normalizing rows into the §4 `Issue` model. The
 * port contract lives in `src/domain`; this module is the Notion implementation.
 */

export { NotionTrackerClient, type NotionTrackerClientOptions } from "./notion-tracker-client.js";
export {
  SqlNotionMcp,
  parseRows,
  resolveDataSourceUrl,
  type NotionMcp,
  type NotionRawRow,
  type NotionToolInvoker,
  type SqlNotionMcpOptions,
} from "./notion-mcp.js";
export {
  normalizeRow,
  normalizeLabels,
  normalizeBlockedBy,
  parseTimestamp,
  type NormalizeOptions,
} from "./normalize.js";
export { TrackerError, isTrackerError, type TrackerErrorCode } from "./errors.js";
