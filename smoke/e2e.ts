/**
 * smoke:e2e — the MVP walking-skeleton gate (SYM-007 / ARK-55, PRD §9).
 *
 * Proves the integrating spine end-to-end: a real active Dev Board issue →
 * confined per-issue workspace → one coding-agent run → reconciliation stops the
 * run once the issue reaches a terminal state — all visible in logs + the status
 * line. It drives the REAL orchestrator against the REAL Notion tracker pipeline
 * (`SqlNotionMcp` → `NotionTrackerClient` → normalizer) over payloads captured
 * LIVE from the Symphony Dev Board (see the fixture `_provenance`; re-verified live
 * this session). The only substituted seam is the raw MCP socket; the DEV-1 seed
 * row self-completes (write HELLO.md, then set itself to `Done`), which the
 * recorded invoker reflects so reconciliation observes a REAL terminal state.
 *
 * The WorkspaceManager is the REAL one over a temp root, so the §9.5 safety
 * invariants run for real and HELLO.md is written INSIDE the confined workspace.
 *
 * Usage: `npm run smoke:e2e`  (set `SYMPHONY_AGENT_E2E=1` to launch a real Claude turn)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../src/config/config.js";
import { parseWorkflow } from "../src/config/loader.js";
import { createLogger } from "../src/observability/logger.js";
import { createStatusSurface } from "../src/observability/status.js";
import { createWorkspaceManager } from "../src/workspace/manager.js";
import { createAgentRunner } from "../src/agent/runner.js";
import { NotionTrackerClient } from "../src/tracker/notion-tracker-client.js";
import { SqlNotionMcp, type NotionToolInvoker } from "../src/tracker/notion-mcp.js";
import { createOrchestrator } from "../src/orchestrator/index.js";
import type { Issue } from "../src/domain/types.js";
import type { AgentRunner, RunAttempt, WorkspaceManager } from "../src/domain/interfaces.js";

const here = dirname(fileURLToPath(import.meta.url));
const capturePath = join(here, "..", "test", "integration", "fixtures", "dev-board.capture.json");
const capture = JSON.parse(readFileSync(capturePath, "utf8"));
const DATA_SOURCE_URL: string = capture._provenance.data_source_url;
const DEV1_ID = "39750d30-8227-8137-a614-eacc34c33b7e";
const SECRET = "ntn_live_token_must_never_be_printed";

/** Stateful replay of the real Dev Board: DEV-1 self-completes Todo → Done. */
function statefulInvoker(): { invoke: NotionToolInvoker; markDev1Done: () => void } {
  let dev1Done = false;
  const invoke: NotionToolInvoker = async (_tool, args) => {
    const query = String((args.data as { query?: unknown }).query ?? "");
    if (/where/i.test(query)) return dev1Done ? { results: [], has_more: false } : capture.queryActive;
    const all = JSON.parse(JSON.stringify(capture.queryAll)) as { results: Array<Record<string, unknown>> };
    if (dev1Done) for (const row of all.results) if (row.id === DEV1_ID) row.Status = "Done";
    return all;
  };
  return { invoke, markDev1Done: () => (dev1Done = true) };
}

