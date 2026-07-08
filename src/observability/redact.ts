/**
 * Secret-safe scrubbing of log output (Symphony spec §13, FR21).
 *
 * The config layer's `redactConfig` reduces a `ServiceConfig` to a printable view.
 * This module solves the complementary problem for the *logger*: an arbitrary log
 * record's message and context values must never carry a live secret, even when a
 * caller accidentally interpolates one (e.g. a Notion token in an error string).
 *
 * Two independent defenses, both applied to every record:
 *   1. Value-based redaction — any registered secret string that appears anywhere
 *      in a rendered value is replaced by {@link REDACTED}. This is the reliable
 *      guarantee: if the value never appears, it cannot leak.
 *   2. Key-based redaction — context keys whose name looks sensitive
 *      (`auth`, `token`, `secret`, `password`, `*_key`/`*apikey`) have their value
 *      replaced wholesale, catching secrets we were never told about.
 */

import type { LogContext, LogRecord } from "../domain/interfaces.js";

/** Marker substituted for any redacted secret material. */
export const REDACTED = "<redacted>";

/** Context keys whose values are treated as secret regardless of content. */
const SENSITIVE_KEY = /(?:^|[._-])(?:auth|authorization|token|secret|password|passwd|api[._-]?key|access[._-]?key)s?$|apikey$/i;

/** Replace every occurrence of each registered secret within `text`. */
function scrubValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    // Split/join avoids regex-escaping the (arbitrary) secret contents.
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Render an arbitrary context value to a scalar-ish string for scrubbing. */
function renderValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubValues(value, secrets);
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  // Objects/arrays: scrub their JSON projection so nested secrets can't slip through.
  try {
    const json = JSON.stringify(value);
    const scrubbed = scrubValues(json, secrets);
    return JSON.parse(scrubbed);
  } catch {
    return REDACTED;
  }
}

/** Redact a single {@link LogContext}: sensitive keys wholesale, values by match. */
export function redactContext(context: LogContext, secrets: readonly string[]): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : renderValue(value, secrets);
  }
  return out;
}

/** Redact a whole record's message + context prior to handing it to any sink. */
export function redactRecord(record: LogRecord, secrets: readonly string[]): LogRecord {
  return {
    ...record,
    message: scrubValues(record.message, secrets),
    context: redactContext(record.context, secrets),
  };
}
