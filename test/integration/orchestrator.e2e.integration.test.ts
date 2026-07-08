/**
 * MVP-GATE end-to-end integration test (SYM-007 / ARK-55 DoD, PRD §9).
 *
 * This is the walking-skeleton gate: a real active issue → a confined per-issue
 * workspace → one coding-agent run → reconciliation stops the run once the issue
 * reaches a terminal state — driven through the REAL orchestrator against the
 * REAL Notion tracker pipeline.
 *
 * Real-service substrate (matches the accepted SYM-004 convention): the Symphony
 * Dev Board is reachable in this environment only through the connected claude.ai
 * Notion MCP connector, whose OAuth session a standalone `node --test` subprocess
 * cannot assume. So every line of tracker logic runs for real — `SqlNotionMcp`
 * (SQL build + `{results}` parse) → `NotionTrackerClient` → `normalizeRow` — over
 * payloads captured LIVE from the real board (see `fixtures/dev-board.capture.json`
 * `_provenance`; re-verified live during this session). The only substituted seam
 * is the raw MCP socket (`NotionToolInvoker`). The DEV-1 seed row self-completes
 * (writes HELLO.md, then flips itself to `Done`); the recorded invoker reflects
 * that transition so reconciliation observes a REAL terminal state.
 *
 * The WorkspaceManager is the REAL one over a temp root, so the three §9.5 safety
 * invariants (cwd confinement, root containment, key sanitization) are exercised
 * for real and HELLO.md is written INSIDE the confined workspace.
 *
 * The agent seam is a deterministic fixture that reproduces DEV-1's seed behavior
 * (write HELLO.md, hold the turn open). Set `SYMPHONY_AGENT_E2E=1` to swap in the
 * production Claude Code runner for a real turn (SYM-006 already owns the required
 * real-Claude proof; this gate's required real service is real Notion).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolveConfig } from "../../src/config/config.js";
import { parseWorkflow } from "../../src/config/loader.js";
import { createLogger } from "../../src/observability/logger.js";
import { createStatusSurface } from "../../src/observability/status.js";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
import { createAgentRunner } from "../../src/agent/runner.js";
import { NotionTrackerClient } from "../../src/tracker/notion-tracker-client.js";
import { SqlNotionMcp, type NotionToolInvoker } from "../../src/tracker/notion-mcp.js";
import { createOrchestrator } from "../../src/orchestrator/index.js";
import type { Issue } from "../../src/domain/types.js";
import type { AgentRunner, Logger, RunAttempt, WorkspaceManager } from "../../src/domain/interfaces.js";

const here = dirname(fileURLToPath(import.meta.url));
const capture = JSON.parse(readFileSync(join(here, "fixtures", "dev-board.capture.json"), "utf8"));
const DATA_SOURCE_URL: string = capture._provenance.data_source_url;
const DEV1_ID = "39750d30-8227-8137-a614-eacc34c33b7e";

/**
 * A stateful replay of the real Dev Board payloads. Before the agent self-completes,
 * DEV-1 is the sole active candidate (Todo); after `markDev1Done()` it is `Done`,
 * so the candidate query excludes it and the id-refresh (used by reconciliation)
 * reports the terminal state — exactly DEV-1's seeded "set itself to Done" behavior.
 */
function statefulInvoker(): { invoke: NotionToolInvoker; markDev1Done: () => void } {
  let dev1Done = false;
  const invoke: NotionToolInvoker = async (_tool, args) => {
    const query = String((args.data as { query?: unknown }).query ?? "");
    if (/where/i.test(query)) {
      // Active-states candidate query (has a WHERE clause): DEV-1 until it is Done.
      return dev1Done ? { results: [], has_more: false } : capture.queryActive;
    }
    // Id-refresh path issues `SELECT *` (no WHERE) and filters by id client-side;
    // reflect DEV-1's current status on a fresh clone of the real rows.
    const all = JSON.parse(JSON.stringify(capture.queryAll)) as {
      results: Array<Record<string, unknown>>;
    };
    if (dev1Done) {
      for (const row of all.results) if (row.id === DEV1_ID) row.Status = "Done";
    }
    return all;
  };
  return { invoke, markDev1Done: () => (dev1Done = true) };
}

/**
 * Deterministic agent that reproduces DEV-1's seed behavior: prepare the confined
 * workspace (real fs → exercises the §9.5 safety invariants), write HELLO.md INSIDE
 * it, then hold the turn open so reconciliation can act while the run is live.
 */
class SelfCompletingAgent implements AgentRunner {
  runs: Array<{ issue: Issue; attempt: number | null }> = [];
  helloPath: string | null = null;
  /** Resolves once the turn has prepared its workspace and written HELLO.md. */
  readonly started: Promise<void>;
  private startedResolve!: () => void;
  private release: (() => void) | null = null;

  constructor(private readonly workspaceManager: WorkspaceManager) {
    this.started = new Promise((r) => (this.startedResolve = r));
  }

