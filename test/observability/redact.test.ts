import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord } from "../../src/domain/interfaces.js";
import { REDACTED, redactContext, redactRecord } from "../../src/observability/redact.js";

test("value-based redaction scrubs a registered secret from message and values", () => {
  const secret = "s3cr3t-token-value";
  const record: LogRecord = {
    time: "t",
    level: "info",
    message: `auth header was ${secret}`,
    context: { issue_identifier: "ARK-51", note: `token=${secret} appended` },
  };
  const safe = redactRecord(record, [secret]);
  assert.equal(safe.message.includes(secret), false);
  assert.equal(safe.context.note?.toString().includes(secret), false);
  assert.equal(safe.context.issue_identifier, "ARK-51");
});

test("sensitive-named keys are redacted wholesale even without a registered value", () => {
  const ctx = redactContext(
    {
      issue_id: "iss_1",
      auth: "unregistered-secret",
      notion_api_key: "another",
      accessKey: "k",
      password: "p",
      database_id: "db-123",
    },
    [],
  );
  assert.equal(ctx.auth, REDACTED);
  assert.equal(ctx.notion_api_key, REDACTED);
  assert.equal(ctx.accessKey, REDACTED);
  assert.equal(ctx.password, REDACTED);
  // identifiers are not secrets — preserved for operators
  assert.equal(ctx.issue_id, "iss_1");
  assert.equal(ctx.database_id, "db-123");
});

test("nested object values are scrubbed via their JSON projection", () => {
  const secret = "deep-secret";
  const ctx = redactContext({ payload: { headers: { authz: secret }, ok: true } }, [secret]);
  const serialized = JSON.stringify(ctx.payload);
  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /ok":true/);
});

test("empty secret strings are ignored (no spurious redaction)", () => {
  const ctx = redactContext({ msg: "hello world" }, [""]);
  assert.equal(ctx.msg, "hello world");
});
