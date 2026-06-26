import { describe, expect, it } from "vitest";
import { Logger, MemorySink } from "../../obs/log.js";
import type { ServiceConfig, WorkflowDefinition } from "../../domain/config.js";
import type { Issue, IssueStateRef } from "../../domain/issue.js";
import type {
  AgentEvent,
  AgentResult,
  AgentRunRequest,
  AgentRunner,
  TrackerClient,
  Workspace,
  WorkspaceManager,
} from "../../domain/interfaces.js";
import { createRuntimeState } from "../../domain/state.js";
import {
  compareForDispatch,
  createOrchestrator,
  isEligible,
  sortForDispatch,
  type Scheduler,
} from "../loop.js";

const fixedNow = () => new Date("2026-06-02T12:00:00.000Z");

function makeLogger() {
  const sink = new MemorySink();
  const logger = new Logger({ level: "debug", sinks: [sink], now: fixedNow });
  return { logger, sink };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    identifier: "SYM-1",
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

function serviceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    tracker: {
      kind: "notion",
      database: "db1",
      api_key: "tok",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Cancelled"],
    },
    polling: { interval_ms: 30000 },
    workspace: { root: "/tmp/ws" },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 60000,
    },
    agent: {
      command: "claude --print",
      max_concurrent_agents: 2,
      max_turns: 1,
      max_retry_backoff_ms: 300000,
      max_concurrent_agents_by_state: {},
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
      ...(overrides.agent ?? {}),
    },
    ...overrides,
  };
}

function workflow(overrides: Partial<ServiceConfig> = {}): WorkflowDefinition {
  const service = serviceConfig(overrides);
  return {
    config: {},
    prompt_template: "Work {{ issue.identifier }}.",
    service,
    source_path: "/tmp/WORKFLOW.md",
  };
}

/** Tracker fake driven by queued candidate sets + refresh maps. */
class FakeTracker implements TrackerClient {
  candidateCalls = 0;
  refreshCalls: string[][] = [];
  constructor(
    private readonly candidates: Issue[][],
    private readonly refresh: Array<Record<string, string>> = [],
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    const idx = Math.min(this.candidateCalls, this.candidates.length - 1);
    this.candidateCalls += 1;
    return this.candidates[idx] ?? [];
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<IssueStateRef[]> {
    const idx = Math.min(this.refreshCalls.length, this.refresh.length - 1);
    this.refreshCalls.push(ids);
    const map = this.refresh[idx] ?? {};
    const out: IssueStateRef[] = [];
    for (const id of ids) {
      if (map[id]) out.push({ id, identifier: null, state: map[id] });
    }
    return out;
  }
}

/** Workspace fake: records ensure/remove calls; never touches the filesystem. */
class FakeWorkspace implements WorkspaceManager {
  ensured: string[] = [];
  removed: string[] = [];
  async ensureWorkspace(issue: Issue): Promise<Workspace> {
    this.ensured.push(issue.id);
    return {
      path: `/tmp/ws/${issue.identifier}`,
      workspace_key: issue.identifier,
      created_now: true,
    };
  }
  async removeWorkspace(key: string): Promise<void> {
    this.removed.push(key);
  }
}

/** Agent fake: records each run and resolves with a controllable result. */
class FakeAgent implements AgentRunner {
  runs: AgentRunRequest[] = [];
  /** Resolve immediately by default; set to false to keep the worker "running". */
  resolveImmediately = true;
  private pending: Array<() => void> = [];
  result: AgentResult = { ok: true, session_id: "thread-1-1" };
  emitSession = true;

