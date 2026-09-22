/**
 * Workspace lifecycle hook execution (Symphony spec §9.4).
 *
 * A hook is a shell script configured in `WORKFLOW.md` under `hooks.*`. It runs
 * in a local shell (`bash -lc <script>`) with `cwd` = the per-issue workspace
 * directory, so a hook can only touch the confined workspace — the three safety
 * invariants (§9.5) are enforced by the manager *before* a hook is ever spawned
 * and are not relaxed here.
 *
 * Execution contract (§9.4):
 *   - `cwd` is the workspace directory;
 *   - `hooks.timeout_ms` bounds every hook (default `60000`); a hook still
 *     running at the deadline is killed and reported as a `timeout`;
 *   - start, failure and timeout are logged with action/outcome/exit code/duration.
 *
 * {@link runWorkspaceHook} NEVER throws and never returns hook output: failure
 * semantics belong to the caller (§9.4 — `after_create` is fatal to workspace
 * creation, `before_remove` is logged and ignored), and hook stdout/stderr may
 * carry secrets, so it is drained and discarded rather than logged (§13, FR21).
 */

import { spawn as spawnChild } from "node:child_process";
import type { Logger } from "../domain/interfaces.js";

/** The four hook points defined by §9.4. The MVP executes two of them. */
export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

/** Terminal outcome of one hook execution. */
export type HookOutcome =
  /** Exited `0` within the timeout. */
  | "ok"
  /** Exited non-zero, or the shell could not be spawned. */
  | "failed"
  /** Still running at `hooks.timeout_ms`; the process was killed. */
  | "timeout";

/** Milliseconds to wait after `SIGTERM` before escalating a timed-out hook to `SIGKILL`. */
const KILL_GRACE_MS = 2_000;

/* --------------------------------------------------------------------------- *
 * Injectable subprocess surface (so tests observe a hook without a real shell).
 * The real `child_process.spawn` result satisfies this structurally.
 * --------------------------------------------------------------------------- */

export interface HookReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
}

export interface HookProcess {
  stdout: HookReadable | null;
  stderr: HookReadable | null;
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Launches the hook subprocess. Args are passed verbatim to the shell. */
export type HookSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => HookProcess;

/** Default spawner: a real `bash -lc` subprocess with stdout/stderr piped and discarded. */
export const defaultHookSpawner: HookSpawner = (command, args, options) =>
  spawnChild(command, [...args], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as HookProcess;

/* --------------------------------------------------------------------------- */

/** Outcome record for one hook execution; safe to log verbatim (no hook output). */
export interface HookResult {
  hook: HookName;
  outcome: HookOutcome;
  /** Process exit code, or `null` when the hook timed out or could not be spawned. */
  exit_code: number | null;
  duration_ms: number;
  /** Spawn-level failure message (e.g. shell missing). Never hook stdout/stderr. */
  error?: string;
}

export interface RunWorkspaceHookArgs {
  hook: HookName;
  /** Shell script body from `hooks.<name>`. */
  script: string;
  /** Workspace directory; becomes the hook's `cwd` (§9.4). */
  cwd: string;
  /** `hooks.timeout_ms`. Non-positive/invalid values fall back to the §9.4 default. */
  timeoutMs: number;
  /** Injectable spawner (tests). Defaults to a real `bash -lc` subprocess. */
  spawn?: HookSpawner;
  logger?: Logger;
  /** Bound onto the log records so a hook line is attributable to its issue. */
  issueIdentifier?: string;
}

/** `hooks.timeout_ms` default when unset or not a positive number (§9.4). */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/**
 * Execute one workspace hook and report how it ended.
 *
 * Resolves — never rejects — so the caller applies the §9.4 failure semantics for
 * that hook point. A hook exceeding `timeoutMs` is sent `SIGTERM` (escalated to
 * `SIGKILL` after a short grace) and reported as `timeout`.
 */
export async function runWorkspaceHook(args: RunWorkspaceHookArgs): Promise<HookResult> {
  const { hook, script, cwd, issueIdentifier } = args;
  const spawn = args.spawn ?? defaultHookSpawner;
  const timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;
  const log = args.logger;
  const context = {
    ...(issueIdentifier === undefined ? {} : { issue_identifier: issueIdentifier }),
    action: "workspace_hook",
    hook,
    workspace_path: cwd,
  };

  log?.info("workspace hook start", { ...context, timeout_ms: timeoutMs });
  const startedAt = Date.now();

  const result = await new Promise<HookResult>((resolvePromise) => {
    let settled = false;
    const finish = (outcome: HookOutcome, exit_code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolvePromise({
        hook,
        outcome,
        exit_code,
        duration_ms: Date.now() - startedAt,
        ...(error === undefined ? {} : { error }),
      });
    };

    let child: HookProcess;
    try {
      child = spawn("bash", ["-lc", script], { cwd });
    } catch (error) {
      // Synchronous spawn failure (e.g. cwd vanished) — a failed hook, not a throw.
      resolvePromise({
        hook,
        outcome: "failed",
        exit_code: null,
        duration_ms: Date.now() - startedAt,
        error: messageOf(error),
      });
      return;
    }

    // Drain stdout/stderr so a chatty hook never blocks on a full pipe. The output
    // is deliberately discarded: it is untrusted and may contain secrets (FR21).
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
      finish("timeout", null);
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.on("error", (error) => finish("failed", null, messageOf(error)));
    child.on("close", (code) => finish(code === 0 ? "ok" : "failed", code));
  });

  const line = {
    ...context,
    outcome: result.outcome,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
  if (result.outcome === "ok") log?.info("workspace hook ok", line);
  else log?.warn(`workspace hook ${result.outcome}`, line);

  return result;
}

function messageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}
