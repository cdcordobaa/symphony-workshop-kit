/**
 * Public surface of the observability layer (Symphony spec §13).
 *
 * Later units import from `src/observability/index.js` rather than reaching into
 * individual files, matching the seam `src/domain/index.js` establishes. What they
 * should depend on is the *port* — `Logger` / `StatusSurface` from the domain layer
 * — and take one of the factories here only at the composition root (§3.2).
 */

export {
  createLogger,
  jsonLinesSink,
  nullLogger,
  terminalSink,
  type LogFormat,
  type LoggerOptions,
  type LogRecord,
  type LogSink,
  type TerminalSinkOptions,
  type WritableLike,
} from "./logger.js";

export {
  createSecretRegistry,
  isSecretKey,
  MIN_REGISTERED_SECRET_LENGTH,
  redactContext,
  redactValue,
  REDACTED,
  type RedactOptions,
  type SecretRegistry,
} from "./redact.js";

export {
  createStatusSurface,
  formatDuration,
  formatStatusLine,
  nullStatusSurface,
  type StatusLineOptions,
  type StatusSurfaceOptions,
} from "./status.js";
