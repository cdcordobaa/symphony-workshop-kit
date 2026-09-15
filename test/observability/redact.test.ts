/**
 * Redaction specs (ARK-60 / SYM-003) — §15.3 secret handling, FR21.
 *
 * The acceptance criterion is "no secret values appear in any log output", so these
 * specs test both mechanisms *and* the gap each one leaves: a secret under an
 * innocent key name, and a secret named by a key nobody registered.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSecretRegistry,
  isSecretKey,
  MIN_REGISTERED_SECRET_LENGTH,
  redactContext,
  redactValue,
  REDACTED,
} from "../../src/observability/index.js";

describe("isSecretKey — key-based redaction", () => {
  it("matches credential-shaped keys regardless of naming style", () => {
    for (const key of [
      "auth",
      "AUTH",
      "api_key",
      "apiKey",
      "API-KEY",
      "notion_token",
      "access_token",
      "refresh_token",
      "client_secret",
      "password",
      "passwd",
      "passphrase",
      "authorization",
      "Cookie",
      "bearer_token",
      "aws_access_key",
      "private_key",
      "credentials",
      "pwd",
    ]) {
      assert.equal(isSecretKey(key), true, `${key} should be treated as secret`);
    }
  });

  it("does not redact keys that merely look like one", () => {
    // Each of these is a real field name used elsewhere in the system, and a
    // false positive here would blank out load-bearing operator detail.
    for (const key of [
      "author",
      "authority",
      "workspace_key", // §4.1.4 — a sanitized identifier, not a credential
      "keycount",
      "monkey",
      "issue_id",
      "issue_identifier",
      "session_id",
      "identifier",
      "title",
      "description",
      "database_id",
      "state",
    ]) {
      assert.equal(isSecretKey(key), false, `${key} should NOT be secret`);
    }
  });
});

describe("SecretRegistry — value-based redaction", () => {
  it("registers usable literals and ignores unusable ones", () => {
    const secrets = createSecretRegistry();

    assert.equal(secrets.register("ntn_abcdef123456"), 1);
    assert.equal(secrets.register("ntn_abcdef123456"), 0, "duplicate is ignored");
    assert.equal(secrets.register(null, undefined, ""), 0, "nullish is ignored");
    assert.equal(secrets.size, 1);
  });

  it("ignores literals too short to scrub safely", () => {
    const secrets = createSecretRegistry();
    const tooShort = "a".repeat(MIN_REGISTERED_SECRET_LENGTH - 1);

    assert.equal(secrets.register(tooShort), 0);
    assert.equal(secrets.size, 0);
    // The point of the floor: scrubbing it would rewrite unrelated output.
    assert.equal(secrets.scrub(`value=${tooShort}`), `value=${tooShort}`);
  });

  it("scrubs every occurrence of a registered literal", () => {
    const secrets = createSecretRegistry("ntn_abcdef123456");

    assert.equal(
      secrets.scrub("auth ntn_abcdef123456 then ntn_abcdef123456 again"),
      `auth ${REDACTED} then ${REDACTED} again`,
    );
  });

  it("scrubs the longest literal first, so overlaps cannot leak a tail", () => {
    const secrets = createSecretRegistry("secret_value", "secret_value_long");

    const scrubbed = secrets.scrub("token=secret_value_long");
    assert.equal(scrubbed, `token=${REDACTED}`);
    assert.ok(!scrubbed.includes("_long"), "must not leave the longer tail behind");
  });

  it("treats a literal as text, not as a pattern", () => {
    const secrets = createSecretRegistry("a+b?c(d)e");

    assert.equal(secrets.scrub("key=a+b?c(d)e"), `key=${REDACTED}`);
    assert.equal(secrets.scrub("key=aaabcde"), "key=aaabcde");
  });

  it("clears on request", () => {
    const secrets = createSecretRegistry("ntn_abcdef123456");
    secrets.clear();

    assert.equal(secrets.size, 0);
    assert.equal(secrets.has("ntn_abcdef123456"), false);
    assert.equal(secrets.scrub("ntn_abcdef123456"), "ntn_abcdef123456");
  });
});

describe("redactContext — the two mechanisms together", () => {
  it("replaces values under secret keys whatever they contain", () => {
    const shaped = redactContext({
      issue_identifier: "ARK-60",
      auth: "ntn_live_value",
      nested: { api_key: "another", database_id: "1c7826ea" },
    });

    assert.equal(shaped.issue_identifier, "ARK-60");
    assert.equal(shaped.auth, REDACTED);
    assert.deepEqual(shaped.nested, {
      api_key: REDACTED,
      database_id: "1c7826ea",
    });
  });

  it("scrubs a registered secret hiding under an innocent key", () => {
    // This is the case key-based redaction cannot see, and the reason the
    // registry exists at all.
    const secrets = createSecretRegistry("ntn_abcdef123456");
    const shaped = redactContext(
      { reason: "request rejected for ntn_abcdef123456", url: "https://x/ntn_abcdef123456" },
      { secrets },
    );

    assert.equal(shaped.reason, `request rejected for ${REDACTED}`);
    assert.equal(shaped.url, `https://x/${REDACTED}`);
  });

  it("scrubs registered secrets at any nesting depth", () => {
    const secrets = createSecretRegistry("ntn_abcdef123456");
    const shaped = redactContext(
      { payload: { headers: [{ value: "Bearer ntn_abcdef123456" }] } },
      { secrets },
    );

    assert.equal(
      JSON.stringify(shaped).includes("ntn_abcdef123456"),
      false,
      "the literal must not survive anywhere in the record",
    );
    assert.ok(JSON.stringify(shaped).includes(REDACTED));
  });

  it("drops undefined entries instead of emitting nulls", () => {
    const shaped = redactContext({ issue_id: "abc", session_id: undefined });

    assert.deepEqual(Object.keys(shaped), ["issue_id"]);
  });

  it("returns an empty object for a missing context", () => {
    assert.deepEqual(redactContext(undefined), {});
  });
});

describe("redactValue — bounds that keep a record loggable", () => {
  it("survives a circular reference", () => {
    const cyclic: Record<string, unknown> = { issue_id: "abc" };
    cyclic.self = cyclic;

    const shaped = redactValue(cyclic) as Record<string, unknown>;

    assert.equal(shaped.issue_id, "abc");
    assert.equal(shaped.self, "[Circular]");
    assert.doesNotThrow(() => JSON.stringify(shaped));
  });

  it("stops at the depth bound", () => {
    const deep = { a: { b: { c: { d: "too far" } } } };

    const shaped = redactValue(deep, { maxDepth: 2 }) as {
      a: { b: unknown };
    };
    assert.equal(shaped.a.b, "[MaxDepth]");
  });

  it("truncates a large payload rather than logging it whole (§13.1)", () => {
    const shaped = redactValue("x".repeat(100), { maxStringLength: 10 });

    assert.equal(shaped, `${"x".repeat(10)}...[truncated 90 chars]`);
  });

  it("caps array length and says how much it dropped", () => {
    const shaped = redactValue([1, 2, 3, 4, 5], { maxArrayLength: 2 });

    assert.deepEqual(shaped, [1, 2, "[+3 more]"]);
  });

  it("shapes an Error into something JSON can carry", () => {
    const error = new TypeError("bad shape", { cause: new Error("root") });

    const shaped = redactValue(error) as Record<string, unknown>;

    assert.equal(shaped.name, "TypeError");
    assert.equal(shaped.message, "bad shape");
    assert.equal(typeof shaped.stack, "string");
    assert.deepEqual((shaped.cause as Record<string, unknown>).message, "root");
  });

  it("normalizes values JSON cannot represent", () => {
    const shaped = redactValue({
      when: new Date("2026-09-15T01:00:00.000Z"),
      big: 10n,
      nan: Number.NaN,
      set: new Set(["a"]),
      map: new Map([["k", "v"]]),
      fn: () => undefined,
    }) as Record<string, unknown>;

    assert.equal(shaped.when, "2026-09-15T01:00:00.000Z");
    assert.equal(shaped.big, "10");
    assert.equal(shaped.nan, "NaN");
    assert.deepEqual(shaped.set, ["a"]);
    assert.deepEqual(shaped.map, { k: "v" });
    assert.equal(shaped.fn, "[Function]");
    assert.doesNotThrow(() => JSON.stringify(shaped));
  });

  it("does not mutate the value it was given", () => {
    const original = { auth: "ntn_abcdef123456", keep: "me" };

    redactValue(original);

    assert.equal(original.auth, "ntn_abcdef123456");
  });
});
