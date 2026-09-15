/**
 * Structured logger — Symphony spec §13.1 "Logging Conventions" and §13.2
 * "Logging Outputs and Sinks". Implements the `Logger` port from ARK-58.
 *
 * Three decisions worth stating, because each one is a reading of the spec rather
 * than a free choice:
 *
 *   - **Context is flattened onto the record**, not nested under a `context` key.
 *     §13.1 calls `issue_id` / `issue_identifier` / `session_id` REQUIRED *context
 *     fields*, and the operator's actual question is "what happened to ARK-60" —
 *     which should be `grep issue_identifier` or `jq 'select(.issue_identifier ==
 *     "ARK-60")"`, not a path into a sub-object.
 *
 *   - **Two sinks, both on by default where it matters.** The acceptance criterion
 *     asks for output that is machine-parseable *and* human-readable, which is two
 *     formats, not a compromise between them. {@link jsonLinesSink} emits one JSON
 *     object per line; {@link terminalSink} emits §13.1's `key=value` phrasing. The
 *     default picks by destination: a TTY gets the human line, a pipe or file gets
 *     JSON, so `symphony … 2> run.log` stays parseable with no flag.
 *
 *   - **A failing sink is contained here.** §13.2 requires the service to keep
 *     running when a sink fails and to warn through whatever sinks remain. So
 *     every write is guarded, a repeatedly failing sink is disabled rather than
 *     retried forever, and no log call can throw into its caller — logging is not
 *     load-bearing, and an observability fault must never become an outage.
 */

import type { LogContext, Logger, LogLevel } from "../domain/index.js";

import {
  createSecretRegistry,
  redactContext,
  type RedactOptions,
  type SecretRegistry,
} from "./redact.js";

/** Severity order, least to most severe. Used for threshold comparison. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * One emitted log record: the three envelope fields plus the redacted context,
 * flattened alongside them.
 */
