import assert from "node:assert/strict";
import { test } from "node:test";
import { createStatusSurface } from "../../src/observability/status.js";

function captureStream() {
  const chunks: string[] = [];
  return { chunks, write: (c: string) => void chunks.push(c) };
}

test("status line reflects N active runs [FR19]", () => {
  const status = createStatusSurface({ label: "symphony" });
  assert.equal(status.render(), "[symphony] 0 active");

  status.upsert({ issue_identifier: "ARK-51", phase: "running" });
  status.upsert({ issue_identifier: "ARK-52", session_id: "sess_2", phase: "running" });
  status.upsert({ issue_identifier: "ARK-53" });

  const line = status.render();
  assert.match(line, /^\[symphony\] 3 active: /);
  assert.match(line, /ARK-51 \(running\)/);
  assert.match(line, /ARK-52:sess_2 \(running\)/);
  assert.match(line, /ARK-53/);
  assert.equal(status.activeRuns().length, 3);
});

test("upsert replaces a run in place, preserving insertion order", () => {
  const status = createStatusSurface();
  status.upsert({ issue_identifier: "ARK-51", phase: "running" });
  status.upsert({ issue_identifier: "ARK-52", phase: "running" });
  status.upsert({ issue_identifier: "ARK-51", phase: "retrying" });

  const ids = status.activeRuns().map((r) => r.issue_identifier);
  assert.deepEqual(ids, ["ARK-51", "ARK-52"]);
  assert.equal(status.activeRuns()[0]!.phase, "retrying");
});

test("remove drops a run; removing an absent run is a no-op", () => {
  const status = createStatusSurface();
  status.upsert({ issue_identifier: "ARK-51" });
  status.upsert({ issue_identifier: "ARK-52" });
  status.remove("ARK-51");
  status.remove("does-not-exist");
  assert.deepEqual(
    status.activeRuns().map((r) => r.issue_identifier),
    ["ARK-52"],
  );
});

test("print writes the status line to the stream", () => {
  const stream = captureStream();
  const status = createStatusSurface({ stream, label: "s" });
  status.upsert({ issue_identifier: "ARK-51", phase: "running" });
  status.print();
  assert.equal(stream.chunks.length, 1);
  assert.equal(stream.chunks[0]!, "[s] 1 active: ARK-51 (running)\n");
});

test("a failing status stream never throws into the caller (§13.4)", () => {
  const boom = {
    write() {
      throw new Error("tty closed");
    },
  };
  const status = createStatusSurface({ stream: boom });
  status.upsert({ issue_identifier: "ARK-51" });
  assert.doesNotThrow(() => status.print());
});
