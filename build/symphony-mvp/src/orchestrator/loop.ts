/**
 * Orchestrator poll loop (U3; SYMPHONY-SPEC §7, §8, §16.2–§16.4;
 * FR-OR-1..5, FR-OR-8 Part B).
 *
 * The integrating unit. Wires the read-only tracker (U2), the workspace manager
 * + agent runner (U4), config/validation (U1) and the logger/status surface (U5)
 * into a single-authority poll → dispatch → reconcile loop:
 *
 *   on each tick:
 *     1. reconcile running issues (refresh tracker state; terminal ⇒ stop +
 *        clean workspace, active ⇒ update snapshot, refresh failure ⇒ keep),
 *     2. run dispatch preflight validation (U1); failure ⇒ skip dispatch but
 *        the reconcile in step 1 still happened,
 *     3. fetch candidate issues (U2); fetch failure ⇒ skip this tick,
 *     4. sort by dispatch priority, dispatch while global slots remain,
 *     5. render the status surface (U5),
 *     6. reschedule at `polling.interval_ms`.
 *
 * Startup schedules an immediate first tick (delay 0), then repeats at the
 * effective interval (§8.1 / NFR-PERF). All scheduler-state mutations flow
 * through `state.ts` so dispatch is single-authority (no duplicate dispatch).
 *
 * The MVP omits the retry queue: a worker exit just removes the running entry
 * and lets the issue be re-picked on the next poll. Deferred items (retry/
 * backoff, per-state caps, stall detection, multi-turn continuation, startup
 * terminal sweep) extend this module without rewriting it.
 */

import type { Logger } from "../obs/log.js";
import { errorMessage } from "../obs/log.js";
import { renderStatus } from "../obs/status.js";
import type { ServiceConfig, WorkflowDefinition } from "../domain/config.js";
import type { Issue } from "../domain/issue.js";
import type {
  AgentEvent,
  AgentRunner,
  TrackerClient,
  Workspace,
  WorkspaceManager,
} from "../domain/interfaces.js";
import type { OrchestratorRuntimeState } from "../domain/state.js";
import { validateDispatchConfig } from "../config/preflight.js";
import { renderPrompt } from "../prompt/render.js";
import {
  availableSlots,
  createRuntimeState,
  incrementTurnCount,
  isClaimedOrRunning,
  markCompleted,
  noAvailableSlots,
  recordRunning,
  releaseRunning,
  setSessionId,
  updateRunningState,
} from "./state.js";

/** A schedulable timer seam so tests can drive ticks with a fake clock. */
export interface Scheduler {
  /** Schedule `fn` to run after `delayMs`; returns a cancel handle. */
  schedule(fn: () => void, delayMs: number): () => void;
}

/** Default scheduler backed by Node `setTimeout` (unref'd so it never blocks exit). */
export const defaultScheduler: Scheduler = {
  schedule(fn: () => void, delayMs: number): () => void {
    const handle = setTimeout(fn, Math.max(0, delayMs));
    if (typeof handle.unref === "function") handle.unref();
    return () => clearTimeout(handle);
  },
};

/** Construction options for the orchestrator. */
export interface OrchestratorOptions {
  /** Loaded + resolved workflow (config + prompt template). */
  workflow: WorkflowDefinition;
  /** Read-only tracker adapter (U2). */
  tracker: TrackerClient;
  /** Per-issue workspace lifecycle + safety (U4). */
  workspace: WorkspaceManager;
  /** Coding-agent runner (U4). */
  agent: AgentRunner;
  /** Structured logger / status base (U5). */
  logger: Logger;
  /** Pre-seeded runtime state; defaults to one seeded from config. */
  state?: OrchestratorRuntimeState;
  /** Timer seam (default: real setTimeout). */
  scheduler?: Scheduler;
  /** Clock for timestamps/status header (default: real). */
  now?: () => Date;
  /**
   * Where the rendered status surface is written. Default `process.stdout`.
   * Pass a custom sink in tests; never required for correctness (§13.4).
   */
  statusOut?: (text: string) => void;
}

