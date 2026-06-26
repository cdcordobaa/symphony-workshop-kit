/**
 * Notion page -> domain `Issue` normalization (U2; SYMPHONY-SPEC §4.1.1,
 * §4.2, §11.3; requirements.md FR-TR-3, FR-DM-1).
 *
 * The Notion MCP server returns pages as loosely-typed JSON. This module is the
 * single place that maps that raw shape into the stable domain model consumed by
 * the orchestrator, prompt renderer, and observability. Normalization rules
 * (§11.3):
 *
 *  - `labels`     -> lowercase strings
 *  - `blocked_by` -> derived from a "blocked by" relation property
 *  - `priority`   -> integer only (non-integers / missing become null)
 *  - timestamps   -> ISO-8601 strings (parsed/validated), else null
 *
 * The Status (select) property maps to `state`; states are compared after
 * lowercasing by the orchestrator, but the raw state NAME is preserved here so
 * it can be matched against the configured `active_states`/`terminal_states`.
 */

import type { BlockerRef, Issue } from "../domain/issue.js";

/** A raw Notion page as surfaced by the MCP transport. Intentionally loose. */
export interface NotionPage {
  /** Notion page id (stable internal id). */
  id?: unknown;
  /** Page URL. */
  url?: unknown;
  /** Created timestamp (ISO-8601). */
  created_time?: unknown;
  /** Last-edited timestamp (ISO-8601). */
  last_edited_time?: unknown;
  /** Map of property name -> raw Notion property value. */
  properties?: Record<string, unknown>;
}

/**
 * Names of the Notion properties used during normalization. Defaults follow the
 * common Notion convention; a board with different property names can override
 * these (resolved from config at the call site).
 */
export interface NotionPropertyMap {
  /** Title property name. Default `Name`. */
  title: string;
  /** Status (select) property name -> `state`. Default `Status`. */
  status: string;
  /** Priority property name. Default `Priority`. */
  priority: string;
  /** Labels / multi-select property name. Default `Labels`. */
  labels: string;
  /** "blocked by" relation property name -> `blocked_by[]`. Default `Blocked by`. */
  blockedBy: string;
  /** Human identifier property name (e.g. an ID/unique-id). Default `ID`. */
  identifier: string;
  /** Optional description / rich-text property name. Default `Description`. */
  description: string;
  /** Optional branch-name property. Default `Branch`. */
  branchName: string;
}

