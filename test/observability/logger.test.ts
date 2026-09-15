/**
 * Logger specs (ARK-60 / SYM-003) — §13.1 conventions, §13.2 sinks.
 *
 * Covers all of this ticket's logging acceptance criteria: the three REQUIRED
 * context fields, output that is both machine-parseable and human-readable, no
 * secret values in output, and a failing sink that cannot reach its caller.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Logger } from "../../src/domain/index.js";
import {
  createLogger,
  createSecretRegistry,
  jsonLinesSink,
  nullLogger,
  REDACTED,
  terminalSink,
  type LogRecord,
  type LogSink,
} from "../../src/observability/index.js";

import { captureStream, frozenClock } from "./helpers.js";

const AT = "2026-09-15T01:23:45.678Z";

/** Drop ANSI styling, so a spec can assert text without depending on NO_COLOR. */
function stripAnsi(text: string): string {
  return text.replace(/\[\d+m/g, "");
}

/** A logger writing JSON Lines into a capturing stream on a frozen clock. */
function jsonLogger(overrides: Parameters<typeof createLogger>[0] = {}) {
  const stream = captureStream();
  const logger = createLogger({
    stream,
    format: "json",
    now: frozenClock(AT),
    ...overrides,
  });
  return { logger, stream };
}

describe("required context fields (§13.1, FR18)", () => {
  it("carries issue_id, issue_identifier, and session_id on a record", () => {
    const { logger, stream } = jsonLogger();

    logger.info("agent session started", {
      issue_id: "8058cfc4",
      issue_identifier: "ARK-60",
      session_id: "thread-1-turn-1",
    });

    const [record] = stream.json();
    assert.ok(record);
    assert.equal(record.issue_id, "8058cfc4");
    assert.equal(record.issue_identifier, "ARK-60");
    assert.equal(record.session_id, "thread-1-turn-1");
  });

  it("puts the fields at the top level, so they are greppable", () => {
    const { logger, stream } = jsonLogger();

    logger.info("dispatch completed", { issue_identifier: "ARK-60" });

    // `jq 'select(.issue_identifier == "ARK-60")'` must work with no nesting.
    assert.match(stream.text(), /"issue_identifier":"ARK-60"/);
  });

  it("stamps every record with a timestamp, level, and message", () => {
    const { logger, stream } = jsonLogger();

    logger.error("dispatch failed", { issue_identifier: "ARK-60" });

    const [record] = stream.json();
    assert.ok(record);
    assert.equal(record.ts, AT);
    assert.equal(record.level, "error");
    assert.equal(record.msg, "dispatch failed");
  });
});

describe("output shape (structured and human-readable)", () => {
  it("emits one parseable JSON object per line", () => {
    const { logger, stream } = jsonLogger();

    logger.info("first", { issue_identifier: "ARK-60" });
    logger.info("second", { issue_identifier: "ARK-61" });

    assert.equal(stream.lines().length, 2);
    const records = stream.json(); // throws if either line is not valid JSON
    assert.deepEqual(
      records.map((record) => record.msg),
      ["first", "second"],
    );
  });

  it("emits a readable key=value line for a terminal (§13.1)", () => {
    const stream = captureStream({ isTTY: true });
    const logger = createLogger({
      sinks: [terminalSink(stream, { color: false })],
      now: frozenClock(AT),
    });

    logger.info("run completed", {
      issue_identifier: "ARK-60",
      session_id: "thread-1",
      outcome: "completed",
    });

    const [line] = stream.lines();
    assert.equal(
      line,
      "01:23:45.678 INFO  run completed issue_identifier=ARK-60 session_id=thread-1 outcome=completed",
    );
  });

  it("quotes only the values that would be ambiguous to split on", () => {
    const stream = captureStream();
    const logger = createLogger({
      sinks: [terminalSink(stream, { color: false })],
      now: frozenClock(AT),
    });

    logger.warn("retrying", { reason: "connection reset by peer", attempt: 2 });

    const [line] = stream.lines();
    assert.ok(line);
    assert.match(line, /reason="connection reset by peer"/);
    assert.match(line, /attempt=2/);
  });

  it("defaults to JSON when the destination is not a terminal", () => {
    const piped = captureStream({ isTTY: false });
    createLogger({ stream: piped, now: frozenClock(AT) }).info("piped");

    // `symphony ... 2> run.log` must stay parseable with no extra flag.
    assert.doesNotThrow(() => piped.json());
  });

  it("defaults to a human line when the destination is a terminal", () => {
    const tty = captureStream({ isTTY: true });
    createLogger({ stream: tty, now: frozenClock(AT) }).info("live");

    // Whether that line is colored depends on the ambient NO_COLOR, so compare
    // the text with any styling stripped; coloring is asserted separately below.
    assert.match(stripAnsi(tty.text()), /^01:23:45\.678 INFO {2}live\n$/);
  });

  it("colors the level for a terminal when asked", () => {
    const stream = captureStream({ isTTY: true });
    createLogger({
      sinks: [terminalSink(stream, { color: true })],
      now: frozenClock(AT),
    }).error("dispatch failed");

    assert.match(stream.text(), /\[31mERROR\[0m/);
    assert.match(stripAnsi(stream.text()), /ERROR dispatch failed/);
  });

  it("can emit both formats at once", () => {
    const stream = captureStream();
    createLogger({ stream, format: "both", now: frozenClock(AT) }).info("twice");

    assert.equal(stream.lines().length, 2);
  });
});

describe("context inheritance", () => {
  it("merges child context into every record", () => {
    const { logger, stream } = jsonLogger({
      context: { service: "symphony" },
    });

    const issueLogger = logger.child({
      issue_id: "8058cfc4",
      issue_identifier: "ARK-60",
    });
    issueLogger.child({ session_id: "thread-1" }).info("started");

    const [record] = stream.json();
    assert.ok(record);
    assert.equal(record.service, "symphony");
    assert.equal(record.issue_identifier, "ARK-60");
    assert.equal(record.session_id, "thread-1");
  });

  it("lets a call-site field win over inherited context", () => {
    const { logger, stream } = jsonLogger({
      context: { issue_identifier: "ARK-60" },
    });

    logger.info("other issue", { issue_identifier: "ARK-61" });

    const [record] = stream.json();
    assert.equal(record?.issue_identifier, "ARK-61");
  });

  it("does not leak child context back into the parent", () => {
    const { logger, stream } = jsonLogger();

    logger.child({ session_id: "thread-1" }).info("child");
    logger.info("parent");

    const [child, parent] = stream.json();
    assert.equal(child?.session_id, "thread-1");
    assert.equal(parent?.session_id, undefined);
  });

  it("preserves a context key that collides with an envelope field", () => {
    const { logger, stream } = jsonLogger();

    logger.info("real message", { msg: "shadowed", level: "bogus" });

    const [record] = stream.json();
    assert.equal(record?.msg, "real message", "the envelope must win");
    assert.equal(record?.level, "info");
    assert.equal(record?.context_msg, "shadowed", "but nothing is dropped");
    assert.equal(record?.context_level, "bogus");
  });
});

describe("level threshold", () => {
  it("drops records below the configured level", () => {
    const { logger, stream } = jsonLogger({ level: "warn" });

    logger.debug("no");
    logger.info("no");
    logger.warn("yes");
    logger.error("yes");

    assert.deepEqual(
      stream.json().map((record) => record.level),
      ["warn", "error"],
    );
  });

  it("emits everything at debug", () => {
    const { logger, stream } = jsonLogger({ level: "debug" });

    logger.debug("yes");

    assert.equal(stream.lines().length, 1);
  });
});

describe("secret handling (§15.3, FR21)", () => {
  it("redacts a value under a secret-looking key", () => {
    const { logger, stream } = jsonLogger();

    logger.info("config loaded", { auth: "ntn_abcdef123456", kind: "notion" });

    const [record] = stream.json();
    assert.equal(record?.auth, REDACTED);
    assert.equal(record?.kind, "notion");
  });

  it("scrubs a registered secret out of the message itself", () => {
    const secrets = createSecretRegistry("ntn_abcdef123456");
    const { logger, stream } = jsonLogger({ secrets });

    logger.error("tracker rejected token ntn_abcdef123456");

    assert.equal(stream.text().includes("ntn_abcdef123456"), false);
    assert.match(stream.text(), /tracker rejected token \[REDACTED\]/);
  });

  it("scrubs a secret registered after the logger was built", () => {
    // The real sequence: the logger comes up first so startup failures are
    // visible (§13.2), and the config loader resolves `$VAR`s afterwards.
    const secrets = createSecretRegistry();
    const { logger, stream } = jsonLogger({ secrets });

    secrets.register("ntn_abcdef123456");
    logger.info("using ntn_abcdef123456");

    assert.equal(stream.text().includes("ntn_abcdef123456"), false);
  });

  it("keeps secrets out of nested context values", () => {
    const secrets = createSecretRegistry("ntn_abcdef123456");
    const { logger, stream } = jsonLogger({ secrets });

    logger.error("request failed", {
      issue_identifier: "ARK-60",
      request: { headers: { Authorization: "Bearer ntn_abcdef123456" } },
      hint: "retry with ntn_abcdef123456",
    });

    assert.equal(stream.text().includes("ntn_abcdef123456"), false);
    assert.match(stream.text(), /"issue_identifier":"ARK-60"/);
  });
});

describe("sink failure isolation (§13.2)", () => {
  /** A sink that always throws. Named, so the warning can name it. */
  const brokenSink: LogSink = () => {
    throw new Error("EPIPE: broken pipe");
  };

  it("does not throw into the caller when a sink fails", () => {
    const logger = createLogger({ sinks: [brokenSink], now: frozenClock(AT) });

    assert.doesNotThrow(() => logger.info("still fine"));
    assert.doesNotThrow(() => logger.error("still fine"));
  });

  it("keeps delivering to the healthy sinks", () => {
    const healthy = captureStream();
    const logger = createLogger({
      sinks: [brokenSink, jsonLinesSink(healthy)],
      now: frozenClock(AT),
    });

    logger.info("delivered anyway", { issue_identifier: "ARK-60" });

    const records = healthy.json();
    assert.equal(records[0]?.msg, "delivered anyway");
  });

  it("warns about the failure through a surviving sink", () => {
    const healthy = captureStream();
    const logger = createLogger({
      sinks: [brokenSink, jsonLinesSink(healthy)],
      now: frozenClock(AT),
    });

    logger.info("first");

    const warning = healthy.json()[1];
    assert.ok(warning, "a warning must reach the remaining sink");
    assert.equal(warning.level, "warn");
    assert.equal(warning.msg, "log sink failed");
    assert.equal(warning.sink, "brokenSink");
    assert.equal(warning.reason, "EPIPE: broken pipe");
    assert.equal(warning.consecutive_failures, 1);
    assert.equal(warning.sink_disabled, false);
  });

  it("disables a sink that keeps failing, and stops re-warning", () => {
    const healthy = captureStream();
    const logger = createLogger({
      sinks: [brokenSink, jsonLinesSink(healthy)],
      now: frozenClock(AT),
      maxSinkFailures: 2,
    });

    logger.info("one"); // failure 1 -> record + warning
    logger.info("two"); // failure 2 -> record + warning, sink now disabled
    healthy.clear();
    logger.info("three"); // broken sink skipped entirely

    const records = healthy.json();
    assert.equal(records.length, 1, "no further warning once disabled");
    assert.equal(records[0]?.msg, "three");
  });

  it("says so when the sink is disabled", () => {
    const healthy = captureStream();
    const logger = createLogger({
      sinks: [brokenSink, jsonLinesSink(healthy)],
      now: frozenClock(AT),
      maxSinkFailures: 1,
    });

    logger.info("one");

    const warning = healthy.json()[1];
    assert.equal(warning?.sink_disabled, true);
  });

  it("survives every sink being broken", () => {
    const logger = createLogger({
      sinks: [brokenSink, brokenSink],
      now: frozenClock(AT),
    });

    assert.doesNotThrow(() => logger.info("nowhere to go"));
  });

  it("survives a context value that throws while being read", () => {
    const healthy = captureStream();
    const logger = createLogger({
      sinks: [jsonLinesSink(healthy)],
      now: frozenClock(AT),
    });

    const hostile = {
      get boom(): string {
        throw new Error("getter exploded");
      },
    };

    assert.doesNotThrow(() => logger.info("hostile context", hostile));
  });

  it("recovers a sink that fails only intermittently", () => {
    const healthy = captureStream();
    let calls = 0;
    const flaky: LogSink = (record: LogRecord) => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      healthy.write(`${JSON.stringify(record)}\n`);
    };

    const logger = createLogger({
      sinks: [flaky],
      now: frozenClock(AT),
      maxSinkFailures: 3,
    });

    logger.info("dropped");
    logger.info("delivered");

    // A single hiccup must not permanently blind the operator.
    assert.deepEqual(
      healthy.json().map((record) => record.msg),
      ["delivered"],
    );
  });
});

describe("nullLogger", () => {
  it("satisfies the port and emits nothing", () => {
    const logger: Logger = nullLogger();

    assert.doesNotThrow(() => {
      logger.debug("x");
      logger.info("x");
      logger.warn("x");
      logger.error("x");
      logger.child({ issue_id: "abc" }).info("x");
    });
  });
});
