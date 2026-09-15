/**
 * Status surface specs (ARK-60 / SYM-003) — §13.4, FR19.
 *
 * Two things are under test: that the line actually reflects the set of currently
 * active runs for N = 0, 1, and many (FR19), and that the surface cannot break a
 * run — §13.4's "MUST NOT be REQUIRED for correctness" is a behavioral claim, so
 * it gets a test, not just a comment.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StatusSurface } from "../../src/domain/index.js";
import {
  createSecretRegistry,
  createStatusSurface,
  formatDuration,
  formatStatusLine,
  nullStatusSurface,
  REDACTED,
  type WritableLike,
} from "../../src/observability/index.js";

import {
  captureStream,
  frozenClock,
  orchestratorState,
  runningEntry,
} from "./helpers.js";

/** Three minutes and twelve seconds after the default `started_at`. */
const NOW = "2026-09-15T01:03:12.000Z";
const now = frozenClock(NOW);

describe("formatDuration", () => {
  it("renders each magnitude compactly", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(999), "0s");
    assert.equal(formatDuration(12_000), "12s");
    assert.equal(formatDuration(59_999), "59s");
    assert.equal(formatDuration(60_000), "1m00s");
    assert.equal(formatDuration(192_000), "3m12s");
    assert.equal(formatDuration(3_600_000), "1h00m");
    assert.equal(formatDuration(7_440_000), "2h04m");
    assert.equal(formatDuration(93_600_000), "1d02h");
  });

  it("never renders a negative span", () => {
    // Clock skew between the tracker and this host must not print "-4s".
    assert.equal(formatDuration(-5000), "0s");
  });
});

describe("formatStatusLine — reflects the active runs (FR19)", () => {
  it("shows an idle line when nothing is running", () => {
    const line = formatStatusLine(orchestratorState([]), { now });

    assert.equal(line, "○ idle · 0/10 running · poll 30s");
  });

  it("shows one active run with its state and elapsed time", () => {
    const state = orchestratorState([runningEntry({ issue_identifier: "ARK-60" })]);

    const line = formatStatusLine(state, { now });

    assert.equal(line, "● 1/10 running · ARK-60 In Progress 3m12s");
  });

  it("lists every active run, oldest first", () => {
    const state = orchestratorState([
      runningEntry({
        issue_identifier: "ARK-62",
        started_at: "2026-09-15T01:03:00.000Z",
      }),
      runningEntry({
        issue_identifier: "ARK-60",
        started_at: "2026-09-15T01:00:00.000Z",
      }),
      runningEntry({
        issue_identifier: "ARK-61",
        started_at: "2026-09-15T01:02:00.000Z",
      }),
    ]);

    const line = formatStatusLine(state, { now });

    assert.equal(
      line,
      "● 3/10 running · ARK-60 In Progress 3m12s · ARK-61 In Progress 1m12s · ARK-62 In Progress 12s",
    );
  });

  it("keeps a stable order between redraws", () => {
    // The `running` record is rebuilt each tick; insertion order must not decide
    // the layout, or an in-place line shuffles on every frame.
    const entries = [
      runningEntry({
        issue_identifier: "ARK-60",
        started_at: "2026-09-15T01:00:00.000Z",
      }),
      runningEntry({
        issue_identifier: "ARK-61",
        started_at: "2026-09-15T01:02:00.000Z",
      }),
    ];

    const forward = formatStatusLine(orchestratorState(entries), { now });
    const reversed = formatStatusLine(orchestratorState([...entries].reverse()), {
      now,
    });

    assert.equal(forward, reversed);
  });

  it("marks a retry attempt", () => {
    const state = orchestratorState([
      runningEntry({ issue_identifier: "ARK-60", attempt: 2 }),
    ]);

    assert.match(formatStatusLine(state, { now }), /ARK-60 In Progress 3m12s try2/);
  });

  it("reports the reserved-but-not-running count", () => {
    const state = orchestratorState(
      [runningEntry({ issue_identifier: "ARK-60" })],
      { claimed: new Set(["id-ark-60", "id-ark-61", "id-ark-62"]) },
    );

    assert.match(formatStatusLine(state, { now }), /· 2 queued/);
  });

  it("reports the completed count once there is one", () => {
    const state = orchestratorState([runningEntry({ issue_identifier: "ARK-60" })], {
      completed: new Set(["id-ark-58", "id-ark-59"]),
    });

    assert.match(formatStatusLine(state, { now }), /· 2 done/);
  });

  it("respects the configured concurrency limit in the summary", () => {
    const state = orchestratorState([runningEntry({ issue_identifier: "ARK-60" })], {
      max_concurrent_agents: 3,
    });

    assert.match(formatStatusLine(state, { now }), /1\/3 running/);
  });
});

describe("formatStatusLine — staying inside one line", () => {
  const five = [
    runningEntry({ issue_identifier: "ARK-60", started_at: "2026-09-15T01:00:00.000Z" }),
    runningEntry({ issue_identifier: "ARK-61", started_at: "2026-09-15T01:00:01.000Z" }),
    runningEntry({ issue_identifier: "ARK-62", started_at: "2026-09-15T01:00:02.000Z" }),
    runningEntry({ issue_identifier: "ARK-63", started_at: "2026-09-15T01:00:03.000Z" }),
    runningEntry({ issue_identifier: "ARK-64", started_at: "2026-09-15T01:00:04.000Z" }),
  ];

  it("collapses past maxEntries into a +N more tail", () => {
    const line = formatStatusLine(orchestratorState(five), { now, maxEntries: 2 });

    assert.match(line, /ARK-60/);
    assert.match(line, /ARK-61/);
    assert.equal(line.includes("ARK-62"), false);
    assert.match(line, /\+3 more/);
  });

  it("drops entries to fit a narrow terminal but keeps the summary", () => {
    const line = formatStatusLine(orchestratorState(five), { now, width: 40 });

    assert.ok(line.length <= 40, `line was ${line.length} chars: ${line}`);
    assert.match(line, /5\/10 running/, "the count must survive truncation");
    assert.match(line, /\+\d+ more/);
  });
});