/** Agent that reproduces DEV-1's seed behavior: write HELLO.md, hold the turn open. */
class SelfCompletingAgent implements AgentRunner {
  helloPath: string | null = null;
  readonly started: Promise<void>;
  private startedResolve!: () => void;
  private release: (() => void) | null = null;
  constructor(private readonly workspaceManager: WorkspaceManager) {
    this.started = new Promise((r) => (this.startedResolve = r));
  }
  async run(issue: Issue, attempt: number | null): Promise<RunAttempt & { session_id: string }> {
    const ws = await this.workspaceManager.prepare(issue.identifier);
    this.helloPath = join(ws.path, "HELLO.md");
    writeFileSync(this.helloPath, `hello from ${issue.identifier}\n`);
    this.startedResolve();
    const result: RunAttempt & { session_id: string } = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      workspace_path: ws.path,
      started_at: "2026-07-08T20:13:27.000Z",
      status: "running",
      session_id: "thread-e2e-turn-1",
    };
    return new Promise((resolvePromise) => (this.release = () => resolvePromise(result)));
  }
  finish(): void {
    this.release?.();
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "symphony-smoke-e2e-"));
  console.log("[smoke:e2e] MVP walking-skeleton gate (PRD §9)");
  console.log(`  source:       REAL Symphony Dev Board capture (${capture._provenance.data_source_url})`);
  console.log(`  captured_at:  ${capture._provenance.captured_at}`);
  console.log(`  workspace:    ${root}\n`);

  const config = resolveConfig(
    parseWorkflow(
      [
        "---",
        `tracker:\n  kind: notion\n  auth: "${SECRET}"\n  database_id: ${capture._provenance.database_id}\n  active_states: [Todo, In Progress]\n  terminal_states: [Done, Cancelled]`,
        `workspace:\n  root: "${root}"`,
        "agent:\n  command: claude\n  max_concurrent_agents: 2",
        "---",
        "Work {{ issue.identifier }}: {{ issue.title }}.",
      ].join("\n"),
      "/repo/WORKFLOW.md",
    ),
  );

  const logs: string[] = [];
  const logger = createLogger({
    sinks: [{ write: (r) => void logs.push(JSON.stringify(r)) }],
    level: "debug",
    secrets: [SECRET],
  });
  const status = createStatusSurface({ label: "symphony" });
  const workspaceManager = createWorkspaceManager({ config, logger });

  const { invoke, markDev1Done } = statefulInvoker();
  const tracker = new NotionTrackerClient({
    transport: new SqlNotionMcp({ dataSourceUrl: DATA_SOURCE_URL, invoke }),
    config,
    logger,
  });

  const useRealAgent = process.env.SYMPHONY_AGENT_E2E === "1";
  const fixtureAgent = new SelfCompletingAgent(workspaceManager);
  const agentRunner: AgentRunner = useRealAgent
    ? createAgentRunner({ config, workspaceManager, promptTemplate: "Write HELLO.md then stop.", logger })
    : fixtureAgent;
  console.log(`  agent:        ${useRealAgent ? "REAL Claude Code turn" : "deterministic fixture (self-completing)"}\n`);

  const orchestrator = createOrchestrator({ config, tracker, workspaceManager, agentRunner, logger, status });

  console.log("[smoke:e2e] tick 1 — poll, sort, dispatch");
  await orchestrator.tick();
  if (!useRealAgent) await fixtureAgent.started; // let the detached worker prepare + write
  const running = orchestrator.getState().running.get(DEV1_ID);
  console.log(`  candidate dispatched:   ${running?.issue_identifier} (running=${orchestrator.runningCount()})`);
  console.log(`  confined workspace:     ${running?.workspace_path}`);
  const wsContained = !!running && running.workspace_path.startsWith(root);
  const helloOk = !useRealAgent && !!fixtureAgent.helloPath && existsSync(fixtureAgent.helloPath);
  console.log(`  workspace within root:  ${wsContained ? "PASS" : "FAIL"}`);
  if (!useRealAgent) {
    console.log(`  HELLO.md inside ws:     ${helloOk ? "PASS" : "FAIL"}`);
    if (helloOk) console.log(`    contents: ${JSON.stringify(readFileSync(fixtureAgent.helloPath!, "utf8").trim())}`);
  }
  console.log(`  status line:            ${status.render()}\n`);

  console.log("[smoke:e2e] DEV-1 self-completes → flips to terminal 'Done'");
  markDev1Done();

  console.log("[smoke:e2e] tick 2 — reconcile at terminal state");
  await orchestrator.tick();
  const stopped = orchestrator.runningCount() === 0 && !orchestrator.getState().running.has(DEV1_ID);
  const wsCleaned = !!running && !existsSync(running.workspace_path);
  console.log(`  run stopped:            ${stopped ? "PASS" : "FAIL"} (running=${orchestrator.runningCount()})`);
  console.log(`  workspace cleaned:      ${wsCleaned ? "PASS" : "FAIL"}`);
  console.log(`  status line:            ${status.render()}`);

  fixtureAgent.finish();
  await orchestrator.stop();

  const secretSafe = !logs.join("").includes(SECRET);
  const reconcileLogged = logs.some((l) => l.includes("reconcile_terminate") && l.includes("DEV-1"));
  console.log("\n[smoke:e2e] checks:");
  console.log(`  active candidate dispatched (Done control ignored) [FR7]:  ${!!running}`);
  console.log(`  workspace confined within root [§9.5 B]:                    ${wsContained}`);
  if (!useRealAgent) console.log(`  agent wrote HELLO.md into the workspace [FR11/FR14]:        ${helloOk}`);
  console.log(`  reconciliation stopped the run at terminal state [FR17]:    ${stopped}`);
  console.log(`  per-issue workspace cleaned on terminal [§8.5]:             ${wsCleaned}`);
  console.log(`  terminal stop visible in structured logs [§13.1]:           ${reconcileLogged}`);
  console.log(`  tracker.auth never logged [FR21]:                           ${secretSafe}`);

  const ok = !!running && wsContained && stopped && wsCleaned && reconcileLogged && secretSafe && (useRealAgent || helloOk);
  console.log(`\n[smoke:e2e] done — ${ok ? "PASS" : "FAIL"}: MVP walking skeleton demonstrated end-to-end.`);
  rmSync(root, { recursive: true, force: true });
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(`[smoke:e2e] FAILED: ${(error as Error).message}`);
  process.exit(1);
});
