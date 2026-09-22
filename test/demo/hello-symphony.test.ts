/**
 * Demo spec (ARK-66).
 *
 * `console.log` is the observable behavior, so the assertion has to capture it: the
 * original is swapped out and restored in a `finally`, otherwise a failure inside the
 * case would leave every later test in the run writing into this array.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { helloSymphony } from "../../src/demo/hello-symphony.js";

describe("helloSymphony (ARK-66)", () => {
  it("logs `Hello Symphony` exactly once", () => {
    const captured: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]): void => {
      captured.push(args);
    };

    let returned: unknown;
    try {
      returned = helloSymphony();
    } finally {
      console.log = originalLog;
    }

    assert.equal(captured.length, 1, "expected exactly one console.log call");
    assert.deepEqual(captured[0], ["Hello Symphony"]);
    assert.equal(returned, undefined, "helloSymphony() returns void");
    assert.equal(helloSymphony.length, 0, "helloSymphony() takes no arguments");
  });
});