/** Lowercased state-set membership helper (§4.2 — states compared lowercased). */
function makeStateSet(states: string[]): Set<string> {
  return new Set(states.map((s) => s.toLowerCase()));
}

/** True when a blocker ref is in a terminal state (case-insensitive). */
function isBlockerTerminal(
  blockerState: string | null,
  terminal: Set<string>,
): boolean {
  if (blockerState === null) return false; // unknown state ⇒ treat as non-terminal
  return terminal.has(blockerState.toLowerCase());
}

/**
 * Dispatch-priority comparator (§8.2 / FR-OR-4): `priority` ascending with
 * null/unknown sorting LAST, then `created_at` oldest first, then `identifier`
 * lexicographically as a stable tie-breaker.
 */
export function compareForDispatch(a: Issue, b: Issue): number {
  // priority ascending, null last
  const pa = a.priority;
  const pb = b.priority;
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  }
  // created_at oldest first; null sorts last (after known timestamps)
  const ca = a.created_at;
  const cb = b.created_at;
  if (ca !== cb) {
    if (ca === null) return 1;
    if (cb === null) return -1;
    const ta = Date.parse(ca);
    const tb = Date.parse(cb);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
      return ta - tb;
    }
    // Fall back to lexicographic compare of the raw timestamps if unparsable.
    if (ca < cb) return -1;
    if (ca > cb) return 1;
  }
  // identifier lexicographic tie-breaker
  if (a.identifier < b.identifier) return -1;
  if (a.identifier > b.identifier) return 1;
  return 0;
}

/** Sort a candidate list by dispatch priority (pure; returns a new array). */
export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort(compareForDispatch);
}

/** Structural validity: the issue carries the required identity fields (§8.2). */
function hasRequiredFields(issue: Issue): boolean {
  return (
    typeof issue.id === "string" &&
    issue.id.length > 0 &&
    typeof issue.identifier === "string" &&
    issue.identifier.length > 0 &&
    typeof issue.title === "string" &&
    issue.title.length > 0 &&
    typeof issue.state === "string" &&
    issue.state.length > 0
  );
}

/**
 * Eligibility check (§8.2 / FR-OR-3). An issue is dispatch-eligible only if it
 * has the required fields; its state is active and not terminal; it is not
 * already running/claimed; a global slot is free; and — for `Todo` — it has no
 * non-terminal blocker. The MVP enforces the GLOBAL slot only (per-state caps
 * are deferred).
 */
export function isEligible(
  issue: Issue,
  state: OrchestratorRuntimeState,
  config: ServiceConfig,
): boolean {
  if (!hasRequiredFields(issue)) return false;

  const active = makeStateSet(config.tracker.active_states);
  const terminal = makeStateSet(config.tracker.terminal_states);
  const stateLower = issue.state.toLowerCase();

  if (!active.has(stateLower)) return false;
  if (terminal.has(stateLower)) return false;
  if (isClaimedOrRunning(state, issue.id)) return false;
  if (noAvailableSlots(state)) return false;

  // Blocker rule for `Todo`: ineligible if any blocker is non-terminal (§8.2).
  if (stateLower === "todo") {
    for (const blocker of issue.blocked_by) {
      if (!isBlockerTerminal(blocker.state, terminal)) return false;
    }
  }

  return true;
}

/** The running daemon handle returned by {@link startOrchestrator}. */
export interface OrchestratorHandle {
  /** Current authoritative runtime state (read-only access for inspection). */
  readonly state: OrchestratorRuntimeState;
  /** Run a single poll tick immediately (used by tests + the scheduler). */
  tick(): Promise<void>;
  /** Stop the loop: cancel the pending tick and prevent reschedules. */
  stop(): void;
}