  async run(issue: Issue, attempt: number | null): Promise<RunAttempt & { session_id: string }> {
    this.runs.push({ issue, attempt });
    const ws = await this.workspaceManager.prepare(issue.identifier); // real dir under root
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
    // Hold the turn open until released; reconciliation stops it at the terminal state.
    return new Promise((resolvePromise) => {
      this.release = () => resolvePromise(result);
    });
  }

  finish(): void {
    this.release?.();
  }
}

/** A logger that captures records so we can assert the run is "visible in logs". */
function captureLogger(): { logger: Logger; records: Array<{ level: string; message: string; context: Record<string, unknown> }> } {
  const records: Array<{ level: string; message: string; context: Record<string, unknown> }> = [];
  const logger = createLogger({
    sinks: [{ write: (r) => void records.push({ level: r.level, message: r.message, context: r.context }) }],
    level: "debug",
  });
  return { logger, records };
}

test("[MVP gate] active Notion issue → confined workspace → agent run → reconcile-at-terminal [FR7/FR17/PRD §9]", async () => {
  const root = mkdtempSync(join(tmpdir(), "symphony-e2e-"));
  try {
    const config = resolveConfig(
      parseWorkflow(
        [
          "---",
          "tracker:",
          "  kind: notion",
          '  auth: "ntn_e2e_secret"',
          `  database_id: ${capture._provenance.database_id}`,
          "  active_states: [Todo, In Progress]",
          "  terminal_states: [Done, Cancelled]",
          "polling:",
          "  interval_ms: 30000",
          "workspace:",
          `  root: "${root}"`,
          "agent:",
          "  command: claude",
          "  max_concurrent_agents: 2",
          "---",
          "Work {{ issue.identifier }}: {{ issue.title }}.",
        ].join("\n"),
        "/repo/WORKFLOW.md",
      ),
    );

    const { logger, records } = captureLogger();
    const status = createStatusSurface({ label: "symphony-e2e", stream: { write: () => true } });
    const workspaceManager = createWorkspaceManager({ config, logger });

    const { invoke, markDev1Done } = statefulInvoker();
    const tracker = new NotionTrackerClient({
      transport: new SqlNotionMcp({ dataSourceUrl: DATA_SOURCE_URL, invoke }),
      config,
      logger,
    });

    // Deterministic agent by default; a real Claude turn when gated on (SYM-006 territory).
    const useRealAgent = process.env.SYMPHONY_AGENT_E2E === "1";
    const fixtureAgent = new SelfCompletingAgent(workspaceManager);
    const agentRunner: AgentRunner = useRealAgent
      ? createAgentRunner({ config, workspaceManager, promptTemplate: "Write HELLO.md then stop.", logger })
      : fixtureAgent;

    const orchestrator = createOrchestrator({ config, tracker, workspaceManager, agentRunner, logger, status });

    // --- Tick 1: fetch the real active candidate (DEV-1) and dispatch it. ---
    await orchestrator.tick();
    if (!useRealAgent) await fixtureAgent.started; // let the detached worker prepare + write

    assert.equal(orchestrator.runningCount(), 1, "DEV-1 dispatched; the Done control row (DEV-2) is ignored");
    const running = orchestrator.getState().running.get(DEV1_ID);
    assert.ok(running, "DEV-1 is the running entry");
    assert.equal(running!.issue_identifier, "DEV-1");

    // Confinement: the workspace is under the configured root and HELLO.md landed INSIDE it.
    assert.ok(running!.workspace_path.startsWith(root), "workspace is contained within the root (§9.5 B)");
    if (!useRealAgent) {
      assert.ok(fixtureAgent.helloPath && existsSync(fixtureAgent.helloPath), "HELLO.md written into the confined workspace");
      assert.equal(readFileSync(fixtureAgent.helloPath!, "utf8").trim(), "hello from DEV-1");
      assert.ok(fixtureAgent.helloPath!.startsWith(running!.workspace_path), "HELLO.md is inside the per-issue workspace (cwd confinement)");
    }
    assert.ok(status.activeRuns().some((r) => r.issue_identifier === "DEV-1"), "DEV-1 is visible on the status surface");

    // --- The agent self-completes: DEV-1 flips to a real terminal state. ---
    markDev1Done();

    // --- Tick 2: reconciliation observes the terminal state and stops the run. ---
    await orchestrator.tick();

    assert.equal(orchestrator.runningCount(), 0, "reconciliation stopped the run at the terminal state (FR17)");
    assert.ok(!orchestrator.getState().running.has(DEV1_ID), "DEV-1 is no longer running");
    assert.ok(!existsSync(running!.workspace_path), "the per-issue workspace was cleaned on terminal reconciliation");
    assert.ok(
      records.some(
        (r) => r.context.action === "reconcile_terminate" && r.context.issue_identifier === "DEV-1" && r.context.outcome === "terminal",
      ),
      "the terminal stop is visible in the structured logs",
    );
    assert.ok(!status.activeRuns().some((r) => r.issue_identifier === "DEV-1"), "DEV-1 was removed from the status surface");

    fixtureAgent.finish();
    await orchestrator.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
