/**
 * Workspace hook execution (U4; SYMPHONY-SPEC §9.4, §15.4).
 *
 * Hooks are fully-trusted shell scripts taken from `WORKFLOW.md`. They run with
 * the workspace directory as cwd via `bash -lc <script>` and are bounded by
 * `hooks.timeout_ms` so a hanging hook can never wedge the orchestrator
 * (§15.4 — hook timeouts are REQUIRED). Output is captured (and truncated by the
 * logger sink) rather than streamed.
 *
 * The {@link HookRunner} type is injectable so the workspace manager can be
 * tested without spawning real processes.
 */

import { spawn } from "node:child_process";

/** A single hook invocation request. */
export interface HookRunRequest {
  /** Shell script body, executed via `bash -lc <script>`. */
  script: string;
  /** Workspace directory used as the hook's cwd (§9.4). */
  cwd: string;
  /** Wall-clock timeout in ms (`hooks.timeout_ms`). */
  timeoutMs: number;
}

/** Result of a hook invocation. */
export interface HookRunResult {
  ok: boolean;
  /** Process exit code, or null if killed (e.g. timeout). */
  code: number | null;
  /** true when the hook was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Concise failure reason when `ok === false`. */
  error: string;
}

/** Pluggable hook executor (real or fake). */
export type HookRunner = (request: HookRunRequest) => Promise<HookRunResult>;

/** Cap on captured hook output before the logger truncates further. */
const MAX_CAPTURE_BYTES = 64 * 1024;

/**
 * Default hook runner: `bash -lc <script>` with the workspace as cwd, enforcing
 * `timeoutMs`. Never rejects — failures and timeouts come back as
 * `{ ok: false }` so callers branch on the result rather than catch.
 */
export function runShellHook(request: HookRunRequest): Promise<HookRunResult> {
  return new Promise<HookRunResult>((resolve) => {
    const child = spawn("bash", ["-lc", request.script], {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const append = (buf: string, chunk: Buffer): string =>
      buf.length >= MAX_CAPTURE_BYTES
        ? buf
        : buf + chunk.toString("utf8");

    child.stdout?.on("data", (c: Buffer) => {
      stdout = append(stdout, c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr = append(stderr, c);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1, request.timeoutMs));

    const finish = (result: HookRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (err) => {
      finish({
        ok: false,
        code: null,
        timedOut,
        stdout,
        stderr,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish({
          ok: false,
          code,
          timedOut: true,
          stdout,
          stderr,
          error: `hook timed out after ${request.timeoutMs}ms`,
        });
        return;
      }
      finish({
        ok: code === 0,
        code,
        timedOut: false,
        stdout,
        stderr,
        error: code === 0 ? "" : `hook exited with code ${code}`,
      });
    });
  });
}