export interface LogRecord {
  /** ISO-8601 emission timestamp. */
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

/** Envelope field names a context key may not overwrite. */
const RESERVED_KEYS = new Set(["ts", "level", "msg"]);

/**
 * A destination for records. Throwing is allowed and expected to be survivable —
 * {@link createLogger} contains the failure (§13.2).
 */
export type LogSink = (record: LogRecord) => void;

/** The slice of `NodeJS.WriteStream` the sinks need, so tests can pass a fake. */
export interface WritableLike {
  write(chunk: string): unknown;
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

/* ------------------------------------------------------------------------- *
 * Sinks
 * ------------------------------------------------------------------------- */

/**
 * One JSON object per line — the machine-parseable form (§13.2 leaves the sink
 * open; JSON Lines is the shape `jq` and log shippers consume without a parser).
 */
export function jsonLinesSink(stream: WritableLike = process.stderr): LogSink {
  return (record) => {
    stream.write(`${JSON.stringify(record)}\n`);
  };
}

/** Context keys surfaced first on a terminal line, when present. */
const PREFERRED_KEY_ORDER = [
  "issue_identifier",
  "issue_id",
  "session_id",
  "attempt",
  "state",
  "outcome",
  "reason",
];

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "[2m",
  info: "[36m",
  warn: "[33m",
  error: "[31m",
};

const RESET = "[0m";

/** Render a context value as a single `key=value` token per §13.1. */
function formatValue(value: unknown): string {
  if (typeof value === "string") {
    // Quote only when the token would otherwise be ambiguous to split on.
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value);
}

/** Context keys in display order: the preferred ones first, then as inserted. */
function orderedContextKeys(record: LogRecord): string[] {
  const keys = Object.keys(record).filter((key) => !RESERVED_KEYS.has(key));
  const preferred = PREFERRED_KEY_ORDER.filter((key) => keys.includes(key));
  const rest = keys.filter((key) => !PREFERRED_KEY_ORDER.includes(key));
  return [...preferred, ...rest];
}

/** Options for {@link terminalSink}. */
export interface TerminalSinkOptions {
  /** ANSI level colors. Defaults to on for a TTY unless `NO_COLOR` is set. */
  color?: boolean;
}

/**
 * Human-readable line: `HH:MM:SS.mmm LEVEL message key=value key=value`.
 *
 * The clock is trimmed to time-of-day because an operator watching a live terminal
 * already knows the date; the JSON sink keeps the full ISO timestamp.
 */
export function terminalSink(
  stream: WritableLike = process.stderr,
  options: TerminalSinkOptions = {},
): LogSink {
  const color =
    options.color ?? (Boolean(stream.isTTY) && !process.env.NO_COLOR);

  return (record) => {
    const clock = record.ts.length >= 23 ? record.ts.slice(11, 23) : record.ts;
    const label = LEVEL_LABEL[record.level] ?? record.level.toUpperCase();
    const head = color ? `${LEVEL_COLOR[record.level]}${label}${RESET}` : label;

    const pairs = orderedContextKeys(record)
      .map((key) => `${key}=${formatValue(record[key])}`)
      .join(" ");

    const line = pairs
      ? `${clock} ${head} ${record.msg} ${pairs}`
      : `${clock} ${head} ${record.msg}`;

    stream.write(`${line}\n`);
  };
}

/* ------------------------------------------------------------------------- *
 * Logger
 * ------------------------------------------------------------------------- */

/** How the default sink set is chosen. */
export type LogFormat = "auto" | "json" | "terminal" | "both";

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum severity emitted. Default `"info"`. */
  level?: LogLevel;
  /** Explicit sinks. Overrides `format` / `stream` entirely. */
  sinks?: LogSink[];
  /**
   * Which default sinks to build when `sinks` is omitted. `"auto"` (the default)
   * reads `stream.isTTY`: terminal lines for a console, JSON Lines for a pipe.
   */
  format?: LogFormat;
  /** Destination for the default sinks. Default `process.stderr` (§13.2). */
  stream?: WritableLike;
  /** Context merged into every record. */
  context?: LogContext;
  /** Clock seam, for deterministic tests. Default `() => new Date()`. */
  now?: () => Date;
  /** Shared secret literals to scrub (§15.3). A fresh registry by default. */
  secrets?: SecretRegistry;
  /** Depth / length bounds passed to redaction. */
  redaction?: Omit<RedactOptions, "secrets">;
  /**
   * Consecutive failures tolerated before a sink is disabled. Default `3`.
   *
   * Not `1`: a transient `EAGAIN` should not permanently blind the operator. Not
   * unbounded either, or a broken pipe re-throws on every record forever.
   */
  maxSinkFailures?: number;
}

/** Mutable health of one registered sink. */
interface SinkState {
  sink: LogSink;
  /** Index-derived label used in the failure warning. */
  name: string;
  consecutiveFailures: number;
  disabled: boolean;
}

/**
 * State shared by a logger and every {@link Logger.child} derived from it.
 *
 * Sink health belongs here rather than on the logger: a child that re-discovered
 * a dead sink independently would re-emit the same warning for every context it
 * was derived for.
 */
interface LoggerCore {
  level: LogLevel;
  sinks: SinkState[];
  now: () => Date;
  secrets: SecretRegistry;
  redaction: RedactOptions;
  maxSinkFailures: number;
  /** Re-entry guard: a failure warning must not trigger its own warning. */
  warningInFlight: boolean;
}

function defaultSinks(options: LoggerOptions): LogSink[] {
  const stream = options.stream ?? process.stderr;
  const format = options.format ?? "auto";

  switch (format) {
    case "json":
      return [jsonLinesSink(stream)];
    case "terminal":
      return [terminalSink(stream)];
    case "both":
      return [terminalSink(stream), jsonLinesSink(stream)];
    case "auto":
    default:
      return stream.isTTY ? [terminalSink(stream)] : [jsonLinesSink(stream)];
  }
}