/**
 * The orchestrator core. Owns the single authoritative runtime state and the
 * poll loop. Construct via {@link createOrchestrator}; start the daemon via
 * {@link startOrchestrator} (or drive `tick()` manually in tests).
 */
export class Orchestrator {
  readonly state: OrchestratorRuntimeState;
  private readonly workflow: WorkflowDefinition;
  private readonly config: ServiceConfig;
  private readonly tracker: TrackerClient;
  private readonly workspace: WorkspaceManager;
  private readonly agent: AgentRunner;
  private readonly logger: Logger;
  private readonly scheduler: Scheduler;
  private readonly now: () => Date;
  private readonly statusOut: (text: string) => void;

  private cancelPending: (() => void) | null = null;
  private stopped = false;
  /** Workspace keys for currently-running issues (for terminal cleanup). */
  private readonly workspaceKeys = new Map<string, string>();

  constructor(options: OrchestratorOptions) {
    this.workflow = options.workflow;
    this.config = options.workflow.service;
    this.tracker = options.tracker;
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.logger = options.logger;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? (() => new Date());
    this.statusOut =
      options.statusOut ?? ((text) => process.stdout.write(`${text}\n`));
    this.state =
      options.state ??
      createRuntimeState(
        this.config.polling.interval_ms,
        this.config.agent.max_concurrent_agents,
      );
  }

  /**
   * Start the daemon: schedule an immediate first tick (delay 0), then repeat at
   * the effective poll interval (§8.1 / FR-OR-2 / NFR-PERF).
   */
  start(): OrchestratorHandle {
    this.stopped = false;
    this.logger.info("orchestrator_started", {
      outcome: "started",
      poll_interval_ms: this.state.poll_interval_ms,
      max_concurrent_agents: this.state.max_concurrent_agents,
    });
    this.scheduleTick(0);
    return this.handle();
  }

  /** Build the external handle for the running daemon. */
  handle(): OrchestratorHandle {
    return {
      state: this.state,
      tick: () => this.tick(),
      stop: () => this.stop(),
    };
  }

  /** Stop the loop: cancel any pending tick and block future reschedules. */
  stop(): void {
    this.stopped = true;
    if (this.cancelPending) {
      this.cancelPending();
      this.cancelPending = null;
    }
    this.logger.info("orchestrator_stopped", { outcome: "stopped" });
  }

