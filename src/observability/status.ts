/**
 * Terminal status surface (Symphony spec §13.4, FR19).
 *
 * A minimal, human-readable surface that reflects the set of currently-active
 * runs. Per §13.4 it draws only from orchestrator state and is NOT required for
 * correctness — so `print` swallows any stream failure rather than propagating it.
 *
 * Runs are keyed by `issue_identifier`; `upsert` replaces in place (preserving
 * insertion order) and `remove` drops. `render` produces a single status line.
 */

import type { ActiveRun, StatusSurface } from "../domain/interfaces.js";

export interface StatusOptions {
  /** Stream the status line is written to. Defaults to stdout. */
  stream?: { write(chunk: string): unknown };
  /** Prefix label for the status line. */
  label?: string;
}

/** Render one active run as `IDENTIFIER[:session][ (phase)]`. */
function renderRun(run: ActiveRun): string {
  let s = run.issue_identifier;
  if (run.session_id) s += `:${run.session_id}`;
  if (run.phase) s += ` (${run.phase})`;
  return s;
}

/**
 * Create a {@link StatusSurface}. Concrete implementation of the §13.4 port.
 * State is an insertion-ordered map keyed by `issue_identifier`.
 */
export function createStatusSurface(options: StatusOptions = {}): StatusSurface {
  const stream = options.stream ?? process.stdout;
  const label = options.label ?? "status";
  const runs = new Map<string, ActiveRun>();

  function render(): string {
    if (runs.size === 0) return `[${label}] 0 active`;
    const rendered = [...runs.values()].map(renderRun).join(", ");
    return `[${label}] ${runs.size} active: ${rendered}`;
  }

  return {
    upsert(run: ActiveRun): void {
      runs.set(run.issue_identifier, run);
    },
    remove(issueIdentifier: string): void {
      runs.delete(issueIdentifier);
    },
    activeRuns(): ActiveRun[] {
      return [...runs.values()];
    },
    render,
    print(): void {
      // §13.4: the status surface must not be required for correctness.
      try {
        stream.write(`${render()}\n`);
      } catch {
        /* swallow — a broken status stream must never crash the orchestrator */
      }
    },
  };
}
