/**
 * Terminal status surface — Symphony spec §13.4 "OPTIONAL Human-Readable Status
 * Surface". Implements the `StatusSurface` port from ARK-58.
 *
 * §13.4 sets two constraints that shape the whole module: the surface SHOULD draw
 * from orchestrator state only, and it MUST NOT be REQUIRED for correctness. Both
 * are enforced structurally rather than trusted:
 *
 *   - **State only.** {@link formatStatusLine} is a pure function of
 *     `OrchestratorState` plus a clock. It reads no tracker, touches no
 *     filesystem, and holds no counters of its own, so the surface can never
 *     disagree with the scheduler or keep the daemon alive on a stray timer.
 *
 *   - **Never load-bearing.** `render` and `stop` swallow their own failures. A
 *     closed pipe, a `SIGWINCH` mid-write, or a terminal that vanished must not
 *     propagate into the poll loop — the §13.4 guarantee is worth more than the
 *     one dropped frame.
 *
 * §13.3's richer snapshot (`turn_count`, `codex_totals`, `rate_limits`) and §13.5's
 * token and runtime accounting are deliberately absent: this ticket's out-of-scope
 * list defers them to the later Core Conformance pass, and §13.7's HTTP dashboard
 * is permanently out per decision D2.
 */

import type { OrchestratorState, RunningEntry, StatusSurface } from "../domain/index.js";

import type { SecretRegistry } from "./redact.js";
import type { WritableLike } from "./logger.js";

/** Entries listed before the line collapses into a `+N more` tail. */
const DEFAULT_MAX_ENTRIES = 6;

/** Assumed terminal width when the stream does not report one. */
const DEFAULT_WIDTH = 120;

/** Separator between status segments. */
const SEP = " · ";

/**
 * Render an elapsed span compactly: `12s`, `3m12s`, `2h04m`, `3d02h`.
 *
 * Fixed-width-ish on purpose — the status line is redrawn in place, and a duration
 * that changes length every second makes the whole line jitter.
 */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));

  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;

  const days = Math.floor(hours / 24);
  return `${days}d${String(hours % 24).padStart(2, "0")}h`;
}

/** Options for {@link formatStatusLine}. */
export interface StatusLineOptions {
  /** Clock seam, for deterministic tests. Default `() => new Date()`. */
  now?: () => Date;
  /** Entries listed before collapsing to `+N more`. Default `6`. */
  maxEntries?: number;
  /** Column budget for the line. Default the stream's width, else `120`. */
  width?: number;
  /** Secret literals to scrub from the rendered line (§15.3). */
  secrets?: SecretRegistry;
}

/** Elapsed milliseconds for one run, or `null` when `started_at` is unusable. */
function elapsedMs(entry: RunningEntry, now: Date): number | null {
  const started = Date.parse(entry.started_at);
  if (Number.isNaN(started)) return null;
  return now.getTime() - started;
}

/** One run rendered as `ARK-60 In Progress 3m12s`. */
function formatEntry(entry: RunningEntry, now: Date): string {
  const parts = [entry.issue_identifier || entry.issue_id || "?"];
  if (entry.dispatch_state) parts.push(entry.dispatch_state);

  const elapsed = elapsedMs(entry, now);
  if (elapsed !== null) parts.push(formatDuration(elapsed));

  if (entry.attempt !== null && entry.attempt !== undefined) {
    parts.push(`try${entry.attempt}`);
  }
  return parts.join(" ");
}

/**
 * Build the status line for a snapshot of orchestrator state (FR19).
 *
 * Pure and total: any shape of `state` yields a string, because the §13.4
 * guarantee means this must not be the thing that throws.
 */
