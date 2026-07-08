/**
 * Observability layer (Symphony spec §13, Core subset) — Unit 1.6 / ARK-51.
 *
 * A structured {@link Logger} with required §13.1 context fields and secret
 * redaction (FR18/FR21), plus a terminal {@link StatusSurface} reflecting the
 * currently-active runs (FR19). No HTTP/JSON API per D2.
 *
 * The `Logger` / `StatusSurface` port contracts live in `src/domain` so later
 * units depend on the stable interface, not this implementation.
 */

export {
  createLogger,
  streamSink,
  formatJsonLine,
  formatTextLine,
  type LogFormat,
  type LoggerOptions,
} from "./logger.js";
export { createStatusSurface, type StatusOptions } from "./status.js";
export { redactRecord, redactContext, REDACTED } from "./redact.js";