  async run(
    request: AgentRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentResult> {
    this.runs.push(request);
    if (this.emitSession) {
      onEvent?.({
        type: "session_started",
        timestamp: fixedNow().toISOString(),
        session_id: this.result.session_id ?? "thread-1-1",
      });
    }
    if (this.resolveImmediately) {
      onEvent?.({
        type: "turn_completed",
        timestamp: fixedNow().toISOString(),
        session_id: this.result.session_id ?? "thread-1-1",
      });
      return this.result;
    }
    return new Promise<AgentResult>((resolve) => {
      this.pending.push(() => resolve(this.result));
    });
  }

  /** Resolve every still-running worker. */
  flush(): void {
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) p();
  }
}

/** A manually-pumped scheduler so ticks can be advanced deterministically. */
class FakeScheduler implements Scheduler {
  queue: Array<{ fn: () => void; delayMs: number }> = [];
  schedule(fn: () => void, delayMs: number): () => void {
    const item = { fn, delayMs };
    this.queue.push(item);
    return () => {
      this.queue = this.queue.filter((q) => q !== item);
    };
  }
  /** Run the next scheduled callback (FIFO). */
  runNext(): number | null {
    const item = this.queue.shift();
    if (!item) return null;
    item.fn();
    return item.delayMs;
  }
}

/** Let queued microtasks (awaited dispatch/reconcile + reschedule) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

describe("compareForDispatch / sortForDispatch (FR-OR-4)", () => {
  it("orders by priority asc (null last) → created_at oldest → identifier", () => {
    const a = makeIssue({ id: "a", identifier: "SYM-3", priority: 1, created_at: "2026-01-02T00:00:00Z" });
    const b = makeIssue({ id: "b", identifier: "SYM-1", priority: 1, created_at: "2026-01-01T00:00:00Z" });
    const c = makeIssue({ id: "c", identifier: "SYM-2", priority: null, created_at: "2025-01-01T00:00:00Z" });
    const d = makeIssue({ id: "d", identifier: "SYM-4", priority: 2, created_at: "2020-01-01T00:00:00Z" });

    const sorted = sortForDispatch([a, b, c, d]).map((i) => i.id);
    // b (p1, oldest) → a (p1) → d (p2) → c (null priority last)
    expect(sorted).toEqual(["b", "a", "d", "c"]);
  });

  it("uses identifier as a stable tie-breaker when priority+created_at tie", () => {
    const x = makeIssue({ id: "x", identifier: "SYM-9", priority: 1, created_at: "2026-01-01T00:00:00Z" });
    const y = makeIssue({ id: "y", identifier: "SYM-2", priority: 1, created_at: "2026-01-01T00:00:00Z" });
    expect(compareForDispatch(x, y)).toBeGreaterThan(0);
    expect(sortForDispatch([x, y]).map((i) => i.id)).toEqual(["y", "x"]);
  });
});

describe("isEligible (FR-OR-3)", () => {
  const config = serviceConfig();

  it("rejects issues missing required fields", () => {
    const state = createRuntimeState(30000, 5);
    expect(isEligible(makeIssue({ title: "" }), state, config)).toBe(false);
    expect(isEligible(makeIssue({ id: "" }), state, config)).toBe(false);
  });

  it("rejects terminal / non-active states", () => {
    const state = createRuntimeState(30000, 5);
    expect(isEligible(makeIssue({ state: "Done" }), state, config)).toBe(false);
    expect(isEligible(makeIssue({ state: "Backlog" }), state, config)).toBe(false);
    expect(isEligible(makeIssue({ state: "In Progress" }), state, config)).toBe(true);
  });

  it("rejects already running/claimed issues", () => {
    const state = createRuntimeState(30000, 5);
    state.claimed.add("i1");
    expect(isEligible(makeIssue({ id: "i1" }), state, config)).toBe(false);
  });

  it("rejects when no global slot is free", () => {
    const state = createRuntimeState(30000, 0);
    expect(isEligible(makeIssue(), state, config)).toBe(false);
  });

  it("Todo with a non-terminal blocker is ineligible; terminal blocker is fine", () => {
    const state = createRuntimeState(30000, 5);
    const blocked = makeIssue({
      state: "Todo",
      blocked_by: [{ id: "b", identifier: "SYM-0", state: "In Progress" }],
    });
    expect(isEligible(blocked, state, config)).toBe(false);

    const unblocked = makeIssue({
      state: "Todo",
      blocked_by: [{ id: "b", identifier: "SYM-0", state: "Done" }],
    });
    expect(isEligible(unblocked, state, config)).toBe(true);
  });

  it("blocker rule only applies to Todo state", () => {
    const state = createRuntimeState(30000, 5);
    const inProgress = makeIssue({
      state: "In Progress",
      blocked_by: [{ id: "b", identifier: "SYM-0", state: "In Progress" }],
    });
    expect(isEligible(inProgress, state, config)).toBe(true);
  });
});

describe("tick dispatch — slot accounting + no duplicate dispatch (FR-OR-5)", () => {
  it("dispatches eligible issues in order, capped by max_concurrent_agents", async () => {
    const { logger } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1", priority: 1 });
    const i2 = makeIssue({ id: "i2", identifier: "SYM-2", priority: 2 });
    const i3 = makeIssue({ id: "i3", identifier: "SYM-3", priority: 3 });
    const tracker = new FakeTracker([[i3, i1, i2]]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = false; // keep workers running to fill slots

    const orch = createOrchestrator({
      workflow: workflow(), // max_concurrent_agents = 2
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    await orch.tick();
    await settle();

    // Only 2 slots → exactly 2 dispatched, highest priority first (i1, i2).
    expect(agent.runs.map((r) => r.issue.id)).toEqual(["i1", "i2"]);
    expect(orch.state.running.size).toBe(2);
    expect(orch.state.claimed.size).toBe(2);
  });

  it("does not dispatch an already-running issue again on the next tick", async () => {
    const { logger } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1" });
    const tracker = new FakeTracker([[i1], [i1]], [{ i1: "In Progress" }]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = false;

    const orch = createOrchestrator({
      workflow: workflow(),
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    await orch.tick();
    await settle();
    expect(agent.runs.length).toBe(1);

    // Second tick: i1 is still running/claimed → must NOT dispatch again.
    await orch.tick();
    await settle();
    expect(agent.runs.length).toBe(1);
    expect(orch.state.running.size).toBe(1);
  });

  it("records session id + turn count from agent events", async () => {
    const { logger } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1" });
    const tracker = new FakeTracker([[i1]]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = false; // keep entry alive to inspect

    const orch = createOrchestrator({
      workflow: workflow(),
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    await orch.tick();
    await settle();
    const entry = orch.state.running.get("i1");
    expect(entry?.session_id).toBe("thread-1-1");
  });
});

describe("reconcile transitions (FR-OR-8 Part B)", () => {
  it("terminal running issue stops worker and cleans its workspace", async () => {
    const { logger } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1" });
    // tick 1 dispatches; tick 2 reconcile sees Done.
    const tracker = new FakeTracker([[i1], []], [{ i1: "Done" }]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = false;

    const orch = createOrchestrator({
      workflow: workflow(),
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    await orch.tick();
    await settle();
    expect(orch.state.running.size).toBe(1);

    await orch.tick(); // reconcile refresh → Done → terminate + cleanup
    await settle();
    expect(orch.state.running.has("i1")).toBe(false);
    expect(orch.state.claimed.has("i1")).toBe(false);
    expect(ws.removed).toContain("SYM-1");
    expect(orch.state.completed.has("i1")).toBe(true);
  });

  it("still-active running issue updates the snapshot and keeps the worker", async () => {
    const { logger } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1", state: "Todo" });
    const tracker = new FakeTracker([[i1], []], [{ i1: "In Progress" }]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = false;

    const orch = createOrchestrator({
      workflow: workflow(),
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    await orch.tick();
    await settle();
    await orch.tick(); // reconcile → In Progress (active) → update snapshot
    await settle();

    const entry = orch.state.running.get("i1");
    expect(entry?.last_state).toBe("In Progress");
    expect(ws.removed).toHaveLength(0);
  });

  it("a refresh failure (no states resolved) keeps workers running", async () => {
    const { logger } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1" });
    // refresh returns {} ⇒ no IssueStateRef resolved ⇒ keep workers.
    const tracker = new FakeTracker([[i1], []], [{}]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = false;

    const orch = createOrchestrator({
      workflow: workflow(),
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    await orch.tick();
    await settle();
    await orch.tick();
    await settle();

    expect(orch.state.running.has("i1")).toBe(true);
    expect(ws.removed).toHaveLength(0);
  });

  it("non-active (neither active nor terminal) stops worker WITHOUT cleanup", async () => {
    const { logger } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1" });
    const tracker = new FakeTracker([[i1], []], [{ i1: "Backlog" }]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = false;

    const orch = createOrchestrator({
      workflow: workflow(),
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    await orch.tick();
    await settle();
    await orch.tick();
    await settle();

    expect(orch.state.running.has("i1")).toBe(false);
    expect(ws.removed).toHaveLength(0);
  });
});

describe("validation failure skips dispatch but still reconciles (FR-OR-2)", () => {
  it("invalid config skips dispatch; reconcile still ran first", async () => {
    const { logger, sink } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1" });
    const tracker = new FakeTracker([[i1]]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();

    // Break the config so preflight fails (missing database).
    const wf = workflow();
    wf.service.tracker.database = null;

    const orch = createOrchestrator({
      workflow: wf,
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    await orch.tick();
    await settle();

    expect(agent.runs).toHaveLength(0); // no dispatch
    // reconcile ran first (no running ⇒ no refresh call), candidates not fetched.
    expect(tracker.candidateCalls).toBe(0);
    const lines = sink.lines.join("\n");
    expect(lines).toContain("dispatch_preflight_failed");
  });
});

describe("tick scheduling with a fake clock (FR-OR-2 / NFR-PERF)", () => {
  it("schedules an immediate first tick then repeats at interval_ms", async () => {
    const { logger } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1" });
    const tracker = new FakeTracker([[i1], []], [{ i1: "In Progress" }]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = false;
    const scheduler = new FakeScheduler();

    const orch = createOrchestrator({
      workflow: workflow(), // interval 30000
      tracker,
      workspace: ws,
      agent,
      logger,
      scheduler,
      now: fixedNow,
      statusOut: () => {},
    });

    orch.start();
    // First tick is scheduled at delay 0.
    expect(scheduler.queue[0]?.delayMs).toBe(0);

    scheduler.runNext(); // run the immediate first tick
    await settle();
    expect(agent.runs.length).toBe(1);

    // After a tick completes, the next is scheduled at interval_ms.
    expect(scheduler.queue[0]?.delayMs).toBe(30000);

    scheduler.runNext(); // second tick (reconcile only, i1 still running)
    await settle();
    expect(scheduler.queue[0]?.delayMs).toBe(30000);
  });

  it("stop() cancels the pending tick and prevents reschedules", async () => {
    const { logger } = makeLogger();
    const tracker = new FakeTracker([[]]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    const scheduler = new FakeScheduler();

    const orch = createOrchestrator({
      workflow: workflow(),
      tracker,
      workspace: ws,
      agent,
      logger,
      scheduler,
      now: fixedNow,
      statusOut: () => {},
    });

    const handle = orch.start();
    expect(scheduler.queue.length).toBe(1);
    handle.stop();
    expect(scheduler.queue.length).toBe(0);
  });
});

describe("end-to-end walking skeleton (MVP success criterion)", () => {
  it("poll → sanitized workspace → launch agent once → reconcile terminal → log", async () => {
    const { logger, sink } = makeLogger();
    const candidate = makeIssue({ id: "i1", identifier: "SYM 1!", state: "Todo" });
    const tracker = new FakeTracker(
      [[candidate], []],
      [{ i1: "Done" }],
    );
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = false; // worker stays running until reconcile

    const orch = createOrchestrator({
      workflow: workflow(),
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    // Tick 1: dispatch.
    await orch.tick();
    await settle();
    expect(ws.ensured).toEqual(["i1"]); // workspace created
    expect(agent.runs).toHaveLength(1); // agent launched once
    expect(agent.runs[0]?.workspace.path).toBe("/tmp/ws/SYM 1!");
    expect(agent.runs[0]?.prompt).toContain("SYM 1!"); // rendered prompt
    expect(orch.state.running.size).toBe(1);

    // Tick 2: reconcile sees terminal → stop + clean workspace.
    await orch.tick();
    await settle();
    expect(orch.state.running.size).toBe(0);
    expect(ws.removed).toContain("SYM 1!");

    const lines = sink.lines.join("\n");
    expect(lines).toContain("event=dispatch");
    expect(lines).toContain("event=reconcile_terminal");
  });

  it("a clean worker exit removes the running entry so the issue can be re-picked", async () => {
    const { logger } = makeLogger();
    const i1 = makeIssue({ id: "i1", identifier: "SYM-1" });
    const tracker = new FakeTracker([[i1]]);
    const ws = new FakeWorkspace();
    const agent = new FakeAgent();
    agent.resolveImmediately = true; // worker exits cleanly right away

    const orch = createOrchestrator({
      workflow: workflow(),
      tracker,
      workspace: ws,
      agent,
      logger,
      now: fixedNow,
      statusOut: () => {},
    });

    await orch.tick();
    await settle();
    // Worker resolved ⇒ running entry removed (MVP: no retry timer).
    expect(orch.state.running.has("i1")).toBe(false);
    expect(orch.state.claimed.has("i1")).toBe(false);
    expect(orch.state.completed.has("i1")).toBe(true);
  });
});
