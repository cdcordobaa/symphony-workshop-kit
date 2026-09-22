/**
 * Demo-unit spec (ARK-65).
 *
 * Asserts both halves of the acceptance criterion: the exact string logged, and
 * that it is logged *once* — a `console.log` called twice with the right text
 * would still be wrong.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { helloWorld } from "../../src/demo/hello-world.js";

describe("helloWorld", () => {
  it("logs `Hello World` exactly once", () => {
    const calls: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]): void => {
      calls.push(args);
    };

    try {
      const result = helloWorld();
      assert.equal(result, undefined, "helloWorld() returns void");
    } finally {
      console.log = original;
    }

    assert.equal(calls.length, 1, "console.log called exactly once");
    assert.deepEqual(calls[0], ["Hello World"]);
  });
});
