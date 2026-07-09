/**
 * Shared test doubles for the orchestrator suite (ARK-55).
 *
 * These are deliberately minimal in-memory fakes for the §4 ports so tests drive
 * the REAL orchestrator logic (tick/reconcile/dispatch/eligibility/sort) without
 * Notion, a filesystem, or Claude Code.
 */

import type { Issue, ServiceConfig } from "../../src/domain/types.js";
import type {
  AgentRunner,
  RunAttempt,
  TrackerClient,
  Workspace,
  WorkspaceManager,
} from "../../src/domain/interfaces.js";

/** A minimal but complete `ServiceConfig` for orchestrator tests. */
export function testConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const base: ServiceConfig = {
    tracker: {
      kind: "notion",
      auth: "tok",
      database_id: "db-1",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Cancelled"],
    },
    polling: { interval_ms: 30000 },
    workspace: { root: "/tmp/symphony-test-root" },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 60000,
    },
    agent: {
      command: "claude",
      max_concurrent_agents: 2,
      max_turns: 20,
      max_retry_backoff_ms: 300000,
      max_concurrent_agents_by_state: {},
      turn_timeout_ms: 3600000,
      read_timeout_ms: 5000,
      stall_timeout_ms: 300000,
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
    },
  };
  return { ...base, ...overrides };
}

/** A normalized issue with sensible defaults. */
export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "id-1",
    identifier: "DEV-1",
    title: "Do the thing",
    description: null,
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
    ...overrides,
  };
}

/**
 * A scriptable tracker fake. `candidates` feeds `fetchCandidateIssues`; `statesById`
 * feeds `fetchIssueStatesByIds` (falling back to `candidates` by id). Set
 * `failCandidates` / `failStates` to simulate transport errors. Every call is
 * counted for assertions.
 */
export class FakeTracker implements TrackerClient {
  candidates: Issue[] = [];
  /** Optional override for reconciliation lookups, keyed by issue id. */
  statesById = new Map<string, Issue>();
  failCandidates: Error | null = null;
  failStates: Error | null = null;
  failByStates: Error | null = null;
  /** Records the state-name arguments each `fetchIssuesByStates` call received. */
  byStatesArgs: string[][] = [];
  calls = { fetchCandidateIssues: 0, fetchIssueStatesByIds: 0, fetchIssuesByStates: 0 };

  async fetchCandidateIssues(): Promise<Issue[]> {
    this.calls.fetchCandidateIssues += 1;
    if (this.failCandidates) throw this.failCandidates;
    return this.candidates;
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    this.calls.fetchIssuesByStates += 1;
    this.byStatesArgs.push(stateNames);
    if (this.failByStates) throw this.failByStates;
    if (stateNames.length === 0) return [];
    return this.candidates.filter((i) => stateNames.includes(i.state));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    this.calls.fetchIssueStatesByIds += 1;
    if (this.failStates) throw this.failStates;
    if (ids.length === 0) return [];
    const byId = new Map<string, Issue>();
    for (const c of this.candidates) byId.set(c.id, c);
    for (const [id, i] of this.statesById) byId.set(id, i);
    return ids.map((id) => byId.get(id)).filter((i): i is Issue => i !== undefined);
  }
}

/** A workspace manager fake that records prepare/remove without touching disk. */
export class FakeWorkspaceManager implements WorkspaceManager {
  root: string;
  prepared: string[] = [];
  removed: string[] = [];
  removeError: Error | null = null;

  constructor(root = "/tmp/symphony-test-root") {
    this.root = root;
  }

  workspacePathFor(identifier: string): string {
    return `${this.root}/${identifier}`;
  }

  async prepare(identifier: string): Promise<Workspace> {
    this.prepared.push(identifier);
    return { path: this.workspacePathFor(identifier), workspace_key: identifier, created_now: true };
  }

  async remove(identifier: string): Promise<void> {
    if (this.removeError) throw this.removeError;
    this.removed.push(identifier);
  }
}

/**
 * A controllable agent runner. By default each `run` resolves immediately with a
 * `succeeded` attempt. Set `mode = "manual"` to hold every run pending until
 * `resolveAll()` is called — so reconciliation can act while the worker is "live".
 */
export class FakeAgentRunner implements AgentRunner {
  mode: "auto" | "manual" = "auto";
  runs: Array<{ issue: Issue; attempt: number | null }> = [];
  status: RunAttempt["status"] = "succeeded";
  sessionId = "thread-1-turn-1";
  /** When set, every `run` rejects with this error (simulates an agent crash). */
  throwError: Error | null = null;
  private pending: Array<() => void> = [];

  async run(issueArg: Issue, attempt: number | null): Promise<RunAttempt & { session_id: string }> {
    this.runs.push({ issue: issueArg, attempt });
    if (this.throwError) throw this.throwError;
    const result: RunAttempt & { session_id: string } = {
      issue_id: issueArg.id,
      issue_identifier: issueArg.identifier,
      attempt,
      workspace_path: `/tmp/symphony-test-root/${issueArg.identifier}`,
      started_at: "2026-01-01T00:00:00.000Z",
      status: this.status,
      session_id: this.sessionId,
    };
    if (this.mode === "auto") return result;
    return new Promise((resolvePromise) => {
      this.pending.push(() => resolvePromise(result));
    });
  }

  /** Resolve every pending manual run. */
  resolveAll(): void {
    const waiters = this.pending;
    this.pending = [];
    for (const w of waiters) w();
  }
}

/** A logger that captures records for assertions and never throws. */
export function captureLogger() {
  const records: Array<{ level: string; message: string; context: Record<string, unknown> }> = [];
  const make = (bound: Record<string, unknown>) => {
    const emit = (level: string) => (message: string, context: Record<string, unknown> = {}) => {
      records.push({ level, message, context: { ...bound, ...context } });
    };
    const logger = {
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      child: (context: Record<string, unknown>) => make({ ...bound, ...context }),
    };
    return logger;
  };
  return { logger: make({}) as unknown as import("../../src/domain/interfaces.js").Logger, records };
}