export function formatStatusLine(
  state: OrchestratorState,
  options: StatusLineOptions = {},
): string {
  const now = (options.now ?? (() => new Date()))();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const width = options.width ?? DEFAULT_WIDTH;

  const running = Object.values(state.running ?? {});
  const limit = state.max_concurrent_agents;
  const completed = state.completed?.size ?? 0;
  // `claimed` covers running plus reserved-and-awaiting-retry, so the difference
  // is what is spoken for but not yet executing.
  const queued = Math.max(0, (state.claimed?.size ?? 0) - running.length);

  const head =
    running.length === 0
      ? `○ idle ${SEP.trim()} 0/${limit} running`
      : `● ${running.length}/${limit} running`;

  const tail: string[] = [];
  if (queued > 0) tail.push(`${queued} queued`);
  if (completed > 0) tail.push(`${completed} done`);
  if (running.length === 0) {
    tail.push(`poll ${formatDuration(state.poll_interval_ms)}`);
  }

  // Oldest first, so an entry keeps its position between redraws instead of
  // shuffling as the `running` record is rebuilt.
  const ordered = [...running].sort((a, b) =>
    String(a.started_at).localeCompare(String(b.started_at)),
  );

  const segments = ordered.map((entry) => formatEntry(entry, now));
  const assemble = (shown: string[], hidden: number): string => {
    const all = [head, ...shown];
    if (hidden > 0) all.push(`+${hidden} more`);
    all.push(...tail);
    return all.join(SEP);
  };

  let shown = segments.slice(0, maxEntries);
  let hidden = segments.length - shown.length;
  let line = assemble(shown, hidden);

  // Drop entries until the line fits. The counts in `head` and `tail` stay, so a
  // narrow terminal loses detail but never the summary.
  while (line.length > width && shown.length > 0) {
    shown = shown.slice(0, -1);
    hidden = segments.length - shown.length;
    line = assemble(shown, hidden);
  }

  return options.secrets ? options.secrets.scrub(line) : line;
}

/** Options for {@link createStatusSurface}. */
export interface StatusSurfaceOptions extends StatusLineOptions {
  /** Destination. Default `process.stderr`, so stdout stays free for data. */
  stream?: WritableLike;
  /**
   * Redraw one line in place instead of appending. Defaults to the stream's
   * `isTTY`: a console gets a live line, a pipe or file gets one line per render
   * so the history stays readable.
   */
  inPlace?: boolean;
}

/** Erase the current terminal line and return the cursor to column 0. */
const CLEAR_LINE = "\r[2K";

/**
 * Status surface that renders {@link formatStatusLine} to a stream.
 *
 * Holds no timer: rendering is driven by the orchestrator's own poll tick, so the
 * surface cannot keep the process alive or tick while the daemon is wedged — an
 * unmoving status line is itself the useful signal.
 */
class TerminalStatusSurface implements StatusSurface {
  readonly #stream: WritableLike;
  readonly #options: StatusLineOptions;
  readonly #inPlace: boolean;
  #linePending = false;
  #stopped = false;

  constructor(options: StatusSurfaceOptions) {
    this.#stream = options.stream ?? process.stderr;
    this.#inPlace = options.inPlace ?? Boolean(this.#stream.isTTY);
    this.#options = {
      now: options.now,
      maxEntries: options.maxEntries,
      width: options.width ?? this.#stream.columns,
      secrets: options.secrets,
    };
  }

  render(state: OrchestratorState): void {
    if (this.#stopped) return;
    try {
      const line = formatStatusLine(state, {
        ...this.#options,
        // Re-read the width every frame: terminals get resized mid-run.
        width: this.#options.width ?? this.#stream.columns,
      });

      if (this.#inPlace) {
        this.#stream.write(`${CLEAR_LINE}${line}`);
        this.#linePending = true;
      } else {
        this.#stream.write(`${line}\n`);
      }
    } catch {
      // §13.4: the status surface MUST NOT be required for correctness.
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      // Close the in-place line so whatever prints next starts on a fresh row
      // instead of overwriting the last frame.
      if (this.#linePending) {
        this.#stream.write("\n");
        this.#linePending = false;
      }
    } catch {
      // Nothing useful to do while shutting down.
    }
  }
}

/** Create a {@link StatusSurface} (the ARK-58 port) over a stream. */
export function createStatusSurface(
  options: StatusSurfaceOptions = {},
): StatusSurface {
  return new TerminalStatusSurface(options);
}

/** A status surface that renders nothing. For tests and headless runs. */
export function nullStatusSurface(): StatusSurface {
  return {
    render() {
      /* intentionally silent */
    },
    stop() {
      /* intentionally silent */
    },
  };
}
