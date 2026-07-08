/**
 * Orchestrator — the integrating spine (Symphony spec §7, §8, §16 / Unit 1.7).
 *
 * Owns the single authoritative in-memory {@link OrchestratorRuntimeState} and
 * runs one fixed-interval poll loop:
 *
 *   startup → immediate tick → { reconcile → preflight → fetch → sort → dispatch }
 *           → reschedule(poll_interval_ms) → … → graceful shutdown
 *
 * Design commitments for this unit:
 *   - **Immediate first tick** (FR6): the loop schedules the first tick at delay 0.
 *   - **Single authority** (FR9): {@link dispatch} mutates `running`/`claimed`
 *     SYNCHRONOUSLY, before it awaits anything, so no interleaving can dispatch
 *     the same issue twice. Workers run detached; the tick never awaits them.
 *   - **Terminal reconciliation** (FR17): every tick refreshes running issues and
 *     stops any that reached a `terminal_states` value, cleaning its workspace.
 *   - **Reliability** (NFR): a tracker/refresh failure skips only that tick (or
 *     keeps workers) and the daemon survives; an unexpected error in a tick is
 *     caught so the loop keeps running; observability calls never propagate.
 *
 * Deferred (PRD §5.3, intentionally absent): retry/backoff, continuation retries,
 * the retry queue, per-state concurrency caps, stall detection, and the startup
 * terminal-workspace cleanup sweep. Persistence across restarts is permanently
 * out (§5.4) — all scheduler state is in-memory.
 */

import type {
  Issue,
  OrchestratorRuntimeState,
  RunningEntry,
  ServiceConfig,
} from "../domain/types.js";
import { createRuntimeState } from "../domain/types.js";
import type {
  AgentRunner,
  Logger,
  RunAttempt,
  StatusSurface,
  TrackerClient,
  WorkspaceManager,
} from "../domain/interfaces.js";
import { preflightConfig } from "../config/preflight.js";
import { noAvailableSlots } from "./concurrency.js";
import { shouldDispatch } from "./eligibility.js";
import { sortForDispatch } from "./sort.js";
import { stateIn } from "./state-sets.js";

/** Opaque timer handle so the scheduler can be injected in tests. */
export type TimerHandle = unknown;

/** Dependencies for {@link createOrchestrator}. */
export interface OrchestratorDeps {
  config: ServiceConfig;
  tracker: TrackerClient;
  workspaceManager: WorkspaceManager;
  agentRunner: AgentRunner;
  logger: Logger;
  /** Optional terminal status surface; OPTIONAL per §13.4 and never load-bearing. */
  status?: StatusSurface;
  /** Injectable timer (tests). Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable timer cancel (tests). Defaults to `clearTimeout`. */
  clearTimer?: (handle: TimerHandle) => void;
  /** Injectable clock for deterministic `started_at`. Defaults to `Date`. */
  now?: () => Date;
}

/** How a running issue was terminated during reconciliation. */
interface TerminateOptions {
  cleanupWorkspace: boolean;
  reason: "terminal" | "inactive";
}

/** A run attempt result that may carry the derived coding-agent session id (§10.2). */
type MaybeSessionResult = RunAttempt & { session_id?: string };

/**
 * The orchestrator instance. Constructed via {@link createOrchestrator}; the
 * lifecycle is `start()` → (runs autonomously) → `stop()`. Individual phases
 * (`tick`, `reconcile`) are public so tests and the e2e smoke can drive them
 * deterministically without real timers.
 */
export class Orchestrator {
  private readonly config: ServiceConfig;
  private readonly tracker: TrackerClient;
  private readonly workspaceManager: WorkspaceManager;
  private readonly agentRunner: AgentRunner;
  private readonly logger: Logger;
  private readonly status?: StatusSurface;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly now: () => Date;

  private readonly state: OrchestratorRuntimeState;
  /** In-flight worker promises keyed by issue id (for graceful shutdown). */
  private readonly workers = new Map<string, Promise<void>>();

