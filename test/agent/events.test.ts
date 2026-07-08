/**
 * Claude Code stream-json event parsing + session derivation (§10.2–§10.4).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveSessionId,
  extractSessionId,
  extractTurnId,
  isUserInputRequired,
  parseEventLine,
} from "../../src/agent/events.js";

const TS = "2026-07-08T00:00:00.000Z";

test("classifies system/init as session_started and pulls session_id", () => {
  const e = parseEventLine('{"type":"system","subtype":"init","session_id":"t-1"}', TS);
  assert.equal(e.event, "session_started");
  assert.equal(e.session_id, "t-1");
});

test("classifies a successful result as turn_completed with its message + uuid", () => {
  const e = parseEventLine(
    '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"t-1","uuid":"turn-9"}',
    TS,
  );
  assert.equal(e.event, "turn_completed");
  assert.equal(e.message, "ok");
  assert.equal(e.turn_id, "turn-9");
});

test("classifies an errored result as turn_failed", () => {
  const e = parseEventLine(
    '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"t-1"}',
    TS,
  );
  assert.equal(e.event, "turn_failed");
});

test("classifies a cancelled result as turn_cancelled", () => {
  const e = parseEventLine('{"type":"result","subtype":"turn_cancelled","is_error":true}', TS);
  assert.equal(e.event, "turn_cancelled");
});

test("a control_request is a user-input-required event", () => {
  const e = parseEventLine('{"type":"control_request","request_id":"1"}', TS);
  assert.equal(e.event, "turn_input_required");
  assert.equal(isUserInputRequired({ type: "control_request" }), true);
});

test("an input_required subtype is detected as user-input-required", () => {
  assert.equal(isUserInputRequired({ type: "system", subtype: "user_input_required" }), true);
  assert.equal(isUserInputRequired({ type: "system", subtype: "init" }), false);
});

test("assistant/user messages are notifications", () => {
  assert.equal(parseEventLine('{"type":"assistant","message":{}}', TS).event, "notification");
  assert.equal(parseEventLine('{"type":"user","message":{}}', TS).event, "notification");
});

test("a non-JSON line becomes a malformed event (never throws)", () => {
  const e = parseEventLine("not json {", TS);
  assert.equal(e.event, "malformed");
  assert.equal(e.raw, "not json {");
});

test("extractors read session_id and uuid", () => {
  assert.equal(extractSessionId({ session_id: "t-1" }), "t-1");
  assert.equal(extractSessionId({}), undefined);
  assert.equal(extractTurnId({ uuid: "u-1" }), "u-1");
});

test("deriveSessionId joins thread and turn as <thread>-<turn> [FR16]", () => {
  assert.equal(deriveSessionId("t-1", "turn-9"), "t-1-turn-9");
  assert.equal(deriveSessionId(undefined, undefined), "unknown-0");
});
