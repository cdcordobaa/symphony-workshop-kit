import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boot, main } from "../index.js";
import { isSymphonyError } from "../domain/errors.js";

function writeWorkflow(content: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-boot-"));
  const file = path.join(dir, "WORKFLOW.md");
  fs.writeFileSync(file, content);
  return { dir, file };
}

const validWorkflow = `---
tracker:
  kind: notion
  database: db1
  api_key: $BOOT_KEY
agent:
  command: claude --print
---
Work {{ issue.identifier }}.
`;

describe("boot", () => {
  it("loads a valid workflow and seeds runtime state", () => {
    const { dir } = writeWorkflow(validWorkflow);
    try {
      const res = boot([], { cwd: dir, env: { BOOT_KEY: "tok" } });
      expect(res.workflow.service.tracker.kind).toBe("notion");
      expect(res.state.poll_interval_ms).toBe(30000);
      expect(res.state.max_concurrent_agents).toBe(10);
      expect(res.state.running.size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors on a nonexistent explicit path", () => {
    try {
      boot(["/no/such/file.md"], { cwd: "/tmp", env: {} });
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
      if (isSymphonyError(err)) expect(err.code).toBe("missing_workflow_file");
    }
  });

  it("errors on missing default ./WORKFLOW.md", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sym-empty-"));
    try {
      boot([], { cwd: empty, env: {} });
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
      if (isSymphonyError(err)) expect(err.code).toBe("missing_workflow_file");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fails preflight when auth is unresolved", () => {
    const { dir } = writeWorkflow(validWorkflow);
    try {
      // BOOT_KEY not provided ⇒ api_key empty ⇒ preflight fails
      boot([], { cwd: dir, env: {} });
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
      if (isSymphonyError(err)) expect(err.code).toBe("preflight_failed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main exit codes", () => {
  it("returns 1 when startup fails (missing default)", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sym-empty2-"));
    const oldCwd = process.cwd();
    try {
      process.chdir(empty);
      expect(main([])).toBe(1);
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