  /** Schedule the next tick unless the loop has been stopped. */
  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.cancelPending = this.scheduler.schedule(() => {
      this.cancelPending = null;
      void this.tick().then(
        () => this.scheduleTick(this.state.poll_interval_ms),
        (err) => {
          // A tick should never throw (every step is guarded), but defend the
          // loop so a surprise rejection cannot kill the daemon.
          this.logger.error("tick_unhandled_error", {
            outcome: "failed",
            reason: errorMessage(err),
          });
          this.scheduleTick(this.state.poll_interval_ms);
        },
      );
    }, delayMs);
  }

  /**
   * One poll tick (§8.1 / §16.2). Reconcile always runs first; a per-tick
   * validation failure skips dispatch but reconciliation already happened; a
   * candidate-fetch failure skips the rest of the tick. Never throws.
   */
  async tick(): Promise<void> {
    // 1. Reconcile running issues BEFORE dispatch (§8.1, §16.2/3).
    await this.reconcile();

    // 2. Dispatch preflight validation (§16.2). Failure ⇒ skip dispatch.
    const validation = validateDispatchConfig(this.workflow);
    if (!validation.ok) {
      this.logger.error("dispatch_preflight_failed", {
        outcome: "failed",
        reason: validation.errors.join("; "),
      });
      this.notify();
      return;
    }

    // 3. Fetch candidate issues (§16.2). Failure ⇒ tracker returns [] (skip-tick).
    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch (err) {
      // The U2 adapter never throws, but defend the loop regardless.
      this.logger.error("candidate_fetch_threw", {
        outcome: "failed",
        reason: errorMessage(err),
      });
      this.notify();
      return;
    }

    // 4. Sort + dispatch while global slots remain (§16.2).
    const sorted = sortForDispatch(candidates);
    for (const issue of sorted) {
      if (noAvailableSlots(this.state)) break;
      if (!isEligible(issue, this.state, this.config)) continue;
      await this.dispatch(issue);
    }

    // 5. Notify observers / render status (§16.2 step 6).
    this.notify();
  }

  /**
   * Reconcile running issues (§8.5 Part B / §16.3). Refreshes tracker states for
   * all running ids; terminal ⇒ stop worker + clean workspace; still-active ⇒
   * update snapshot; neither active nor terminal ⇒ stop worker without cleanup;
   * refresh failure ⇒ keep workers running (the U2 adapter yields [] on failure,
   * which naturally encodes "keep workers"). Stall detection (Part A) is deferred.
   */
  private async reconcile(): Promise<void> {
    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) return;

    let refreshed;
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch (err) {
      // Defensive: a refresh failure keeps workers running (FR-OR-8 Part B).
      this.logger.warn("reconcile_refresh_threw", {
        outcome: "failed",
        reason: errorMessage(err),
      });
      return;
    }

    // No states resolved (e.g. refresh failure ⇒ []): keep workers (§16.3).
    if (refreshed.length === 0) {
      this.logger.debug("reconcile_keep_workers", {
        outcome: "skipped",
        reason: "no refreshed states",
        running: runningIds.length,
      });
      return;
    }

    const active = makeStateSet(this.config.tracker.active_states);
    const terminal = makeStateSet(this.config.tracker.terminal_states);

    for (const ref of refreshed) {
      const entry = this.state.running.get(ref.id);
      if (!entry) continue;
      const stateLower = ref.state.toLowerCase();
      const log = this.logger.forIssue({
        issue_id: entry.issue_id,
        issue_identifier: entry.issue_identifier,
      });

      if (terminal.has(stateLower)) {
        log.info("reconcile_terminal", {
          outcome: "stopped",
          state: ref.state,
        });
        await this.terminateRunning(ref.id, { cleanupWorkspace: true });
      } else if (active.has(stateLower)) {
        updateRunningState(this.state, ref.id, ref.state);
        log.debug("reconcile_active", { outcome: "updated", state: ref.state });
      } else {
        log.info("reconcile_non_active", {
          outcome: "stopped",
          state: ref.state,
        });
        await this.terminateRunning(ref.id, { cleanupWorkspace: false });
      }
    }
  }

  /**
   * Stop a running worker and release its claim (§16.3 terminate). Optionally
   * requests workspace cleanup (U4) for terminal issues. Marks the issue
   * completed for bookkeeping. Idempotent.
   */
  private async terminateRunning(
    issueId: string,
    opts: { cleanupWorkspace: boolean },
  ): Promise<void> {
    const entry = releaseRunning(this.state, issueId);
    if (!entry) return;
    markCompleted(this.state, issueId);
    const key = this.workspaceKeys.get(issueId);
    this.workspaceKeys.delete(issueId);

    if (opts.cleanupWorkspace && key) {
      try {
        await this.workspace.removeWorkspace(key);
      } catch (err) {
        this.logger.warn("workspace_cleanup_failed", {
          issue_id: entry.issue_id,
          issue_identifier: entry.issue_identifier,
          outcome: "failed",
          reason: errorMessage(err),
        });
      }
    }
  }

  /**
   * Dispatch ONE issue (§16.4): ensure a sanitized workspace (U4), record the
   * running entry + claim (single authority), render the prompt (U1), and launch
   * the agent (U4) once. The worker runs asynchronously; on exit the running
   * entry is removed so the issue can be re-picked next poll (MVP: no retry
   * timer). A workspace/prep failure releases the claim immediately.
   */
  private async dispatch(issue: Issue): Promise<void> {
    const log = this.logger.forIssue({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });

    // Prepare the sanitized workspace (enforces safety invariants b + c).
    let workspace: Workspace;
    try {
      workspace = await this.workspace.ensureWorkspace(issue);
    } catch (err) {
      log.error("dispatch_workspace_failed", {
        outcome: "failed",
        reason: errorMessage(err),
      });
      return;
    }

    // Single-authority claim + running entry (§16.4). After this point the issue
    // is reserved and cannot be dispatched again until the worker exits.
    recordRunning(this.state, {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt: null,
      workspace_path: workspace.path,
      started_at: this.now().toISOString(),
      last_state: issue.state,
    });
    this.workspaceKeys.set(issue.id, workspace.workspace_key);

    // Render the first-turn prompt (U1 strict renderer). A render failure fails
    // the attempt: release the claim so the issue is re-evaluated next poll.
    let prompt: string;
    try {
      prompt = renderPrompt(this.workflow.prompt_template, issue, null);
    } catch (err) {
      log.error("dispatch_prompt_failed", {
        outcome: "failed",
        reason: errorMessage(err),
      });
      this.onWorkerExit(issue.id, false, "prompt render failed");
      return;
    }

    log.info("dispatch", {
      outcome: "dispatched",
      workspace_path: workspace.path,
      created_now: workspace.created_now,
    });

    // Launch the agent ONCE (high-trust). The worker runs to completion
    // asynchronously; we do not await it so the tick can keep dispatching while
    // slots remain. Worker exit removes the running entry.
    void this.agent
      .run({ issue, attempt: null, workspace, prompt }, (event) =>
        this.onAgentEvent(issue.id, event),
      )
      .then(
        (result) => {
          this.onWorkerExit(issue.id, result.ok, result.error ?? null);
        },
        (err) => {
          this.onWorkerExit(issue.id, false, errorMessage(err));
        },
      );
  }

  /**
   * Fold an agent event into the running-entry snapshot (session id / turn
   * count). Pure bookkeeping; never throws.
   */
  private onAgentEvent(issueId: string, event: AgentEvent): void {
    switch (event.type) {
      case "session_started":
        if (event.session_id) setSessionId(this.state, issueId, event.session_id);
        break;
      case "turn_completed":
        incrementTurnCount(this.state, issueId);
        break;
      default:
        break;
    }
  }

  /**
   * Worker exit (§16.6, MVP-simplified). Remove the running entry + release the
   * claim and mark the issue completed for bookkeeping. The MVP does NOT schedule
   * a retry timer — the issue is simply re-evaluated on the next poll. Workspaces
   * are preserved on exit (terminal cleanup happens during reconciliation).
   */
  private onWorkerExit(
    issueId: string,
    ok: boolean,
    error: string | null,
  ): void {
    const entry = releaseRunning(this.state, issueId);
    this.workspaceKeys.delete(issueId);
    markCompleted(this.state, issueId);
    if (!entry) return;
    const log = this.logger.forIssue({
      issue_id: entry.issue_id,
      issue_identifier: entry.issue_identifier,
    });
    if (ok) {
      log.info("worker_exit", { outcome: "completed" });
    } else {
      log.warn("worker_exit", {
        outcome: "failed",
        reason: error ?? "agent attempt failed",
      });
    }
  }

  /** Render the terminal status surface from state only (U5; §13.4). */
  private notify(): void {
    try {
      const text = renderStatus(this.state, { now: this.now().toISOString() });
      this.statusOut(text);
    } catch {
      // Status rendering is never required for correctness (§13.4).
    }
  }
}

/** Factory: construct an orchestrator from its dependencies. */
export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  return new Orchestrator(options);
}

/**
 * Construct and START the orchestrator daemon (immediate first tick + repeating
 * schedule). Returns the running handle.
 */
export function startOrchestrator(
  options: OrchestratorOptions,
): OrchestratorHandle {
  return createOrchestrator(options).start();
}
