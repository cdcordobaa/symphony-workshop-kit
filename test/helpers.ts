import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue } from "../src/domain/types.js";

/** Create a throwaway temp directory under the OS temp root. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "symphony-test-"));
}

/** Write `content` to `WORKFLOW.md` in a fresh temp dir; return the file path. */
export function writeWorkflow(content: string, filename = "WORKFLOW.md"): string {
  const dir = tempDir();
  const path = join(dir, filename);
  writeFileSync(path, content, "utf8");
  return path;
}

/** A fully-populated normalized issue for renderer/CLI tests. */
export function sampleIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-uuid-1",
    identifier: "ABC-123",
    title: "Implement the thing",
    description: "Do the work described here.",
    priority: 2,
    state: "Todo",
    branch_name: "abc/abc-123-implement-the-thing",
    url: "https://example.com/issue/ABC-123",
    labels: ["backend", "mvp"],
    blocked_by: [{ id: "issue-uuid-0", identifier: "ABC-100", state: "In Progress" }],
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}