  private started = false;
  private stopped = false;
  private tickTimer: TimerHandle | null = null;
  private currentTick: Promise<void> | null = null;

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.tracker = deps.tracker;
    this.workspaceManager = deps.workspaceManager;
    this.agentRunner = deps.agentRunner;
    this.logger = deps.logger;
    this.status = deps.status;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? (() => new Date());
    this.state = createRuntimeState(this.config);
  }

  /** Read-only view of the authoritative runtime state (tests / status / smoke). */
  getState(): OrchestratorRuntimeState {
    return this.state;
  }

  /** Number of issues currently running. */
  runningCount(): number {
    return this.state.running.size;
  }

  /* ----------------------------------------------------------------------- *
   * Lifecycle (§16.1 startup, graceful shutdown).
   * ----------------------------------------------------------------------- */

  /** Start the poll loop with an immediate first tick (§16.1, FR6). Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.logger.info("orchestrator started", {
      action: "startup",
      poll_interval_ms: this.state.poll_interval_ms,
      max_concurrent_agents: this.state.max_concurrent_agents,
    });
    this.scheduleTick(0); // immediate first tick
  }

  /**
   * Stop the loop and drain gracefully (FR20): cancel the pending tick, await any
   * in-flight tick, then await outstanding workers so nothing is torn down mid-run.
   * Idempotent and safe to call from a signal handler.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tickTimer !== null) {
      this.clearTimer(this.tickTimer);
      this.tickTimer = null;
    }
    this.logger.info("orchestrator stopping", { action: "shutdown" });
    if (this.currentTick !== null) {
      try {
        await this.currentTick;
      } catch {
        /* a crashed tick is already logged by safeTick; ignore here. */
      }
    }
    const pending = [...this.workers.values()];
    if (pending.length > 0) {
      this.logger.info("awaiting in-flight workers", { action: "shutdown", count: pending.length });
      await Promise.allSettled(pending);
    }
    this.notifyObservers();
    this.logger.info("orchestrator stopped", { action: "shutdown", outcome: "clean" });
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.tickTimer = this.setTimer(() => {
      void this.runTickAndReschedule();
    }, delayMs);
  }

  private async runTickAndReschedule(): Promise<void> {
    this.tickTimer = null;
    if (this.stopped) return;
    this.currentTick = this.safeTick();
    await this.currentTick;
    this.currentTick = null;
    if (!this.stopped) this.scheduleTick(this.state.poll_interval_ms);
  }

  /** Wrap {@link tick} so an unexpected error never kills the loop (NFR reliability). */
  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.logger.error("tick failed (recovered; loop continues)", {
        action: "tick",
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /* ----------------------------------------------------------------------- *
   * Tick (§16.2 poll-and-dispatch).
   * ----------------------------------------------------------------------- */

  /**
   * One poll-and-dispatch tick (§16.2): reconcile, validate, fetch candidates,
   * sort, and dispatch while slots remain. A failed preflight or a tracker error
   * skips dispatch for this tick only; reconciliation has already run.
   */
  async tick(): Promise<void> {
    // 1. Reconcile running issues first (§8.1 step 1) — always, even if dispatch is skipped.
    await this.reconcile();

    // 2. Dispatch preflight (§8.1 step 2 / §6.3). On failure, skip dispatch this tick.
    const preflight = preflightConfig(this.config);
    if (!preflight.ok) {
      this.logger.error("dispatch preflight failed; skipping dispatch this tick", {
        action: "preflight",
        errors: preflight.errors,
      });
      this.notifyObservers();
      return;
    }

    // 3. Fetch candidates (§8.1 step 3). A tracker failure skips the tick; the daemon survives.
    let issues: Issue[];
    try {
      issues = await this.tracker.fetchCandidateIssues();
    } catch (error) {
      this.logger.warn("candidate fetch failed; skipping dispatch this tick", {
        action: "fetch_candidates",
        error: (error as Error)?.message ?? String(error),
      });
      this.notifyObservers();
      return;
    }

    // 4 + 5. Sort (§8.2) and dispatch while global slots remain (§8.3).
    for (const issue of sortForDispatch(issues)) {
      if (noAvailableSlots(this.state)) break;
      if (shouldDispatch(issue, this.state, this.config)) {
        this.dispatch(issue, null);
      }
    }

    // 6. Notify observability/status consumers (§8.1 step 6).
    this.notifyObservers();
  }

  /* ----------------------------------------------------------------------- *
   * Reconciliation (§16.3 / §8.5 Part B). Stall detection (Part A) is deferred.
   * ----------------------------------------------------------------------- */

  /**
   * Refresh the tracker state of every running issue and stop those that reached a
   * terminal (workspace cleaned) or otherwise-inactive (workspace kept) state
   * (FR17). If the refresh fails, keep all workers and retry next tick (§8.5).
   */
  async reconcile(): Promise<void> {
    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch (error) {
      this.logger.debug("state refresh failed; keeping workers running", {
        action: "reconcile",
        error: (error as Error)?.message ?? String(error),
      });
      return;
    }

    for (const issue of refreshed) {
      if (!this.state.running.has(issue.id)) continue; // worker exited between fetch and here
      if (stateIn(issue.state, this.config.tracker.terminal_states)) {
        await this.terminate(issue.id, { cleanupWorkspace: true, reason: "terminal" });
      } else if (stateIn(issue.state, this.config.tracker.active_states)) {
        // Still active: keep the worker. (In-memory issue-snapshot update deferred.)
        this.logger.debug("running issue still active", {
          action: "reconcile",
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
      } else {
        // Neither active nor terminal: stop the worker but keep the workspace (§8.5).
        await this.terminate(issue.id, { cleanupWorkspace: false, reason: "inactive" });
      }
    }
  }

  /** Stop a running issue: drop it from authoritative state and optionally clean its workspace. */
  private async terminate(issueId: string, options: TerminateOptions): Promise<void> {
    const entry = this.state.running.get(issueId);
    if (entry === undefined) return;

    this.state.running.delete(issueId);
    this.state.claimed.delete(issueId);
    // Stop awaiting the now-orphaned worker; it settles on its own but no longer gates shutdown.
    this.workers.delete(issueId);
    this.status?.remove(entry.issue_identifier);

    this.logger.info("run stopped by reconciliation", {
      issue_id: entry.issue_id,
      issue_identifier: entry.issue_identifier,
      action: "reconcile_terminate",
      outcome: options.reason,
    });

    if (options.cleanupWorkspace) {
      try {
        await this.workspaceManager.remove(entry.issue_identifier);
      } catch (error) {
        this.logger.debug("workspace cleanup failed (ignored)", {
          issue_identifier: entry.issue_identifier,
          action: "reconcile_cleanup",
          error: (error as Error)?.message ?? String(error),
        });
      }
    }
  }

  /* ----------------------------------------------------------------------- *
   * Dispatch (§16.4). Synchronous state mutation is the single authority (FR9).
   * ----------------------------------------------------------------------- */

  /**
   * Claim an issue and launch its worker. All authoritative mutations happen
   * SYNCHRONOUSLY before any await, so a second dispatch of the same issue — from
   * this tick or a re-entrant one — is impossible (FR9). The worker runs detached;
   * the caller (the tick) does not await it.
   */
  dispatch(issue: Issue, attempt: number | null): void {
    const entry: RunningEntry = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      workspace_path: this.workspaceManager.workspacePathFor(issue.identifier),
      started_at: this.now().toISOString(),
      session: null,
    };

    // --- single authority: reserve the slot before doing anything async ---
    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.state.retry_attempts.delete(issue.id);

    this.status?.upsert({ issue_identifier: issue.identifier, phase: "running" });
    this.logger.info("issue dispatched", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      action: "dispatch",
      attempt,
    });

    const worker = this.runWorker(issue, attempt);
    this.workers.set(issue.id, worker);
  }

  /** Run one agent attempt and record its exit. Errors are swallowed into a failed exit. */
  private async runWorker(issue: Issue, attempt: number | null): Promise<void> {
    try {
      const result = (await this.agentRunner.run(issue, attempt)) as MaybeSessionResult;
      if (this.state.running.has(issue.id)) {
        this.status?.upsert({
          issue_identifier: issue.identifier,
          session_id: result.session_id,
          phase: result.status,
        });
      }
      this.logger.info("worker finished", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        session_id: result.session_id,
        action: "worker_exit",
        outcome: result.status,
      });
    } catch (error) {
      this.logger.warn("worker errored", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        action: "worker_exit",
        outcome: "error",
        error: (error as Error)?.message ?? String(error),
      });
    } finally {
      this.onWorkerExit(issue.id);
    }
  }

  /**
   * Worker-exit bookkeeping (§16.6, retry-free subset). Idempotent: if reconciliation
   * already terminated the run, this is a no-op. Continuation/retry scheduling is
   * deferred (PRD §5.3), so a clean exit simply releases the claim; if the issue is
   * still active, the next tick may re-dispatch it.
   */
  private onWorkerExit(issueId: string): void {
    this.workers.delete(issueId);
    const entry = this.state.running.get(issueId);
    if (entry === undefined) return; // already terminated by reconciliation
    this.state.running.delete(issueId);
    this.state.claimed.delete(issueId);
    this.state.completed.add(issueId); // bookkeeping only (§16.6)
    this.status?.remove(entry.issue_identifier);
  }

  /* ----------------------------------------------------------------------- *
   * Observability. Status rendering/printing failures MUST NOT crash the daemon.
   * ----------------------------------------------------------------------- */

  private notifyObservers(): void {
    try {
      this.status?.print();
    } catch (error) {
      // §13.4: a broken status surface is never load-bearing.
      this.logger.debug("status print failed (ignored)", {
        action: "notify_observers",
        error: (error as Error)?.message ?? String(error),
      });
    }
  }
}

/** Create an {@link Orchestrator} bound to `deps`. */
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  return new Orchestrator(deps);
}
