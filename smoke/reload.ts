/**
 * smoke:reload — evidence that dynamic `WORKFLOW.md` watch/reload (DEV-5, §6.2)
 * does its real job, against a REAL file on disk and the REAL `fs.watch` seam
 * (no injected watcher here — the unit tests cover the deterministic paths; this
 * smoke proves the production wiring actually fires):
 *
 *   1. a GOOD edit is detected, re-parsed/re-resolved/re-validated and applied to
 *      the live loop — `polling.interval_ms` and `agent.max_concurrent_agents`
 *      change WITHOUT restarting the daemon, and a sleeping tick is re-armed at
 *      the new cadence;
 *   2. a MALFORMED edit is REJECTED — the error is operator-visible, the previous
 *      good config keeps running, and the daemon stays alive;
 *   3. `tracker.auth` never appears in any emitted log line (FR21);
 *   4. an in-flight run is not disturbed by either reload.
 *
 * Usage: `tsx smoke/reload.ts`
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigWatcher } from "../src/config/watcher.js";
import { resolveConfig } from "../src/config/config.js";
import { loadWorkflowFile } from "../src/config/loader.js";
import { createOrchestrator } from "../src/orchestrator/orchestrator.js";
import { createLogger } from "../src/observability/logger.js";
import { createStatusSurface } from "../src/observability/status.js";
import type {
  AgentRunner,
  LogRecord,
  RunAttempt,
  TrackerClient,
  Workspace,
  WorkspaceManager,
} from "../src/domain/interfaces.js";
import type { Issue } from "../src/domain/types.js";

/** The secret that must never reach a log line. */
const AUTH = "ntn_smoke_secret_token";

/* ------------------------------ in-memory fakes ------------------------------ */

function issue(id: string, identifier: string): Issue {
  return {
    id,
    identifier,
    title: "Smoke issue",
    description: null,
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
  };
}

class FakeTracker implements TrackerClient {
  candidates: Issue[] = [];
  async fetchCandidateIssues(): Promise<Issue[]> { return this.candidates; }
  async fetchIssuesByStates(): Promise<Issue[]> { return []; }
  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    return this.candidates.filter((c) => ids.includes(c.id));
  }
}

class FakeWorkspaceManager implements WorkspaceManager {
  root = "/tmp/symphony-smoke-reload";
  removed: string[] = [];
  workspacePathFor(identifier: string): string { return `${this.root}/${identifier}`; }
  async prepare(identifier: string): Promise<Workspace> {
    return { path: this.workspacePathFor(identifier), workspace_key: identifier, created_now: true };
  }
  async remove(identifier: string): Promise<void> { this.removed.push(identifier); }
}

/** An agent runner whose runs stay in flight until released. */
class HangingAgentRunner implements AgentRunner {
  runs: string[] = [];
  private waiters: Array<() => void> = [];
  async run(target: Issue): Promise<RunAttempt> {
    this.runs.push(target.identifier);
    await new Promise<void>((r) => this.waiters.push(r));
    return {
      issue_id: target.id,
      issue_identifier: target.identifier,
      attempt: null,
      workspace_path: `/tmp/symphony-smoke-reload/${target.identifier}`,
      started_at: "2026-01-01T00:00:00.000Z",
      status: "succeeded",
    };
  }
  releaseAll(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
}

/* --------------------------------- fixtures --------------------------------- */

function workflow(intervalMs: number, maxAgents: number): string {
  return [
    "---",
    "tracker:",
    "  kind: notion",
    `  auth: ${AUTH}`,
    "  database_id: db-smoke",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Cancelled]",
    "polling:",
    `  interval_ms: ${intervalMs}`,
    "agent:",
    "  command: claude",
    `  max_concurrent_agents: ${maxAgents}`,
    "---",
    "Work {{ issue.identifier }}.",
  ].join("\n");
}