describe("formatStatusLine — total on bad input (§13.4)", () => {
  it("renders without a duration when started_at is unparseable", () => {
    const state = orchestratorState([
      runningEntry({ issue_identifier: "ARK-60", started_at: "not-a-date" }),
    ]);

    assert.equal(formatStatusLine(state, { now }), "● 1/10 running · ARK-60 In Progress");
  });

  it("falls back to the issue id when the identifier is empty", () => {
    const state = orchestratorState([
      runningEntry({ issue_identifier: "", issue_id: "8058cfc4" }),
    ]);

    assert.match(formatStatusLine(state, { now }), /8058cfc4/);
  });

  it("scrubs registered secrets from the rendered line (FR21)", () => {
    const secrets = createSecretRegistry("ntn_abcdef123456");
    const state = orchestratorState([
      runningEntry({ issue_identifier: "ntn_abcdef123456" }),
    ]);

    const line = formatStatusLine(state, { now, secrets });

    assert.equal(line.includes("ntn_abcdef123456"), false);
    assert.match(line, new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  });
});

describe("TerminalStatusSurface — writing", () => {
  it("appends one line per render when piped", () => {
    const stream = captureStream({ isTTY: false });
    const surface = createStatusSurface({ stream, now });

    surface.render(orchestratorState([runningEntry({ issue_identifier: "ARK-60" })]));
    surface.render(orchestratorState([]));

    assert.equal(stream.lines().length, 2);
    assert.match(stream.lines()[0] as string, /1\/10 running/);
    assert.match(stream.lines()[1] as string, /idle/);
  });

  it("redraws one line in place on a terminal", () => {
    const stream = captureStream({ isTTY: true });
    const surface = createStatusSurface({ stream, now });

    surface.render(orchestratorState([runningEntry({ issue_identifier: "ARK-60" })]));

    const [chunk] = stream.chunks;
    assert.ok(chunk);
    assert.ok(chunk.startsWith("\r[2K"), "must clear the previous frame");
    assert.equal(chunk.endsWith("\n"), false, "in-place frames carry no newline");
  });

  it("closes the pending line on stop, once", () => {
    const stream = captureStream({ isTTY: true });
    const surface = createStatusSurface({ stream, now });

    surface.render(orchestratorState([]));
    surface.stop();
    surface.stop();

    assert.equal(stream.chunks.length, 2);
    assert.equal(stream.chunks[1], "\n");
  });

  it("writes nothing on stop when no frame is pending", () => {
    const stream = captureStream({ isTTY: true });

    createStatusSurface({ stream, now }).stop();

    assert.deepEqual(stream.chunks, []);
  });

  it("ignores renders after stop", () => {
    const stream = captureStream({ isTTY: false });
    const surface = createStatusSurface({ stream, now });

    surface.stop();
    surface.render(orchestratorState([]));

    assert.deepEqual(stream.chunks, []);
  });

  it("takes its width from the stream", () => {
    const stream = captureStream({ isTTY: false, columns: 40 });
    const surface = createStatusSurface({ stream, now });

    surface.render(
      orchestratorState([
        runningEntry({ issue_identifier: "ARK-60", started_at: "2026-09-15T01:00:00.000Z" }),
        runningEntry({ issue_identifier: "ARK-61", started_at: "2026-09-15T01:00:01.000Z" }),
        runningEntry({ issue_identifier: "ARK-62", started_at: "2026-09-15T01:00:02.000Z" }),
      ]),
    );

    const [line] = stream.lines();
    assert.ok(line);
    assert.ok(line.length <= 40, `line was ${line.length} chars: ${line}`);
  });
});

describe("TerminalStatusSurface — never load-bearing (§13.4)", () => {
  it("does not throw when the stream fails", () => {
    const broken: WritableLike = {
      write() {
        throw new Error("EPIPE: broken pipe");
      },
    };
    const surface = createStatusSurface({ stream: broken, now });

    assert.doesNotThrow(() => surface.render(orchestratorState([])));
    assert.doesNotThrow(() => surface.stop());
  });

  it("does not throw when the stream fails only on shutdown", () => {
    let writes = 0;
    const flaky: WritableLike = {
      isTTY: true,
      write() {
        writes += 1;
        if (writes > 1) throw new Error("terminal went away");
        return true;
      },
    };
    const surface = createStatusSurface({ stream: flaky, now });

    surface.render(orchestratorState([]));

    assert.doesNotThrow(() => surface.stop());
  });

  it("keeps rendering after a transient stream failure", () => {
    let writes = 0;
    const captured: string[] = [];
    const flaky: WritableLike = {
      write(chunk: string) {
        writes += 1;
        if (writes === 1) throw new Error("transient");
        captured.push(chunk);
        return true;
      },
    };
    const surface = createStatusSurface({ stream: flaky, now });

    surface.render(orchestratorState([]));
    surface.render(orchestratorState([runningEntry({ issue_identifier: "ARK-60" })]));

    assert.equal(captured.length, 1);
    assert.match(captured[0] as string, /1\/10 running/);
  });
});

describe("nullStatusSurface", () => {
  it("satisfies the port and renders nothing", () => {
    const surface: StatusSurface = nullStatusSurface();

    assert.doesNotThrow(() => {
      surface.render(orchestratorState([]));
      surface.stop();
    });
  });
});
