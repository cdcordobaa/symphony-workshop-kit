import { describe, expect, it } from "vitest";
import { makeSessionId, parseProtocolLine } from "../protocol.js";

describe("parseProtocolLine", () => {
  it("parses the init line into a session_init with the thread id", () => {
    const p = parseProtocolLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "t-1" }),
    );
    expect(p).toEqual({ kind: "session_init", threadId: "t-1" });
  });

  it("parses a successful result into turn_completed", () => {
    const p = parseProtocolLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "t-1",
        result: "all good",
      }),
    );
    expect(p.kind).toBe("turn_completed");
  });

  it("parses an error result into turn_failed with category turn_failed", () => {
    const p = parseProtocolLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "t-1",
        result: "exploded",
      }),
    );
    expect(p.kind).toBe("turn_failed");
    if (p.kind === "turn_failed") expect(p.category).toBe("turn_failed");
  });

  it("maps a permission/user-input error to input_required (high-trust)", () => {
    const p = parseProtocolLine(
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        session_id: "t-1",
        result: "needs permission to run command",
      }),
    );
    expect(p.kind).toBe("input_required");
  });

  it("reports a non-JSON line as malformed", () => {
    expect(parseProtocolLine("not json {").kind).toBe("malformed");
  });

  it("ignores blank lines", () => {
    expect(parseProtocolLine("   ").kind).toBe("ignored");
  });

  it("treats assistant/user lines as non-terminal notifications", () => {
    expect(
      parseProtocolLine(
        JSON.stringify({ type: "assistant", session_id: "t-1", message: {} }),
      ).kind,
    ).toBe("notification");
  });
});

describe("makeSessionId", () => {
  it("joins thread and turn ids per §10.2", () => {
    expect(makeSessionId("thread-abc", "1")).toBe("thread-abc-1");
  });
});