/**
 * Structured logger over a shared {@link LoggerCore}.
 *
 * Instances are cheap: `child()` allocates a merged context and reuses the core,
 * so per-issue and per-session loggers can be created freely in the dispatch path.
 */
class StructuredLogger implements Logger {
  readonly #core: LoggerCore;
  readonly #context: LogContext;

  constructor(core: LoggerCore, context: LogContext) {
    this.#core = core;
    this.#context = context;
  }

  debug(message: string, context?: LogContext): void {
    this.#emit("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.#emit("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.#emit("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.#emit("error", message, context);
  }

  child(context: LogContext): Logger {
    return new StructuredLogger(this.#core, { ...this.#context, ...context });
  }

  #emit(level: LogLevel, message: string, context?: LogContext): void {
    try {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#core.level]) return;

      const merged: LogContext = context
        ? { ...this.#context, ...context }
        : this.#context;

      const redacted = redactContext(merged, {
        ...this.#core.redaction,
        secrets: this.#core.secrets,
      });

      const record: LogRecord = {
        ts: this.#core.now().toISOString(),
        level,
        msg: this.#core.secrets.scrub(message),
      };

      for (const [key, value] of Object.entries(redacted)) {
        // An envelope field is never silently overwritten, and never silently
        // dropped either — a colliding context key is preserved under a prefix.
        record[RESERVED_KEYS.has(key) ? `context_${key}` : key] = value;
      }

      dispatch(this.#core, record);
    } catch {
      // §13.2: logging is not load-bearing. A fault in the logger itself — a
      // getter that throws while being redacted, say — must not reach the caller.
    }
  }
}

/** Write one record to every healthy sink, containing any failure (§13.2). */
function dispatch(core: LoggerCore, record: LogRecord): void {
  const failures: Array<{ state: SinkState; error: unknown }> = [];

  for (const state of core.sinks) {
    if (state.disabled) continue;
    try {
      state.sink(record);
      state.consecutiveFailures = 0;
    } catch (error) {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= core.maxSinkFailures) {
        state.disabled = true;
      }
      failures.push({ state, error });
    }
  }

  if (failures.length === 0 || core.warningInFlight) return;

  // "…emit an operator-visible warning through any remaining sink" (§13.2).
  const survivors = core.sinks.filter(
    (state) => !state.disabled && !failures.some((f) => f.state === state),
  );
  if (survivors.length === 0) return;

  core.warningInFlight = true;
  try {
    for (const { state, error } of failures) {
      const warning: LogRecord = {
        ts: core.now().toISOString(),
        level: "warn",
        msg: "log sink failed",
        sink: state.name,
        consecutive_failures: state.consecutiveFailures,
        sink_disabled: state.disabled,
        reason: core.secrets.scrub(
          error instanceof Error ? error.message : String(error),
        ),
      };
      for (const survivor of survivors) {
        try {
          survivor.sink(warning);
        } catch {
          // The warning path itself is best-effort; there is nowhere left to say so.
        }
      }
    }
  } finally {
    core.warningInFlight = false;
  }
}

/** A logger that emits nothing. For tests and for units under construction. */
export function nullLogger(): Logger {
  return createLogger({ sinks: [] });
}

/** Create a {@link Logger} (the ARK-58 port) over the configured sinks. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sinks = options.sinks ?? defaultSinks(options);

  const core: LoggerCore = {
    level: options.level ?? "info",
    sinks: sinks.map((sink, index) => ({
      sink,
      name: sink.name || `sink[${index}]`,
      consecutiveFailures: 0,
      disabled: false,
    })),
    now: options.now ?? (() => new Date()),
    secrets: options.secrets ?? createSecretRegistry(),
    redaction: options.redaction ?? {},
    maxSinkFailures: options.maxSinkFailures ?? 3,
    warningInFlight: false,
  };

  return new StructuredLogger(core, options.context ?? {});
}
