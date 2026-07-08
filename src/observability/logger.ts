/**
 * Structured logger (Symphony spec §13.1–13.2, FR18/FR21).
 *
 * Design:
 *   - Records are structured ({@link LogRecord}) and rendered by a pluggable
 *     {@link LogFormat}: `json` (JSON Lines — machine-parseable) or `text`
 *     (stable `key=value` phrasing — human-readable in a terminal). Both satisfy
 *     the "machine-parseable AND human-readable" acceptance criterion.
 *   - `child(context)` binds context that merges into every subsequent record, so
 *     the orchestrator can bind `issue_id`/`issue_identifier` and the agent layer
 *     can further bind `session_id` (§13.1 REQUIRED fields).
 *   - Every record is passed through {@link redactRecord} before any sink sees it,
 *     so secret values never reach output (FR21).
 *   - Sink failures are isolated: a throwing sink can never crash a caller
 *     (§13.2 "the service SHOULD continue running"). A best-effort operator
 *     warning is emitted to stderr and then swallowed.
 */

import type { LogContext, LogLevel, LogRecord, LogSink, Logger } from "../domain/interfaces.js";
import { redactRecord } from "./redact.js";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Output rendering for the default stream sink. */
export type LogFormat = "json" | "text";

export interface LoggerOptions {
  /** Sinks to receive every (already-redacted) record. Defaults to one stderr sink. */
  sinks?: LogSink[];
  /** Format for the default stderr sink (ignored when `sinks` is provided). */
  format?: LogFormat;
  /** Minimum level to emit. Records below this are dropped. Default `info`. */
  level?: LogLevel;
  /** Secret strings to scrub from every record (FR21). */
  secrets?: string[];
  /** Context bound to every record (used internally by `child`). */
  context?: LogContext;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => Date;
}

/** Render a record as a single JSON Lines entry (machine-parseable). */
export function formatJsonLine(record: LogRecord): string {
  return JSON.stringify({
    time: record.time,
    level: record.level,
    message: record.message,
    ...record.context,
  });
}

/** Render a record as a stable, human-readable `key=value` line (§13.1). */
export function formatTextLine(record: LogRecord): string {
  const parts = [record.time, record.level.toUpperCase(), record.message];
  for (const [key, value] of Object.entries(record.context)) {
    if (value === undefined) continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.join(" ");
}

/** A sink that writes one formatted line per record to a text stream. */
export function streamSink(
  stream: { write(chunk: string): unknown },
  format: LogFormat = "json",
): LogSink {
  const render = format === "text" ? formatTextLine : formatJsonLine;
  return {
    write(record: LogRecord): void {
      stream.write(`${render(record)}\n`);
    },
  };
}

/** True when `level` is at or above the configured `min` threshold. */
function enabled(level: LogLevel, min: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(min);
}

/**
 * Create a {@link Logger}. Concrete implementation of the §13 Logger port.
 * All later units (tracker, workspace, agent, orchestrator) log through this.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const secrets = options.secrets ?? [];
  const bound = options.context ?? {};
  const now = options.now ?? (() => new Date());
  const sinks = options.sinks ?? [streamSink(process.stderr, options.format ?? "json")];

  function emit(recordLevel: LogLevel, message: string, context?: LogContext): void {
    if (!enabled(recordLevel, level)) return;
    const record: LogRecord = {
      time: now().toISOString(),
      level: recordLevel,
      message,
      context: { ...bound, ...context },
    };
    const safe = redactRecord(record, secrets);
    for (const sink of sinks) {
      // FR21 defense-in-depth + §13.2: a broken sink must never reach the caller.
      try {
        sink.write(safe);
      } catch (error) {
        try {
          process.stderr.write(
            `[logger] sink write failed (record dropped for this sink): ${(error as Error).message}\n`,
          );
        } catch {
          /* even the fallback failed — swallow; correctness must not depend on logs */
        }
      }
    }
  }

  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    child(context: LogContext): Logger {
      return createLogger({
        sinks,
        level,
        secrets,
        now,
        context: { ...bound, ...context },
      });
    },
  };
}
