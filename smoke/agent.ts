/**
 * smoke:agent — evidence that the Agent Runner (SYM-006 / ARK-54) does its real
 * job (§10, §12):
 *   1. renders a strict `issue` + `attempt` prompt (FR15);
 *   2. launches a REAL Claude Code headless turn via `bash -lc`, cwd == the
 *      per-issue workspace path, re-checking safety invariant A (FR11/FR14);
 *   3. runs exactly one turn under the high-trust posture (auto-approve), so the
 *      agent can write a file INTO the confined workspace (FR14/D5, §10.5);
 *   4. maps the result to success and derives `session_id = "<thread_id>-<turn_id>"`
 *      (FR16), forwarded to the structured logs.
 *
 * Usage: `tsx smoke/agent.ts`  (requires the `claude` CLI on PATH + auth)
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue, ServiceConfig } from "../src/domain/types.js";
import { createLogger } from "../src/observability/logger.js";
import { createWorkspaceManager } from "../src/workspace/manager.js";
import { createAgentRunner } from "../src/agent/runner.js";

/** A minimal normalized issue for the smoke run. */
function smokeIssue(): Issue {
  return {
    id: "smoke-issue-1",
    identifier: "SMOKE-1",
    title: "Agent runner smoke",
    description: "Write HELLO.md as a trivial one-turn task.",
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

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "symphony-smoke-agent-"));
  const config = {
    agent: { command: "claude", turn_timeout_ms: 180_000 },
    workspace: { root },
  } as ServiceConfig;

  const logger = createLogger({ format: "text" });
  const workspaceManager = createWorkspaceManager({ config, logger });
  const issue = smokeIssue();

  // A strict template that binds issue + attempt and directs a trivial, verifiable turn.
  const promptTemplate = [
    "You are working on issue {{ issue.identifier }}: {{ issue.title }}.",
    "{% if attempt %}This is retry #{{ attempt }}.{% else %}This is the first attempt.{% endif %}",
    "Create a file named HELLO.md in the current directory whose only contents are the line:",
    "hello from {{ issue.identifier }}",
    "Then stop. Do not do anything else.",
  ].join("\n");

  const runner = createAgentRunner({ config, workspaceManager, promptTemplate, logger });

  console.log("[smoke:agent] launching a REAL Claude Code turn (this costs a few cents)...\n");
  const result = await runner.run(issue, null);

  const wsPath = workspaceManager.workspacePathFor(issue.identifier);
  const helloPath = join(wsPath, "HELLO.md");
  const fileWritten = existsSync(helloPath);

  console.log(`  workspace:    ${wsPath}`);
  console.log(`  cwd == ws:    ${result.workspace_path === wsPath ? "PASS" : "FAIL"}`);
  console.log(`  status:       ${result.status}`);
  console.log(`  session_id:   ${result.session_id}`);
  const sessionOk = /^.+-.+$/.test(result.session_id) && !result.session_id.startsWith("unknown-");
  console.log(`  session shape "<thread>-<turn>": ${sessionOk ? "PASS" : "FAIL"}`);
  console.log(`  HELLO.md written into workspace:  ${fileWritten ? "PASS" : "FAIL"}`);
  if (fileWritten) console.log(`    contents: ${JSON.stringify(readFileSync(helloPath, "utf8").trim())}`);

  const ok = result.status === "succeeded" && sessionOk && result.workspace_path === wsPath;
  console.log(
    `\n[smoke:agent] done — ${ok ? "PASS" : "FAIL"}: strict prompt + real one-turn launch, cwd-confined, session_id derived.`,
  );
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(`[smoke:agent] FAILED: ${(error as Error).message}`);
  process.exit(1);
});
