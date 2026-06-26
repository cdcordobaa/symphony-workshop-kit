import { describe, expect, it } from "vitest";
import { buildServiceConfig } from "../typed-config.js";
import {
  assertDispatchConfig,
  checkDispatchConfig,
} from "../preflight.js";
import type { WorkflowDefinition } from "../../domain/config.js";
import { isSymphonyError } from "../../domain/errors.js";

function cfg(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
  return buildServiceConfig(raw, "/base", env);
}

const validRaw = {
  tracker: { kind: "notion", database: "db1", api_key: "$NK" },
  agent: { command: "claude --print" },
};

describe("checkDispatchConfig", () => {
  it("passes for a complete valid Notion config", () => {
    const r = checkDispatchConfig(cfg(validRaw, { NK: "tok" }));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("fails when tracker.kind is missing", () => {
    const r = checkDispatchConfig(
      cfg({ tracker: { database: "db1", api_key: "x" } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("tracker.kind");
  });

  it("fails when tracker.kind is unsupported", () => {
    const r = checkDispatchConfig(
      cfg({ tracker: { kind: "linear", database: "db1", api_key: "x" } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("not supported");
  });

  it("fails when Notion auth is empty after $ resolution", () => {
    const r = checkDispatchConfig(cfg(validRaw, {})); // $NK unresolved ⇒ ""
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("api_key");
  });

  it("fails when the Notion database id is missing", () => {
    const r = checkDispatchConfig(
      cfg({ tracker: { kind: "notion", api_key: "x" } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("database");
  });

  it("fails when agent.command is missing", () => {
    // command "" falls back to default in typed-config, so simulate via direct config object
    const c = cfg({ tracker: { kind: "notion", database: "db", api_key: "x" } });
    c.agent.command = "   ";
    const r = checkDispatchConfig(c);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("agent.command");
  });
});

describe("assertDispatchConfig", () => {
  it("throws preflight_failed listing every failed check", () => {
    const wf: WorkflowDefinition = {
      config: {},
      prompt_template: "",
      service: cfg({ tracker: { kind: "linear" } }),
      source_path: "/base/WORKFLOW.md",
    };
    try {
      assertDispatchConfig(wf);
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
      if (isSymphonyError(err)) {
        expect(err.code).toBe("preflight_failed");
        expect(err.details.length).toBeGreaterThan(0);
      }
    }
  });

  it("does not throw for a valid workflow", () => {
    const wf: WorkflowDefinition = {
      config: validRaw,
      prompt_template: "x",
      service: cfg(validRaw, { NK: "tok" }),
      source_path: "/base/WORKFLOW.md",
    };
    expect(() => assertDispatchConfig(wf)).not.toThrow();
  });
});
