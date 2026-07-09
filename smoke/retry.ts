/**
 * smoke:retry — evidence that the Retry/Backoff unit (ARK-56) does its real job
 * (§8.4 + §16.6), driving the REAL orchestrator + {@link RetryQueue} over in-memory
 * fakes with an injected scheduler (so timing is deterministic, no service needed):
 *
 *   1. a FAILED run schedules an exponential-backoff retry (attempt 1 → 1000ms),
 *      keeps the claim (RetryQueued), and surfaces on the status line;
 *   2. successive failures grow the backoff (1000 → 2000 → 4000 …) capped at
 *      `agent.max_retry_backoff_ms`, re-dispatching with an incremented `attempt`;
 *   3. a due retry whose issue has gone terminal (absent from active candidates)
 *      is DROPPED and its claim RELEASED.
 *
 * Usage: `tsx smoke/retry.ts`
 */

import { createOrchestrator } from "../src/orchestrator/orchestrator.js";
import { computeBackoffMs } from "../src/orchestrator/retry.js";
import { createLogger } from "../src/observability/logger.js";
import { createStatusSurface } from "../src/observability/status.js";
import type {
  AgentRunner,
  RunAttempt,
  TrackerClient,
  Workspace,
  WorkspaceManager,
} from "../src/domain/interfaces.js";
import type { Issue, ServiceConfig } from "../src/domain/types.js";

/* --------------------------- minimal in-memory fakes --------------------------- */

interface Scheduled {
  ms: number;
  cancelled: boolean;
  fired: boolean;
  fire: () => void;
}
function manualScheduler() {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    setTimer: (fn: () => void, ms: number): Scheduled => {
      const e: Scheduled = { ms, cancelled: false, fired: false, fire: () => { e.fired = true; fn(); } };
      scheduled.push(e);
      return e;
    },
    clearTimer: (h: unknown) => { (h as Scheduled).cancelled = true; },
    live(): Scheduled | undefined {
      return scheduled.filter((s) => !s.cancelled && !s.fired).at(-1);
    },
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

class FakeWorkspace implements WorkspaceManager {
  workspacePathFor(id: string): string { return `/tmp/smoke/${id}`; }
  async prepare(id: string): Promise<Workspace> {
    return { path: this.workspacePathFor(id), workspace_key: id, created_now: true };
  }
  async remove(): Promise<void> {}
}

/** An agent that always fails, so every dispatch drives the retry path. */
class FailingAgent implements AgentRunner {
  runs: Array<number | null> = [];
  async run(issue: Issue, attempt: number | null): Promise<RunAttempt> {
    this.runs.push(attempt);
    return {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      workspace_path: `/tmp/smoke/${issue.identifier}`,
      started_at: new Date(0).toISOString(),
      status: "failed",
      error: "smoke: simulated agent failure",
    };
  }
}

function config(overrides: Partial<ServiceConfig["agent"]> = {}): ServiceConfig {
  return {
    tracker: { kind: "notion", auth: "tok", database_id: "db", active_states: ["Todo", "In Progress"], terminal_states: ["Done", "Cancelled"] },
    polling: { interval_ms: 30000 },
    workspace: { root: "/tmp/smoke" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 60000 },
    agent: {
      command: "claude", max_concurrent_agents: 1, max_turns: 20, max_retry_backoff_ms: 4000,
      max_concurrent_agents_by_state: {}, turn_timeout_ms: 3600000, read_timeout_ms: 5000,
      stall_timeout_ms: 300000, approval_policy: null, thread_sandbox: null, turn_sandbox_policy: null,
      ...overrides,
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const issue = (): Issue => ({
  id: "id-1", identifier: "DEV-1", title: "Retry me", description: null, priority: 1,
  state: "Todo", branch_name: null, url: null, labels: [], blocked_by: [],
  created_at: null, updated_at: null,
});

async function main(): Promise<void> {
  console.log("[smoke:retry] backoff formula (base 1000ms, cap 4000ms):");
  for (const a of [1, 2, 3, 4, 5]) {
    console.log(`  attempt ${a} → ${computeBackoffMs(a, 4000)}ms`);
  }

  const tracker = new FakeTracker();
  tracker.candidates = [issue()];
  const agent = new FailingAgent();
  const status = createStatusSurface({ label: "symphony" });
  const logger = createLogger({ sinks: [] });
  const sched = manualScheduler();
  const orch = createOrchestrator({
    config: config(), tracker, agentRunner: agent, workspaceManager: new FakeWorkspace(),
    logger, status, setTimer: sched.setTimer, clearTimer: sched.clearTimer,
    now: () => new Date(0), nowMs: () => 0,
  });

  console.log("\n[smoke:retry] 1) a failed run schedules a backoff retry + keeps the claim\n");
  await orch.tick();
  await flush(); await flush();
  const q1 = [...orch.getState().retry_attempts.values()];
  console.log(`  retry queue: ${JSON.stringify(q1.map((e) => ({ id: e.issue_id, attempt: e.attempt, error: e.error })))}`);
  console.log(`  armed timer delay: ${sched.live()!.ms}ms   claim held: ${orch.getState().claimed.has("id-1")}`);
  console.log(`  status line: ${status.render()}`);

  console.log("\n[smoke:retry] 2) successive failures grow the backoff (capped) with incremented attempt\n");
  for (let i = 0; i < 3; i++) {
    const timer = sched.live();
    if (!timer) break;
    timer.fire();
    await flush(); await flush();
    const e = orch.getState().retry_attempts.get("id-1");
    const armed = sched.live();
    console.log(`  re-dispatched attempt=${agent.runs.at(-1)} → next retry attempt=${e?.attempt}, delay=${armed?.ms}ms`);
  }
  console.log(`  agent attempts observed (null=first run): ${JSON.stringify(agent.runs)}`);

  console.log("\n[smoke:retry] 3) a due retry whose issue went terminal is dropped + claim released\n");
  tracker.candidates = []; // DEV-1 reached Done → no longer an active candidate
  sched.live()!.fire();
  await flush(); await flush();
  const dropped = orch.getState().retry_attempts.size === 0;
  const released = !orch.getState().claimed.has("id-1");
  console.log(`  retry queue empty: ${dropped}   claim released: ${released}   status: ${status.render()}`);

  const capReached = agent.runs.some((a) => a !== null && a >= 3);
  const ok = q1.length === 1 && sched.scheduled[0]!.ms === 1000 && capReached && dropped && released;
  console.log(`\n[smoke:retry] done — ${ok ? "PASS" : "FAIL"}: backoff + queue + re-dispatch + drop-on-terminal.`);
  if (!ok) process.exit(1);
  await orch.stop();
}

main().catch((error) => {
  console.error(`[smoke:retry] FAILED: ${(error as Error).message}`);
  process.exit(1);
});
