/**
 * Demo spec (ARK-67).
 *
 * Captures `console.log` the same way the ARK-66 spec does — swap the original out,
 * restore it in a `finally` so a failure inside the case cannot leave later tests
 * writing into this array.
 *
 * The ticket asks for more than "something logged once": the output has to come from
 * ARK-66's module rather than from a string this file prints itself. A green log
 * assertion alone cannot tell those two apart, so the case also checks that
 * `greetSymphony`'s own body contains no `console` call and that it produces output
 * indistinguishable from calling `helloSymphony()` directly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { greetSymphony } from "../../src/demo/greet-symphony.js";
import { helloSymphony } from "../../src/demo/hello-symphony.js";

function captureLog(run: () => void): unknown[][] {
  const captured: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    captured.push(args);
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return captured;
}

describe("greetSymphony (ARK-67)", () => {
  it("logs `Hello Symphony` exactly once, by delegating to helloSymphony()", () => {
    let returned: unknown;
    const captured = captureLog(() => {
      returned = greetSymphony();
    });

    assert.equal(captured.length, 1, "expected exactly one console.log call");
    assert.deepEqual(captured[0], ["Hello Symphony"]);
    assert.equal(returned, undefined, "greetSymphony() returns void");
    assert.equal(greetSymphony.length, 0, "greetSymphony() takes no arguments");

    // The string is ARK-66's to print, not this unit's.
    assert.doesNotMatch(
      greetSymphony.toString(),
      /console\./,
      "greetSymphony() must not log anything itself",
    );
    assert.deepEqual(
      captured,
      captureLog(() => {
        helloSymphony();
      }),
      "greetSymphony() must produce exactly what helloSymphony() produces",
    );
  });
});
