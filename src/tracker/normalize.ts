/**
 * Row → domain normalization (Symphony spec §11.3, §4.1.1).
 *
 * Turns a transport-shaped {@link NotionRawRow} into the normalized §4
 * {@link Issue}. Normalization rules follow §11.3:
 *   - `labels`   → lowercase strings (Notion multi-select arrives as a JSON string)
 *   - `priority` → integer only; non-integers become `null`
 *   - `blocked_by` → derived from an inverse "blocks" relation; absent → `[]`
 *   - `created_at` / `updated_at` → parsed to ISO-8601, else `null`
 *
 * The Symphony Dev Board has no native ticket key and no blocked-by relation, so
 * the identifier is synthesized from the board's auto-increment `userDefined:ID`
 * (`<prefix>-<n>`) and `blocked_by` resolves to `[]`. Both behaviors are options
 * so a board that *does* carry those fields keeps the choice behind the port.
 */

import type { BlockerRef, Issue } from "../domain/types.js";
import { TrackerError } from "./errors.js";
import type { NotionRawRow } from "./notion-mcp.js";

export interface NormalizeOptions {
  /** Prefix for the synthesized identifier (`<prefix>-<userDefined:ID>`). Default `DEV`. */
  identifierPrefix?: string;
  /**
   * Row property carrying the inverse "blocks" relation, if the board has one.
   * Its value may be an array of ids or of `{id, identifier, state}` objects.
   * Default `"Blocked By"`; absent on the row → `blocked_by = []`.
   */
  blockedByProperty?: string;
}

/** Normalize one Notion row into an {@link Issue}. Throws {@link TrackerError} on unusable rows. */
export function normalizeRow(row: NotionRawRow, options: NormalizeOptions = {}): Issue {
  const id = optionalString(row.id);
  if (id === null) {
    throw new TrackerError("notion_normalize_error", "Notion row is missing a page id.");
  }

  const prefix = options.identifierPrefix ?? "DEV";
  const blockedByProperty = options.blockedByProperty ?? "Blocked By";

  return {
    id,
    identifier: buildIdentifier(prefix, row["userDefined:ID"], id),
    title: optionalString(row.Name) ?? "",
    description: null,
    priority: integerOrNull(row.Priority),
    state: optionalString(row.Status) ?? "",
    branch_name: null,
    url: optionalString(row.url),
    labels: normalizeLabels(row.Labels),
    blocked_by: normalizeBlockedBy(row[blockedByProperty]),
    created_at: parseTimestamp(row.createdTime),
    updated_at: parseTimestamp(row.lastEditedTime),
  };
}

/** `<prefix>-<n>` when a numeric board id exists; otherwise fall back to the page id. */
function buildIdentifier(prefix: string, boardId: unknown, pageId: string): string {
  const n = integerOrNull(boardId);
  return n === null ? pageId : `${prefix}-${n}`;
}

/**
 * Parse Notion multi-select labels into lowercase strings. The connector returns
 * them as a JSON-encoded string; an already-parsed array is also accepted.
 */
export function normalizeLabels(value: unknown): string[] {
  let list: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return [];
    try {
      list = JSON.parse(trimmed);
    } catch {
      // A bare comma-free string is treated as a single label.
      list = [trimmed];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? item : String((item as { name?: unknown })?.name ?? "")))
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

/**
 * Map an inverse "blocks" relation into {@link BlockerRef}s (§11.3). Accepts a
 * list of ids or of best-effort objects; anything else (including `undefined`)
 * yields `[]`.
 */
export function normalizeBlockedBy(value: unknown): BlockerRef[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry): BlockerRef => {
    if (typeof entry === "string") {
      return { id: entry, identifier: null, state: null };
    }
    const obj = (entry ?? {}) as Record<string, unknown>;
    return {
      id: optionalString(obj.id),
      identifier: optionalString(obj.identifier),
      state: optionalString(obj.state),
    };
  });
}

/** ISO-8601 (§11.3). Accepts the connector's `"YYYY-MM-DD HH:MM:SSZ"` form. */
export function parseTimestamp(value: unknown): string | null {
  const raw = optionalString(value);
  if (raw === null) return null;
  const parsed = new Date(raw.includes("T") ? raw : raw.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Integer only; non-integers (including numeric-looking floats) become `null` (§11.3). */
function integerOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/** A non-empty trimmed string, or `null`. */
function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
