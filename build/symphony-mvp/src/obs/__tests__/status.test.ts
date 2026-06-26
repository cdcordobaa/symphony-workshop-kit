import { describe, expect, it } from "vitest";
import { createRuntimeState, type RunningEntry } from "../../domain/state.js";
import { renderStatus } from "../status.js";

function runningEntry(over: Partial<RunningEntry> = {}): RunningEntry {
  return {
    issue_id: "id-1",
    issue_identifier: "SYM-1",
    attempt: null,
    workspace_path: "/ws/SYM-1",
    started_at: "2026-06-02T11:59:00.000Z",
    session_id: "thread-1-turn-1",
    turn_count: 1,
    last_state: "in_progress",
    ...over,
  };
}

describe("renderStatus (§13.4, FR-OB-4)", () => {
  it("renders a readable summary purely from passed-in state", () => {
    const state = createRuntimeState(15000, 4);
    state.running.set("id-1", runningEntry());
    state.running.set(
      "id-2",
      runningEntry({
        issue_id: "id-2",
        issue_identifier: "SYM-2",
        attempt: 2,
        session_id: null,
        turn_count: 0,
        last_state: null,
      }),
    );
    state.claimed.add("id-1");
    state.claimed.add("id-2");
    state.completed.add("id-old");

    const out = renderStatus(state, { now: "2026-06-02T12:00:00.000Z" });

    expect(out).toMatchInlineSnapshot(`
      "Symphony status @ 2026-06-02T12:00:00.000Z
      running=2 claimed=2 completed=1 slots=2/4 interval_ms=15000
        - SYM-1 (id=id-1) state=in_progress attempt=1 turns=1 session=thread-1-turn-1 started_at=2026-06-02T11:59:00.000Z
        - SYM-2 (id=id-2) state=- attempt=2 turns=0 session=- started_at=2026-06-02T11:59:00.000Z"
    `);
  });

  it("reports no running agents when idle", () => {
    const state = createRuntimeState(30000, 2);
    const out = renderStatus(state);
    expect(out).toContain("Symphony status");
    expect(out).toContain("running=0 claimed=0 completed=0 slots=0/2 interval_ms=30000");
    expect(out).toContain("(no running agents)");
  });

  it("caps listed rows and summarizes the remainder", () => {
    const state = createRuntimeState(10000, 50);
    for (let i = 0; i < 5; i++) {
      state.running.set(
        `id-${i}`,
        runningEntry({ issue_id: `id-${i}`, issue_identifier: `SYM-${i}` }),
      );
    }
    const out = renderStatus(state, { maxRows: 2 });
    const rows = out.split("\n").filter((l) => l.startsWith("  - "));
    expect(rows).toHaveLength(2);
    expect(out).toContain("…and 3 more");
  });

  it("does not mutate the passed-in state", () => {
    const state = createRuntimeState(15000, 4);
    state.running.set("id-1", runningEntry());
    renderStatus(state);
    expect(state.running.size).toBe(1);
    expect(state.claimed.size).toBe(0);
  });
});
