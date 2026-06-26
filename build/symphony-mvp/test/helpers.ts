import type { Issue } from "../src/domain/issue.js";

/** A fully-populated normalized issue for renderer/preflight tests. */
export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue_1",
    identifier: "SYM-1",
    title: "Bootstrap the orchestrator",
    description: "Stand up the foundation layer.",
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: "https://example.com/sym-1",
    labels: ["backend", "mvp"],
    blocked_by: [{ id: "issue_0", identifier: "SYM-0", state: "Done" }],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}
