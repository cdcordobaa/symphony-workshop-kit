import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_VALUE_LENGTH,
  Logger,
  LogRecord,
  LogSink,
  MemorySink,
  formatRecord,
} from "../log.js";

/** Fixed clock for deterministic timestamps. */
const fixedNow = () => new Date("2026-06-02T12:00:00.000Z");

function makeLogger(extra: Partial<ConstructorParameters<typeof Logger>[0]> = {}) {
  const sink = new MemorySink();
  const logger = new Logger({ level: "debug", sinks: [sink], now: fixedNow, ...extra });
  return { logger, sink };
}

describe("Logger context fields (§13.1, FR-OB-1)", () => {
  it("issue logs always include issue_id and issue_identifier", () => {
    const { logger, sink } = makeLogger();
    logger
      .forIssue({ issue_id: "abc-123", issue_identifier: "SYM-7" })
      .info("dispatch", { outcome: "completed" });

    const rec = sink.records[0]!;
    expect(rec.context.issue_id).toBe("abc-123");
    expect(rec.context.issue_identifier).toBe("SYM-7");
    expect(rec.context.outcome).toBe("completed");
    expect(sink.lines[0]).toContain("issue_id=abc-123");
    expect(sink.lines[0]).toContain("issue_identifier=SYM-7");
    expect(sink.lines[0]).toContain("event=dispatch");
  });

  it("session-lifecycle logs include session_id", () => {
    const { logger, sink } = makeLogger();
    logger
      .forSession({ session_id: "thread-1-turn-2" })
      .info("session_started");
    expect(sink.records[0]!.context.session_id).toBe("thread-1-turn-2");
    expect(sink.lines[0]).toContain("session_id=thread-1-turn-2");
  });

  it("carries issue + session context together via chained children", () => {
    const { logger, sink } = makeLogger();
    logger
      .forIssue({ issue_id: "id1", issue_identifier: "SYM-1" })
      .forSession({ session_id: "s1" })
      .error("turn_failed", { outcome: "failed", reason: "user input required" });
    const line = sink.lines[0]!;
    expect(line).toContain("issue_id=id1");
    expect(line).toContain("session_id=s1");
    expect(line).toContain("outcome=failed");
    expect(line).toContain('reason="user input required"');
  });

  it("emits stable key=value phrasing with ts/level/event ordering", () => {
    const { logger, sink } = makeLogger();
    logger.info("startup", { ok: true });
    expect(sink.lines[0]).toBe(
      "ts=2026-06-02T12:00:00.000Z level=info event=startup ok=true",
    );
  });
});

describe("Secret redaction (§15.3, NFR-SECRETS)", () => {
  it("redacts secret-looking context keys", () => {
    const { logger, sink } = makeLogger();
    logger.info("config_loaded", {
      tracker_api_key: "ntn_supersecret",
      notion_token: "secret-token",
      authorization: "Bearer xyz",
      database: "db-public",
    });
    const ctx = sink.records[0]!.context;
    expect(ctx.tracker_api_key).toBe("[REDACTED]");
    expect(ctx.notion_token).toBe("[REDACTED]");
    expect(ctx.authorization).toBe("[REDACTED]");
    expect(ctx.database).toBe("db-public");
    const line = sink.lines[0]!;
    expect(line).not.toContain("ntn_supersecret");
    expect(line).not.toContain("Bearer xyz");
  });

  it("scrubs registered secret literals anywhere they appear", () => {
    const { logger, sink } = makeLogger({ secrets: ["ntn_TOKEN_VALUE"] });
    logger.info("agent_event", {
      message: "exporting NOTION_TOKEN=ntn_TOKEN_VALUE to env",
    });
    const line = sink.lines[0]!;
    expect(line).not.toContain("ntn_TOKEN_VALUE");
    expect(line).toContain("[REDACTED]");
  });

  it("addSecret scrubs literals registered after construction", () => {
    const { logger, sink } = makeLogger();
    logger.addSecret("late-secret");
    logger.info("evt", { detail: "value=late-secret" });
    expect(sink.lines[0]).not.toContain("late-secret");
  });
});

describe("Truncation (NFR-HOOK-SAFETY)", () => {
  it("truncates long hook/agent output values", () => {
    const { logger, sink } = makeLogger({ maxValueLength: 50 });
    const big = "x".repeat(500);
    logger.info("hook_output", { stdout: big });
    const value = sink.records[0]!.context.stdout as string;
    expect(value.length).toBeLessThan(big.length);
    expect(value).toContain("…[+450 chars]");
  });

  it("uses a sensible default truncation cap", () => {
    const { logger, sink } = makeLogger();
    const big = "y".repeat(DEFAULT_MAX_VALUE_LENGTH + 100);
    logger.info("agent_output", { text: big });
    const value = sink.records[0]!.context.text as string;
    expect(value).toContain(`…[+100 chars]`);
  });
});

describe("Sink failure resilience (§13.2, FR-OB-2)", () => {
  it("a throwing sink does not crash; other sinks still receive the record", () => {
    const throwing: LogSink = {
      name: "boom",
      write() {
        throw new Error("disk full");
      },
    };
    const healthy = new MemorySink("healthy");
    const logger = new Logger({
      level: "info",
      sinks: [throwing, healthy],
      now: fixedNow,
    });

    expect(() => logger.info("dispatch", { outcome: "completed" })).not.toThrow();

    // The original record reached the healthy sink...
    expect(healthy.records[0]!.event).toBe("dispatch");
    // ...plus a surfaced log_sink_failed warning naming the broken sink.
    const warn = healthy.records.find((r) => r.event === "log_sink_failed");
    expect(warn).toBeDefined();
    expect(warn!.level).toBe("warn");
    expect(warn!.context.failed_sinks).toContain("boom");
    expect(String(warn!.context.reason)).toContain("disk full");
  });

  it("does not throw even when every sink fails", () => {
    const throwing: LogSink = {
      name: "boom",
      write() {
        throw new Error("nope");
      },
    };
    const logger = new Logger({ sinks: [throwing], now: fixedNow });
    expect(() => logger.error("startup_failed", { reason: "x" })).not.toThrow();
  });
});

describe("Level filtering", () => {
  it("suppresses records below the configured level", () => {
    const { logger, sink } = makeLogger({ level: "warn" });
    logger.info("ignored");
    logger.warn("kept");
    expect(sink.records.map((r) => r.event)).toEqual(["kept"]);
  });
});

describe("formatRecord", () => {
  it("quotes values containing whitespace, = or quotes and escapes them", () => {
    const rec: LogRecord = {
      timestamp: "2026-06-02T00:00:00.000Z",
      level: "info",
      event: "evt",
      context: { reason: 'he said "hi" = ok', plain: "value" },
    };
    const line = formatRecord(rec);
    expect(line).toContain('reason="he said \\"hi\\" = ok"');
    expect(line).toContain("plain=value");
  });
});