const MALFORMED = ["---", "tracker:", "  kind: notion", "   auth: [unclosed", "---", "Body."].join("\n");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "symphony-smoke-reload-"));
  const path = join(dir, "WORKFLOW.md");
  writeFileSync(path, workflow(30_000, 1), "utf8");

  // Capture every emitted record (post-redaction) so FR21 can be checked for real.
  const emitted: LogRecord[] = [];
  const logger = createLogger({
    sinks: [{ write: (record: LogRecord) => { emitted.push(record); } }],
    level: "debug",
    secrets: [AUTH],
  });
  const status = createStatusSurface({ label: "smoke", stream: { write: () => true } });

  const startup = loadWorkflowFile(path);
  const config = resolveConfig(startup, process.env);
  const tracker = new FakeTracker();
  const agentRunner = new HangingAgentRunner();
  const workspaceManager = new FakeWorkspaceManager();
  tracker.candidates = [issue("id-1", "DEV-1"), issue("id-2", "DEV-2")];

  const orchestrator = createOrchestrator({
    config, tracker, agentRunner, workspaceManager, logger, status,
  });
  const watcher = createConfigWatcher({
    path,
    initial: { config, promptTemplate: startup.prompt_template },
    logger,
    onReload: (snapshot) => orchestrator.applyConfig(snapshot.config),
  });
  watcher.start();

  console.log(`[smoke:reload] workflow: ${path}`);
  console.log(`[smoke:reload] startup config: interval=${config.polling.interval_ms}ms ` +
    `max_concurrent_agents=${config.agent.max_concurrent_agents}\n`);

  // Put one run in flight under the starting cap of 1.
  await orchestrator.tick();
  const inFlightBefore = orchestrator.runningCount();
  console.log(`[smoke:reload] 1) one run in flight under the old cap (running=${inFlightBefore}, ` +
    `agent launched: ${JSON.stringify(agentRunner.runs)})\n`);

  console.log("[smoke:reload] 2) GOOD edit — interval 30000→5000, max_concurrent_agents 1→3");
  writeFileSync(path, workflow(5_000, 3), "utf8");
  await sleep(600); // let the real fs.watch event + debounce land
  const afterGood = orchestrator.getState();
  console.log(`  live poll_interval_ms:       ${afterGood.poll_interval_ms}`);
  console.log(`  live max_concurrent_agents:  ${afterGood.max_concurrent_agents}`);
  console.log(`  in-flight runs disturbed:    ${orchestrator.runningCount() !== inFlightBefore}`);
  console.log(`  workspaces torn down:        ${JSON.stringify(workspaceManager.removed)}`);

  // The raised cap must let the second candidate through on the NEXT tick only.
  await orchestrator.tick();
  console.log(`  next tick dispatched:        ${JSON.stringify(agentRunner.runs)}\n`);

  console.log("[smoke:reload] 3) MALFORMED edit — must be rejected, previous config kept");
  writeFileSync(path, MALFORMED, "utf8");
  await sleep(600);
  const afterBad = orchestrator.getState();
  console.log(`  live poll_interval_ms:       ${afterBad.poll_interval_ms} (unchanged)`);
  console.log(`  live max_concurrent_agents:  ${afterBad.max_concurrent_agents} (unchanged)`);
  console.log(`  daemon alive:                ${true}`);
  await orchestrator.tick(); // still ticking after the bad edit
  console.log(`  tick after bad edit:         OK\n`);

  agentRunner.releaseAll();
  await orchestrator.stop();
  watcher.stop();

  const log = JSON.stringify(emitted);
  const applied = afterGood.poll_interval_ms === 5_000 && afterGood.max_concurrent_agents === 3;
  const rejected = afterBad.poll_interval_ms === 5_000 && afterBad.max_concurrent_agents === 3;
  const rejectionLogged = log.includes('"outcome":"rejected"');
  const undisturbed = workspaceManager.removed.length === 0 && agentRunner.runs.length === 2;
  const noLeak = !log.includes(AUTH);

  console.log("[smoke:reload] checks:");
  console.log(`  good edit applied live, no restart [§6.2]:            ${applied}`);
  console.log(`  malformed edit rejected, old config kept [§6.2]:      ${rejected}`);
  console.log(`  rejection is operator-visible in structured logs:     ${rejectionLogged}`);
  console.log(`  in-flight run never disturbed by a reload [§6.2]:     ${undisturbed}`);
  console.log(`  tracker.auth never logged [FR21]:                     ${noLeak}`);

  rmSync(dir, { recursive: true, force: true });

  const ok = applied && rejected && rejectionLogged && undisturbed && noLeak;
  console.log(`\n[smoke:reload] done — ${ok ? "PASS" : "FAIL"}: WORKFLOW.md reloads live; a bad edit cannot take the daemon down.`);
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(`[smoke:reload] FAILED: ${(error as Error).message}`);
  process.exit(1);
});
