import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadWorkflow,
  parseFrontMatter,
  resolveWorkflowPath,
  splitFrontMatter,
} from "../loader.js";
import { isSymphonyError } from "../../domain/errors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, "../../../test/fixtures/notion.workflow.md");

describe("resolveWorkflowPath", () => {
  it("uses the explicit path when provided", () => {
    expect(resolveWorkflowPath("/abs/My.md", "/cwd")).toBe("/abs/My.md");
  });
  it("resolves a relative explicit path against cwd", () => {
    expect(resolveWorkflowPath("sub/My.md", "/cwd")).toBe("/cwd/sub/My.md");
  });
  it("defaults to ./WORKFLOW.md when no path given", () => {
    expect(resolveWorkflowPath(undefined, "/cwd")).toBe("/cwd/WORKFLOW.md");
    expect(resolveWorkflowPath("", "/cwd")).toBe("/cwd/WORKFLOW.md");
  });
});

describe("splitFrontMatter", () => {
  it("splits front matter from body", () => {
    const { frontMatterText, body } = splitFrontMatter(
      "---\nkey: val\n---\nbody line\n",
    );
    expect(frontMatterText).toBe("key: val");
    expect(body.trim()).toBe("body line");
  });
  it("returns null front matter + whole file as body when absent", () => {
    const { frontMatterText, body } = splitFrontMatter("just a prompt body");
    expect(frontMatterText).toBeNull();
    expect(body).toBe("just a prompt body");
  });
  it("throws on an unterminated front matter block", () => {
    expect(() => splitFrontMatter("---\nkey: val\nno close")).toThrowError();
  });
});

describe("parseFrontMatter", () => {
  it("parses a map", () => {
    expect(parseFrontMatter("a: 1\nb: two")).toEqual({ a: 1, b: "two" });
  });
  it("returns empty map for empty/comment-only front matter", () => {
    expect(parseFrontMatter("# just a comment")).toEqual({});
  });
  it("returns a typed error for non-map (list) front matter", () => {
    try {
      parseFrontMatter("- a\n- b");
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
      if (isSymphonyError(err)) expect(err.code).toBe("invalid_front_matter");
    }
  });
  it("returns a typed error for scalar front matter", () => {
    try {
      parseFrontMatter("just a string");
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
    }
  });
});

describe("loadWorkflow", () => {
  it("parses the Notion fixture into the expected typed config", () => {
    const wf = loadWorkflow(fixture, { TEST_NOTION_KEY: "secret-token" });
    expect(wf.service.tracker.kind).toBe("notion");
    expect(wf.service.tracker.database).toBe("db_123abc");
    expect(wf.service.tracker.api_key).toBe("secret-token");
    expect(wf.service.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(wf.service.polling.interval_ms).toBe(15000);
    expect(wf.service.agent.max_concurrent_agents).toBe(3);
    expect(wf.service.agent.max_turns).toBe(5);
    // workspace.root relative ⇒ resolved absolute relative to fixture dir.
    expect(path.isAbsolute(wf.service.workspace.root)).toBe(true);
    expect(wf.service.workspace.root).toBe(
      path.resolve(path.dirname(fixture), "ws"),
    );
    expect(wf.prompt_template).toContain("Work the issue");
  });

  it("throws missing_workflow_file for a nonexistent path", () => {
    try {
      loadWorkflow("/no/such/WORKFLOW.md");
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
      if (isSymphonyError(err)) expect(err.code).toBe("missing_workflow_file");
    }
  });

  it("absent front matter ⇒ empty config + whole file as prompt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-load-"));
    const p = path.join(dir, "WORKFLOW.md");
    fs.writeFileSync(p, "no front matter here\nsecond line\n");
    try {
      const wf = loadWorkflow(p, {});
      expect(wf.config).toEqual({});
      expect(wf.prompt_template).toBe("no front matter here\nsecond line");
      // defaults applied for empty config
      expect(wf.service.polling.interval_ms).toBe(30000);
      expect(wf.service.tracker.kind).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
