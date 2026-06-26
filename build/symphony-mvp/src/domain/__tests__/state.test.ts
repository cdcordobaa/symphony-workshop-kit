import { describe, expect, it } from "vitest";
import { createRuntimeState } from "../state.js";

describe("createRuntimeState", () => {
  it("seeds an empty authoritative state from effective config", () => {
    const s = createRuntimeState(15000, 4);
    expect(s.poll_interval_ms).toBe(15000);
    expect(s.max_concurrent_agents).toBe(4);
    expect(s.running.size).toBe(0);
    expect(s.claimed.size).toBe(0);
    expect(s.retry_attempts.size).toBe(0);
    expect(s.completed.size).toBe(0);
    expect(s.agent_totals.total_tokens).toBe(0);
    expect(s.rate_limits).toBeNull();
  });
});
