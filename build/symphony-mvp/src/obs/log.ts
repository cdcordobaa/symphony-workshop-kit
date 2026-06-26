/**
 * Structured logger + sink abstraction (U5; SYMPHONY-SPEC §13.1–§13.2, §15.3).
 *
 * Foundational observability consumed by U1/U2/U3/U4. Emits stable `key=value`
 * lines with the spec-required context fields:
 *  - issue logs MUST carry `issue_id` and `issue_identifier` (§13.1),
 *  - coding-agent session-lifecycle logs MUST carry `session_id` (§13.1),
 *  - logs SHOULD include an `outcome` (completed/failed/stopped/…) and a concise
 *    failure `reason` when present.
 *
 * Safety (§15.3, §15.4, NFR-SECRETS, NFR-HOOK-SAFETY):
 *  - never log API tokens or secret env values — redact known secret-ish keys
 *    and any registered secret literals,
 *  - truncate long hook/agent output so large raw payloads never flood logs.
 *
 * Resilience (§13.2, FR-OB-2): operators must see startup/validation/dispatch
 * failures without a debugger; a sink that throws MUST NOT crash the service —
 * remaining sinks still receive the record and the failure is surfaced through
 * them when possible.
 */

/** Severity levels, ordered low→high. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Arbitrary structured context attached to a log line. */
export type LogContext = Record<string, unknown>;

/** A normalized log record handed to every sink. */
export interface LogRecord {
  /** ISO-8601 timestamp. */
  timestamp: string;
  level: LogLevel;
  /** Short, stable event name (e.g. `dispatch`, `session_started`). */
  event: string;
  /** Already-redacted, already-truncated context fields. */
  context: LogContext;
}

/**
 * A log destination. Sinks receive both the structured record and a
 * pre-formatted `key=value` line. Sinks MAY throw — the logger isolates them.
 */
export interface LogSink {
  /** Stable name used when reporting that this sink itself failed. */
  readonly name: string;
  write(record: LogRecord, formatted: string): void;
}

/** Default cap for any single field value before truncation (chars). */
export const DEFAULT_MAX_VALUE_LENGTH = 2000;

/** Suffix appended to truncated values, including the elided count. */
function truncated(value: string, max: number): string {
  if (value.length <= max) return value;
  const elided = value.length - max;
  return `${value.slice(0, max)}…[+${elided} chars]`;
}

const REDACTED = "[REDACTED]";

/**
 * Field names whose values are treated as secret and never printed. Matched
 * case-insensitively as a substring so `tracker_api_key`, `apiKey`,
 * `notion_token`, `authorization`, etc. are all covered.
 */
const SECRET_KEY_PATTERNS = [
  "api_key",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "auth_token",
  "access_key",
  "private_key",
  "credential",
];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

/** Logger construction options. */
export interface LoggerOptions {
  /** Minimum level to emit (inclusive). Default `info`. */
  level?: LogLevel;
  /** Sinks to fan out to. Default: a single stderr sink. */
  sinks?: LogSink[];
  /** Per-value truncation cap. Default `DEFAULT_MAX_VALUE_LENGTH`. */
  maxValueLength?: number;
  /**
   * Known secret literals (e.g. a resolved API token) to scrub anywhere they
   * appear in a value, even inside free-form messages or hook output.
   */
  secrets?: string[];
  /** Clock injection for deterministic tests. Default `() => new Date()`. */
  now?: () => Date;
}

/** Issue-scoped context required on issue logs (§13.1). */
export interface IssueLogContext {
  issue_id: string;
  issue_identifier: string;
}

/** Session-scoped context required on session-lifecycle logs (§13.1). */
export interface SessionLogContext {
  session_id: string;
}

/**
 * Structured logger. Construct once at startup; derive issue/session scoped
 * child loggers as work flows through the orchestrator.
 */
export class Logger {
  private readonly level: LogLevel;
  private readonly sinks: LogSink[];
  private readonly maxValueLength: number;
  private readonly secrets: string[];
  private readonly now: () => Date;
  private readonly base: LogContext;

  constructor(options: LoggerOptions = {}, base: LogContext = {}) {
    this.level = options.level ?? "info";
    this.sinks =
      options.sinks && options.sinks.length > 0
        ? options.sinks
        : [new StderrSink()];
    this.maxValueLength = options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH;
    this.secrets = (options.secrets ?? []).filter(
      (s) => typeof s === "string" && s.length > 0,
    );
    this.now = options.now ?? (() => new Date());
    this.base = base;
  }

  /** Register additional secret literals to scrub from all future output. */
  addSecret(secret: string | null | undefined): void {
    if (typeof secret === "string" && secret.length > 0) {
      this.secrets.push(secret);
    }
  }

  /** Derive a child logger that carries `context` on every line. */
  with(context: LogContext): Logger {
    const child = new Logger(
      {
        level: this.level,
        sinks: this.sinks,
        maxValueLength: this.maxValueLength,
        secrets: this.secrets,
        now: this.now,
      },
      { ...this.base, ...context },
    );
    return child;
  }