export const DEFAULT_PROPERTY_MAP: NotionPropertyMap = {
  title: "Name",
  status: "Status",
  priority: "Priority",
  labels: "Labels",
  blockedBy: "Blocked by",
  identifier: "ID",
  description: "Description",
  branchName: "Branch",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse a value to an ISO-8601 timestamp string, or null (§11.3). */
export function parseTimestamp(value: unknown): string | null {
  const s = asString(value);
  if (s === null) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** Coerce a value to an integer, or null (§11.3 — integers only). */
export function coercePriority(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    // Reject decimals / non-numeric labels; integers only.
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/**
 * Read the plain text out of a Notion rich-text / title property value, which
 * is an array of `{ plain_text }` segments (or already a plain string).
 */
function readRichText(prop: unknown): string | null {
  if (typeof prop === "string") return asString(prop);
  const rec = asRecord(prop);
  if (rec === null) return null;
  // { title: [...] } | { rich_text: [...] }
  const segments = rec.title ?? rec.rich_text ?? rec.plain_text ?? rec.text;
  if (typeof segments === "string") return asString(segments);
  if (Array.isArray(segments)) {
    const text = segments
      .map((seg) => {
        if (typeof seg === "string") return seg;
        const s = asRecord(seg);
        if (s === null) return "";
        return (
          asString(s.plain_text) ??
          asString(s.text) ??
          (asRecord(s.text) ? asString(asRecord(s.text)!.content) : null) ??
          ""
        );
      })
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

/**
 * Read the select/status NAME out of a Notion select property value.
 * Accepts `{ select: { name } }`, `{ status: { name } }`, `{ name }`, or a
 * bare string.
 */
function readSelectName(prop: unknown): string | null {
  if (typeof prop === "string") return asString(prop);
  const rec = asRecord(prop);
  if (rec === null) return null;
  const inner =
    asRecord(rec.select) ?? asRecord(rec.status) ?? asRecord(rec.option) ?? rec;
  return asString(inner.name);
}

/** Read a numeric Notion property (`{ number }` | bare number | string). */
function readNumber(prop: unknown): unknown {
  if (typeof prop === "number" || typeof prop === "string") return prop;
  const rec = asRecord(prop);
  if (rec === null) return null;
  if ("number" in rec) return rec.number;
  // Priority modeled as a select (e.g. "1", "High") -> read its name.
  return readSelectName(prop);
}

/** Read a multi-select / labels property as lowercased strings (§11.3). */
function readLabels(prop: unknown): string[] {
  const collect = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const item of arr) {
      if (typeof item === "string") {
        out.push(item.toLowerCase());
        continue;
      }
      const rec = asRecord(item);
      const name = rec ? asString(rec.name) : null;
      if (name !== null) out.push(name.toLowerCase());
    }
    return out;
  };
  if (Array.isArray(prop)) return collect(prop);
  const rec = asRecord(prop);
  if (rec === null) return [];
  return collect(rec.multi_select ?? rec.labels ?? rec.options);
}

/**
 * Read a "blocked by" relation property into blocker refs (§4.1.1).
 *
 * Relations from the MCP transport may be either bare page-id refs
 * (`[{ id }]`) or already-expanded refs (`[{ id, identifier, state }]`). Both
 * are supported; missing fields become null.
 */
function readBlockedBy(prop: unknown): BlockerRef[] {
  const collect = (arr: unknown): BlockerRef[] => {
    if (!Array.isArray(arr)) return [];
    const out: BlockerRef[] = [];
    for (const item of arr) {
      if (typeof item === "string") {
        out.push({ id: item, identifier: null, state: null });
        continue;
      }
      const rec = asRecord(item);
      if (rec === null) continue;
      out.push({
        id: asString(rec.id),
        identifier:
          asString(rec.identifier) ?? readRichText(rec.title) ?? asString(rec.name),
        state: readSelectName(rec.state) ?? asString(rec.state),
      });
    }
    return out;
  };
  if (Array.isArray(prop)) return collect(prop);
  const rec = asRecord(prop);
  if (rec === null) return [];
  return collect(rec.relation ?? rec.blocked_by ?? rec.items);
}

/**
 * Normalize one Notion page into the domain `Issue` model. Returns null when the
 * page lacks the minimum identity required to be schedulable (no id, or no
 * state) — the caller logs and skips it rather than emitting a malformed issue.
 */
export function normalizePage(
  page: NotionPage,
  propertyMap: NotionPropertyMap = DEFAULT_PROPERTY_MAP,
): Issue | null {
  const id = asString(page.id);
  if (id === null) return null;

  const props = page.properties ?? {};

  const state = readSelectName(props[propertyMap.status]);
  if (state === null) return null;

  const title = readRichText(props[propertyMap.title]) ?? "";

  const identifier =
    readRichText(props[propertyMap.identifier]) ??
    asString((asRecord(props[propertyMap.identifier]) ?? {}).number) ??
    id;

  return {
    id,
    identifier,
    title,
    description: readRichText(props[propertyMap.description]),
    priority: coercePriority(readNumber(props[propertyMap.priority])),
    state,
    branch_name: readRichText(props[propertyMap.branchName]),
    url: asString(page.url),
    labels: readLabels(props[propertyMap.labels]),
    blocked_by: readBlockedBy(props[propertyMap.blockedBy]),
    created_at: parseTimestamp(page.created_time),
    updated_at: parseTimestamp(page.last_edited_time),
  };
}
