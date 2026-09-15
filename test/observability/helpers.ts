/**
 * Shared fixtures for the observability specs (ARK-60 / SYM-003).
 *
 * Not a `*.test.ts` file, so the `test/**\/*.test.ts` glob does not run it — but it
 * IS inside the `tsconfig.json` program, so `npm run typecheck` still checks that
 * the fakes below satisfy the real interfaces.
 */

import type { OrchestratorState, RunningEntry } from "../../src/domain/index.js";
import type { WritableLike } from "../../src/observability/index.js";

/** A `WritableLike` that records everything written to it. */
export interface CapturedStream extends WritableLike {
  /** Raw chunks, exactly as the sink wrote them. */
  readonly chunks: string[];
  /** Everything written, concatenated. */
  text(): string;
  /** Non-empty newline-terminated lines. */
  lines(): string[];
  /** Each written line parsed as JSON. */
  json(): Array<Record<string, unknown>>;
  clear(): void;
}

/** Create a capturing stream. `isTTY` / `columns` default to undefined (a pipe). */
export function captureStream(
  options: { isTTY?: boolean; columns?: number } = {},
): CapturedStream {
  const chunks: string[] = [];

  return {
    isTTY: options.isTTY,
    columns: options.columns,
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text() {
      return chunks.join("");
    },
    lines() {
      return chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0);
    },
    json() {
      return this.lines().map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      );
    },
    clear() {
      chunks.length = 0;
    },
  };
}

/** A clock that returns fixed instants in sequence, then repeats the last one. */
export function fixedClock(...instants: string[]): () => Date {
  const times = instants.length > 0 ? instants : ["2026-09-15T01:00:00.000Z"];
  let index = 0;
  return () => {
    const at = times[Math.min(index, times.length - 1)] as string;
    index += 1;
    return new Date(at);
  };
}

/** A clock frozen at one instant. */
export function frozenClock(at: string): () => Date {
  return () => new Date(at);
}

/** Build a `RunningEntry` (§4.1.8) with sensible defaults. */
export function runningEntry(
  overrides: Partial<RunningEntry> & Pick<RunningEntry, "issue_identifier">,
): RunningEntry {
  return {
    issue_id: `id-${overrides.issue_identifier.toLowerCase()}`,
    dispatch_state: "In Progress",
    workspace_path: `/tmp/symphony_workspaces/${overrides.issue_identifier}`,
    started_at: "2026-09-15T01:00:00.000Z",
    attempt: null,
    ...overrides,
  };
}

/** Build an `OrchestratorState` (§4.1.8) keyed the way the orchestrator keys it. */
export function orchestratorState(
  entries: RunningEntry[] = [],
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState {
  const running: Record<string, RunningEntry> = {};
  for (const entry of entries) running[entry.issue_id] = entry;

  return {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 10,
    running,
    claimed: new Set(entries.map((entry) => entry.issue_id)),
    completed: new Set<string>(),
    ...overrides,
  };
}