  /** Derive a logger bound to an issue (carries the required §13.1 fields). */
  forIssue(issue: IssueLogContext): Logger {
    return this.with({
      issue_id: issue.issue_id,
      issue_identifier: issue.issue_identifier,
    });
  }

  /** Derive a logger bound to a session (carries the required §13.1 field). */
  forSession(session: SessionLogContext): Logger {
    return this.with({ session_id: session.session_id });
  }

  debug(event: string, context: LogContext = {}): void {
    this.emit("debug", event, context);
  }

  info(event: string, context: LogContext = {}): void {
    this.emit("info", event, context);
  }

  warn(event: string, context: LogContext = {}): void {
    this.emit("warn", event, context);
  }

  error(event: string, context: LogContext = {}): void {
    this.emit("error", event, context);
  }

  /**
   * Build and fan out a record. Redaction + truncation happen here so every
   * sink receives clean data. Sink failures are isolated (FR-OB-2).
   */
  private emit(level: LogLevel, event: string, context: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const merged = { ...this.base, ...context };
    const safeContext = this.sanitizeContext(merged);
    const record: LogRecord = {
      timestamp: this.now().toISOString(),
      level,
      event,
      context: safeContext,
    };
    const formatted = formatRecord(record);

    const failedSinks: { name: string; error: string }[] = [];
    for (const sink of this.sinks) {
      try {
        sink.write(record, formatted);
      } catch (err) {
        failedSinks.push({
          name: sink.name,
          error: errorMessage(err),
        });
      }
    }

    // A failing sink must not crash the service; surface the failure through
    // any sink that is still healthy (§13.2 / FR-OB-2).
    if (failedSinks.length > 0 && failedSinks.length < this.sinks.length) {
      const warnContext = this.sanitizeContext({
        outcome: "failed",
        failed_sinks: failedSinks.map((f) => f.name).join(","),
        reason: failedSinks.map((f) => `${f.name}: ${f.error}`).join("; "),
      });
      const warnRecord: LogRecord = {
        timestamp: this.now().toISOString(),
        level: "warn",
        event: "log_sink_failed",
        context: warnContext,
      };
      const warnFormatted = formatRecord(warnRecord);
      for (const sink of this.sinks) {
        if (failedSinks.some((f) => f.name === sink.name)) continue;
        try {
          sink.write(warnRecord, warnFormatted);
        } catch {
          // Best-effort only; never throw out of the logger.
        }
      }
    }
    // If ALL sinks failed there is nowhere to report — swallow rather than
    // crash the service (FR-OB-2).
  }

  /** Redact secret keys/literals and truncate long values. */
  private sanitizeContext(context: LogContext): LogContext {
    const out: LogContext = {};
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) continue;
      if (isSecretKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = this.sanitizeValue(value);
    }
    return out;
  }

  private sanitizeValue(value: unknown): unknown {
    if (value === null) return null;
    if (typeof value === "string") {
      return truncated(this.scrubSecrets(value), this.maxValueLength);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    // Objects/arrays: serialize, scrub, then truncate so payloads stay small.
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
    return truncated(this.scrubSecrets(serialized), this.maxValueLength);
  }

  /** Replace any registered secret literal occurrences with `[REDACTED]`. */
  private scrubSecrets(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (secret.length === 0) continue;
      out = out.split(secret).join(REDACTED);
    }
    return out;
  }
}

/** Extract a concise message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Format a record as a single stable `key=value` line (§13.1). Order:
 * `ts level event` then context keys in insertion order. Values that contain
 * whitespace, `=`, or quotes are wrapped in double quotes and escaped.
 */
export function formatRecord(record: LogRecord): string {
  const parts: string[] = [
    `ts=${record.timestamp}`,
    `level=${record.level}`,
    `event=${record.event}`,
  ];
  for (const [key, value] of Object.entries(record.context)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

function formatValue(value: unknown): string {
  let s: string;
  if (value === null) {
    s = "null";
  } else if (typeof value === "string") {
    s = value;
  } else {
    s = String(value);
  }
  if (s.length === 0) return '""';
  if (/[\s="]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Default operator-visible sink: writes formatted lines to stderr (§13.2). */
export class StderrSink implements LogSink {
  readonly name = "stderr";
  write(_record: LogRecord, formatted: string): void {
    process.stderr.write(`${formatted}\n`);
  }
}

/**
 * In-memory sink useful for tests and buffered diagnostics. Captures both the
 * structured record and the formatted line.
 */
export class MemorySink implements LogSink {
  readonly name: string;
  readonly records: LogRecord[] = [];
  readonly lines: string[] = [];

  constructor(name = "memory") {
    this.name = name;
  }

  write(record: LogRecord, formatted: string): void {
    this.records.push(record);
    this.lines.push(formatted);
  }
}

/** Build the default logger (stderr sink) for startup wiring. */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}
