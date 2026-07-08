/**
 * REAL Claude Code integration test (SYM-006 / ARK-54 DoD).
 *
 * The BUILD-CONTRACT requires SYM-006 to prove itself against a REAL Claude Code
 * turn — a mock-only pass is not acceptable. This test drives the production
 * `createAgentRunner` (default `child_process.spawn`, no stub) to launch a real
 * `claude` headless turn in a confined temp workspace and asserts the runner's
 * contract holds against the live event stream:
 *   - the turn maps to `succeeded` (FR16);
 *   - `session_id` is derived as a real `"<thread_id>-<turn_id>"` (FR16);
 *   - the agent runs cwd-confined in the per-issue workspace and the high-trust
 *     posture auto-approves the Write, so HELLO.md lands INSIDE the workspace
 *     (FR11/FR14, §10.5) — evidence the launch cwd == workspace path.
 *
 * It is gated behind `SYMPHONY_AGENT_E2E=1` so the default hermetic `npm test`
 * (and CI without `claude` auth) does not spend money / require the CLI. Run it
 * with:  `SYMPHONY_AGENT_E2E=1 npm test`  (or `... npm run test:integration`).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Issue, ServiceConfig } from "../../src/domain/types.js";
import { createLogger } from "../../src/observability/logger.js";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
import { createAgentRunner } from "../../src/agent/runner.js";

const RUN_E2E = process.env.SYMPHONY_AGENT_E2E === "1";

function e2eIssue(): Issue {
  return {
    id: "e2e-issue-1",
    identifier: "E2E-1",
    title: "Agent runner e2e",
    description: null,
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
}

test(
  "[real-claude] one headless turn succeeds, is cwd-confined, and derives session_id [FR11/FR14/FR16]",
  { skip: RUN_E2E ? false : "set SYMPHONY_AGENT_E2E=1 to run the real Claude Code turn" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-e2e-agent-"));
    const config = {
      agent: { command: "claude", turn_timeout_ms: 180_000 },
      workspace: { root },
    } as ServiceConfig;
    const logger = createLogger({ sinks: [{ write() {} }] });
    const workspaceManager = createWorkspaceManager({ config, logger });
    const issue = e2eIssue();

    const promptTemplate = [
      "Work on {{ issue.identifier }}: {{ issue.title }}.",
      "Create a file named HELLO.md in the current directory containing exactly:",
      "hello from {{ issue.identifier }}",
      "Then stop.",
    ].join("\n");

    const runner = createAgentRunner({ config, workspaceManager, promptTemplate, logger });
    const result = await runner.run(issue, null);

    assert.equal(result.status, "succeeded", `expected success, got ${result.error ?? result.status}`);

    // session_id = "<thread_id>-<turn_id>" derived from the REAL stream (FR16).
    assert.match(result.session_id, /^.+-.+$/);
    assert.ok(!result.session_id.startsWith("unknown-"), "thread id was extracted from the stream");
    assert.ok(!result.session_id.endsWith("-0"), "turn id was extracted from the stream");

    // cwd confinement + high-trust auto-approve: the file must be INSIDE the workspace.
    const wsPath = workspaceManager.workspacePathFor(issue.identifier);
    assert.equal(result.workspace_path, wsPath);
    const helloPath = join(wsPath, "HELLO.md");
    assert.ok(existsSync(helloPath), "the agent wrote HELLO.md into the confined workspace");
    assert.match(readFileSync(helloPath, "utf8"), /hello from E2E-1/);
  },
);
