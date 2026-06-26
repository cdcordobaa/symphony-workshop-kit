import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { buildServiceConfig } from "../typed-config.js";
import { isSymphonyError } from "../../domain/errors.js";

describe("buildServiceConfig defaults", () => {
  it("applies all defaults for an empty config map", () => {
    const cfg = buildServiceConfig({}, "/base", {});
    expect(cfg.tracker.kind).toBe("");
    expect(cfg.tracker.database).toBeNull();
    expect(cfg.tracker.api_key).toBeNull();
    expect(cfg.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(cfg.tracker.terminal_states).toContain("Done");
    expect(cfg.polling.interval_ms).toBe(30000);
    expect(cfg.hooks.timeout_ms).toBe(60000);
    expect(cfg.agent.max_concurrent_agents).toBe(10);
    expect(cfg.agent.max_turns).toBe(20);
    expect(cfg.agent.max_retry_backoff_ms).toBe(300000);
    expect(cfg.agent.command.length).toBeGreaterThan(0);
    // default workspace root under system temp
    expect(cfg.workspace.root).toBe(
      path.join(os.tmpdir(), "symphony_workspaces"),
    );
  });
});

describe("buildServiceConfig resolution", () => {
  it("resolves $VAR only where referenced and respects path resolution", () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: "notion", database: "db1", api_key: "$NK" },
        workspace: { root: "~/sym" },
      },
      "/base",
      { NK: "tok-123" },
    );
    expect(cfg.tracker.api_key).toBe("tok-123");
    expect(cfg.workspace.root).toBe(path.join(os.homedir(), "sym"));
  });

  it("treats an unresolved $VAR api_key as empty (⇒ missing)", () => {
    const cfg = buildServiceConfig(
      { tracker: { kind: "notion", api_key: "$NOPE" } },
      "/base",
      {},
    );
    expect(cfg.tracker.api_key).toBe("");
  });

  it("ignores unknown top-level keys (forward-compat)", () => {
    const cfg = buildServiceConfig(
      { tracker: { kind: "notion" }, future_extension: { x: 1 } },
      "/base",
      {},
    );
    expect(cfg.tracker.kind).toBe("notion");
  });

  it("normalizes per-state concurrency keys and drops invalid entries", () => {
    const cfg = buildServiceConfig(
      {
        agent: {
          max_concurrent_agents_by_state: {
            "In Progress": 3,
            Todo: 0,
            Bad: "x",
          },
        },
      },
      "/base",
      {},
    );
    expect(cfg.agent.max_concurrent_agents_by_state).toEqual({
      "in progress": 3,
    });
  });

  it("throws invalid_config for a non-positive interval", () => {
    try {
      buildServiceConfig({ polling: { interval_ms: 0 } }, "/base", {});
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
      if (isSymphonyError(err)) expect(err.code).toBe("invalid_config");
    }
  });

  it("throws invalid_config for a non-integer hook timeout", () => {
    expect(() =>
      buildServiceConfig({ hooks: { timeout_ms: 1.5 } }, "/base", {}),
    ).toThrowError();
  });
});
