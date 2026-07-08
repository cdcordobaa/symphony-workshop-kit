import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord } from "../../src/domain/interfaces.js";
import {
  createLogger,
  formatJsonLine,
  formatTextLine,
  streamSink,
} from "../../src/observability/logger.js";
import { REDACTED } from "../../src/observability/redact.js";

/** In-memory sink capturing records for assertions. */
function captureSink() {
  const records: LogRecord[] = [];
  return { records, write: (r: LogRecord) => void records.push(r) };
}

/** In-memory text stream capturing written lines. */
function captureStream() {
  const chunks: string[] = [];
  return { chunks, write: (c: string) => void chunks.push(c) };
}

const FIXED = () => new Date("2026-07-08T12:00:00.000Z");

test("log records carry the required §13.1 context fields [FR18]", () => {
  const sink = captureSink();
  const log = createLogger({ sinks: [sink], now: FIXED });

  log.info("dispatching agent", {
    issue_id: "iss_123",
    issue_identifier: "ARK-51",
    session_id: "sess_abc",
  });

  assert.equal(sink.records.length, 1);
  const rec = sink.records[0]!;
  assert.equal(rec.context.issue_id, "iss_123");
  assert.equal(rec.context.issue_identifier, "ARK-51");
  assert.equal(rec.context.session_id, "sess_abc");
  assert.equal(rec.time, "2026-07-08T12:00:00.000Z");
  assert.equal(rec.level, "info");
});

test("child() binds context that merges into every record", () => {
  const sink = captureSink();
  const base = createLogger({ sinks: [sink], now: FIXED });
  const issueLog = base.child({ issue_id: "iss_1", issue_identifier: "ARK-51" });
  const sessionLog = issueLog.child({ session_id: "sess_9" });

  sessionLog.warn("agent failed", { outcome: "failed", reason: "timeout" });

  const rec = sink.records[0]!;
  assert.equal(rec.context.issue_id, "iss_1");
  assert.equal(rec.context.issue_identifier, "ARK-51");
  assert.equal(rec.context.session_id, "sess_9");
  assert.equal(rec.context.outcome, "failed");
  // Call-site context wins over bound context on key collision.
  const overridden = issueLog.child({ issue_identifier: "OVERRIDE" });
  overridden.info("x", { issue_identifier: "CALLSITE" });
  assert.equal(sink.records[1]!.context.issue_identifier, "CALLSITE");
});

test("JSON-line format is machine-parseable with flattened context", () => {
  const line = formatJsonLine({
    time: "2026-07-08T12:00:00.000Z",
    level: "info",
    message: "completed",
    context: { issue_identifier: "ARK-51", outcome: "completed" },
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.message, "completed");
  assert.equal(parsed.issue_identifier, "ARK-51");
  assert.equal(parsed.outcome, "completed");
});

test("text format uses stable human-readable key=value phrasing (§13.1)", () => {
  const line = formatTextLine({
    time: "2026-07-08T12:00:00.000Z",
    level: "error",
    message: "agent failed",
    context: { issue_identifier: "ARK-51", outcome: "failed" },
  });
  assert.match(line, /^2026-07-08T12:00:00\.000Z ERROR agent failed /);
  assert.match(line, /issue_identifier=ARK-51/);
  assert.match(line, /outcome=failed/);
});

test("both formats reach a real stream via streamSink", () => {
  const stream = captureStream();
  const log = createLogger({ sinks: [streamSink(stream, "json")], now: FIXED });
  log.info("hello", { issue_identifier: "ARK-51" });
  assert.equal(stream.chunks.length, 1);
  assert.ok(stream.chunks[0]!.endsWith("\n"));
  assert.equal(JSON.parse(stream.chunks[0]!).issue_identifier, "ARK-51");
});

test("level threshold drops records below the configured minimum", () => {
  const sink = captureSink();
  const log = createLogger({ sinks: [sink], level: "warn", now: FIXED });
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  assert.deepEqual(
    sink.records.map((r) => r.level),
    ["warn", "error"],
  );
});

test("a failing sink never throws into the caller (§13.2)", () => {
  const good = captureSink();
  const boom = {
    write() {
      throw new Error("sink is down");
    },
  };
  const log = createLogger({ sinks: [boom, good], now: FIXED });

  // Must not throw despite the broken sink...
  assert.doesNotThrow(() => log.info("still logging", { issue_identifier: "ARK-51" }));
  // ...and the healthy sink still received the record.
  assert.equal(good.records.length, 1);
  assert.equal(good.records[0]!.context.issue_identifier, "ARK-51");
});

test("secrets never appear in any sink output [FR21]", () => {
  const SECRET = "ntn_live_super_secret_token";
  const sink = captureSink();
  const log = createLogger({ sinks: [sink], secrets: [SECRET], now: FIXED });

  log.error(`request failed with token ${SECRET}`, {
    issue_identifier: "ARK-51",
    auth: SECRET,
    detail: { nested: `bearer ${SECRET}` },
  });

  const rec = sink.records[0]!;
  const serialized = JSON.stringify(rec);
  assert.equal(serialized.includes(SECRET), false, "no secret value may appear anywhere");
  assert.equal(rec.message.includes(REDACTED), true);
  assert.equal(rec.context.auth, REDACTED);
});
