/**
 * Retry & backoff (Symphony spec §8.4 + §16.6 / ARK-56).
 *
 * A **failed** agent run must be retried instead of dropped. This module owns the
 * two mechanical pieces that the orchestrator wires into its tick/worker loop:
 *
 *   1. {@link computeBackoffMs} — the exponential-backoff delay for a failed run.
 *   2. {@link RetryQueue} — an in-memory, per-issue retry queue with at most one
 *      live timer per issue. It operates directly on the orchestrator's
 *      authoritative `retry_attempts` map so state stays single-authority (§4.1.8):
 *      the queue is a thin scheduler over that map, never a second copy.
 *
 * The queue is intentionally in-memory only (§5.4): no timer survives a restart.
 * The *decision* of what to do when a retry is due (fetch candidates, drop on
 * terminal/missing, re-dispatch, or requeue) lives in the orchestrator (§16.6);
 * this module only fires the `onDue` callback when a scheduled retry matures.
 */

import type { Logger } from "../domain/interfaces.js";
import type { RetryEntry } from "../domain/types.js";

/** Opaque timer handle so the scheduler can be injected in tests. */
export type TimerHandle = unknown;

/**
 * Failure-driven backoff base (ms). Per the ARK-56 ticket the base is ~1000ms
 * (`delay = min(base * 2^(attempt-1), cap)`); this overrides the spec §8.4
 * example value of `10000`, which the ticket restates with a 1000ms base.
 */
export const DEFAULT_RETRY_BASE_MS = 1000;

/**
 * Exponential backoff for a failed run (§8.4):
 *
 *   `delay = min(base * 2^(attempt - 1), capMs)`
 *
 * `attempt` is 1-based (attempt 1 → `base`, attempt 2 → `base*2`, …). Values
 * below 1 are clamped to 1 so the first retry always waits exactly `base`. A huge
 * `attempt` that would overflow `2^(attempt-1)` to `Infinity` saturates at the cap.
 */
export function computeBackoffMs(
  attempt: number,
  capMs: number,
  baseMs: number = DEFAULT_RETRY_BASE_MS,
): number {
  const a = Math.max(1, Math.floor(attempt));
  const cap = Math.max(0, capMs);
  const raw = baseMs * 2 ** (a - 1);
  if (!Number.isFinite(raw)) return cap; // overflow → saturate at the cap
  return Math.min(raw, cap);
}

/** Dependencies for {@link RetryQueue}. */
export interface RetryQueueDeps {
  /** The orchestrator's authoritative `state.retry_attempts` map (single authority). */
  entries: Map<string, RetryEntry>;
  /** Cap for the backoff formula (`agent.max_retry_backoff_ms`). */
  maxBackoffMs: number;
  /** Backoff base; defaults to {@link DEFAULT_RETRY_BASE_MS}. */
  baseMs?: number;
  /** Fired when a scheduled retry becomes due. */
  onDue: (issueId: string) => void;
  /** Injectable timer (tests). */
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable timer cancel (tests). */
  clearTimer: (handle: TimerHandle) => void;
  /** Injectable monotonic clock (ms) for `due_at_ms`. */
  now: () => number;
  logger: Logger;
}

/** Inputs to {@link RetryQueue.schedule}. */
export interface ScheduleInput {
  issueId: string;
  /** Best-effort human ID for status surfaces/logs. */
  identifier: string | null;
  /** 1-based retry attempt this schedule is for. */
  attempt: number;
  /** Why the retry was scheduled (agent error, no slots, …). */
  error: string | null;
}

/**
 * In-memory retry queue keyed by issue id. Guarantees **one live timer per issue**:
 * {@link schedule} cancels any existing timer before arming a new one, so a
 * re-schedule never leaves two timers racing to re-dispatch the same issue.
 */
export class RetryQueue {
  private readonly entries: Map<string, RetryEntry>;
  private readonly maxBackoffMs: number;
  private readonly baseMs: number;
  private readonly onDue: (issueId: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(deps: RetryQueueDeps) {
    this.entries = deps.entries;
    this.maxBackoffMs = deps.maxBackoffMs;
    this.baseMs = deps.baseMs ?? DEFAULT_RETRY_BASE_MS;
    this.onDue = deps.onDue;
    this.setTimer = deps.setTimer;
    this.clearTimer = deps.clearTimer;
    this.now = deps.now;
    this.logger = deps.logger;
  }

  /**
   * Schedule (or re-schedule) a retry for `issueId`. Cancels any prior timer for
   * the same issue first (§8.4: "Cancel any existing retry timer for the same
   * issue"), computes the backoff delay, arms a new timer, and records the entry
   * in the authoritative map. Returns the stored {@link RetryEntry}.
   */
  schedule(input: ScheduleInput): RetryEntry {
    this.cancel(input.issueId); // exactly one timer per issue at a time

    const delayMs = computeBackoffMs(input.attempt, this.maxBackoffMs, this.baseMs);
    const dueAtMs = this.now() + delayMs;
    const timerHandle = this.setTimer(() => this.onDue(input.issueId), delayMs);

    const entry: RetryEntry = {
      issue_id: input.issueId,
      identifier: input.identifier,
      attempt: input.attempt,
      due_at_ms: dueAtMs,
      timer_handle: timerHandle,
      error: input.error,
    };
    this.entries.set(input.issueId, entry);

    this.logger.info("retry scheduled", {
      issue_id: input.issueId,
      issue_identifier: input.identifier ?? undefined,
      action: "retry_schedule",
      attempt: input.attempt,
      delay_ms: delayMs,
      due_at_ms: dueAtMs,
      error: input.error ?? undefined,
    });
    return entry;
  }

  /**
   * Cancel a scheduled retry: clear its timer and drop it from the map. Returns
   * `true` if an entry was present. Safe to call when none exists.
   */
  cancel(issueId: string): boolean {
    const entry = this.entries.get(issueId);
    if (entry === undefined) return false;
    if (entry.timer_handle != null) {
      try {
        this.clearTimer(entry.timer_handle);
      } catch {
        /* a broken clearTimer must not wedge the scheduler */
      }
    }
    this.entries.delete(issueId);
    return true;
  }

  /** Cancel every scheduled retry (graceful shutdown — no timer outlives the daemon). */
  cancelAll(): void {
    for (const issueId of [...this.entries.keys()]) this.cancel(issueId);
  }

  /**
   * Remove and return the entry for `issueId` **without** clearing its timer — for
   * the due handler, whose timer has already fired. Returns `undefined` if absent
   * (e.g. the retry was cancelled between firing and handling).
   */
  take(issueId: string): RetryEntry | undefined {
    const entry = this.entries.get(issueId);
    if (entry === undefined) return undefined;
    this.entries.delete(issueId);
    return entry;
  }

  /** Whether a retry is currently scheduled for `issueId`. */
  has(issueId: string): boolean {
    return this.entries.has(issueId);
  }

  /** The scheduled entry for `issueId`, if any. */
  get(issueId: string): RetryEntry | undefined {
    return this.entries.get(issueId);
  }

  /** Number of scheduled retries. */
  size(): number {
    return this.entries.size;
  }

  /** Snapshot of scheduled retries (for the status surface / summary view §13.5). */
  snapshot(): RetryEntry[] {
    return [...this.entries.values()];
  }
}
