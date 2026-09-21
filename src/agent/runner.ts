/**
 * Agent Runner — Claude Code headless (Symphony spec §10, adapted from Codex).
 *
 * Implements the ARK-49 {@link AgentRunner} port for one issue attempt (§10.7):
 *
 *   1. Create/reuse the per-issue workspace via the {@link WorkspaceManager} (§9).
 *   2. Build the strict turn prompt from `issue` + `attempt` (§12, FR15).
 *   3. Re-assert **safety invariant A** — `cwd == workspace path` — immediately
 *      before spawn; a mismatch refuses the launch (§9.5.1, §15.2, FR11).
 *   4. Launch Claude Code headless via `bash -lc <agent.command + high-trust flags>`
 *      with `cwd` = the workspace path; the prompt is piped over stdin (§10.1).
 *   5. Run exactly one turn (`claude -p` runs a single turn and exits); parse the
 *      `stream-json` event stream, forward events to observability, and derive
 *      `session_id = "<thread_id>-<turn_id>"` (§10.2–§10.4, FR16).
 *   6. Map the terminal result to success/failure. A user-input-required signal is
 *      a hard failure under the high-trust posture (§10.5, D5).
 *   7. Enforce **stall detection** (§8.5 Part A, §10.6): a run that emits no parsed
 *      stream event for `agent.stall_timeout_ms` is terminated and mapped to a
 *      `turn_stalled` failure. The inactivity window resets on every event, and
 *      `stall_timeout_ms <= 0` disables detection entirely.
 *
 * On ANY error the attempt fails (a failed {@link RunAttempt} is returned, never
 * thrown) so the orchestrator decides retry behavior (§10.7 step 5, §12.4).
 *
 * Deferred to later units (PRD §5.3): multi-turn continuation up to `max_turns`,
 * retry/backoff, and token/runtime accounting.
 */

import { spawn as spawnChild } from "node:child_process";
import type { Issue, ServiceConfig } from "../domain/types.js";
import type { AgentRunner, Logger, RunAttempt, WorkspaceManager } from "../domain/interfaces.js";
import { assertCwdIsWorkspace } from "../workspace/safety.js";
import { isWorkspaceError } from "../workspace/errors.js";
import { AgentError, isAgentError, type AgentErrorCode } from "./errors.js";
import { buildAgentPrompt } from "./prompt.js";
import { deriveSessionId, parseEventLine, type AgentEvent } from "./events.js";

/* --------------------------------------------------------------------------- *
 * Injectable subprocess surface (so tests stub the agent without a real spawn).
 * The real `child_process.spawn` result satisfies this structurally.
 * --------------------------------------------------------------------------- */

export interface AgentStdin {
  write(chunk: string): void;
  end(): void;
}

export interface AgentReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
}

export interface AgentProcess {
  stdin: AgentStdin | null;
  stdout: AgentReadable | null;
  stderr: AgentReadable | null;
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Launches the subprocess. Args are passed verbatim to the shell (`bash -lc`). */
export type Spawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => AgentProcess;

/** Opaque handle returned by {@link SetTimer}; only ever passed back to {@link ClearTimer}. */
export type AgentTimerHandle = unknown;

/** Arms a one-shot timer. Injectable so stall detection is deterministic in tests. */
export type SetTimer = (fn: () => void, ms: number) => AgentTimerHandle;

/** Cancels a timer previously armed by a {@link SetTimer}. */
export type ClearTimer = (handle: AgentTimerHandle) => void;

/** Default spawner: real `bash -lc` subprocess with piped stdio. */
const defaultSpawner: Spawner = (command, args, options) =>
  spawnChild(command, [...args], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as AgentProcess;

/* --------------------------------------------------------------------------- */

/** Dependencies for {@link createAgentRunner}. */
export interface AgentRunnerDeps {
  /**
   * Typed runtime config; `agent.command`, `agent.turn_timeout_ms` and
   * `agent.stall_timeout_ms` are consulted.
   */
  config: ServiceConfig;
  /** Per-issue workspace manager (create/reuse + the canonical workspace path). */
  workspaceManager: WorkspaceManager;
  /** Workflow prompt template (`workflow.prompt_template`) bound per turn (§12.1). */
  promptTemplate: string;
  /** Optional structured logger; the runner binds issue + session context. */
  logger?: Logger;
  /** Optional upstream event callback (§10.4 "forward app-server events"). */
  onEvent?: (event: AgentEvent) => void;
  /** Injectable spawner (tests). Defaults to a real `bash -lc` subprocess. */
  spawn?: Spawner;
  /** Injectable stall timer (tests). Defaults to `setTimeout`. */
  setTimer?: SetTimer;
  /** Cancels a {@link setTimer} handle (tests). Defaults to `clearTimeout`. */
  clearTimer?: ClearTimer;
}

/** A {@link RunAttempt} plus the derived coding-agent `session_id` (§10.2). */
export interface AgentRunResult extends RunAttempt {
  /** `"<thread_id>-<turn_id>"` derived from the event stream (FR16). */
  session_id: string;
}

/** The Claude Code {@link AgentRunner}; `run` also surfaces the derived session id. */
export interface ClaudeAgentRunner extends AgentRunner {
  run(issue: Issue, attempt: number | null): Promise<AgentRunResult>;
}

/**
 * Ensure the high-trust headless flags are present on the launch command, keeping
 * them behind the port (§10 notes / PRD §10) while letting `agent.command`
 * override each: non-interactive (`-p`, prompt read from stdin), machine-readable
 * event stream (`--output-format stream-json --verbose`), and auto-approve
 * (`--permission-mode bypassPermissions`) for commands + file edits (§10.5).
 */
export function buildClaudeInvocation(command: string): string {
  const flags: string[] = [];
  if (!/(^|\s)(-p|--print)(\s|$)/.test(command)) flags.push("-p");
  if (!/--output-format(\s|=)/.test(command)) flags.push("--output-format", "stream-json");
  if (!/(^|\s)--verbose(\s|$)/.test(command)) flags.push("--verbose");
  if (!/--permission-mode(\s|=)|--dangerously-skip-permissions/.test(command)) {
    flags.push("--permission-mode", "bypassPermissions");
  }
  return [command.trim(), ...flags].join(" ");
}

/**
 * Create a Claude Code {@link AgentRunner} bound to `deps`. The returned runner is
 * stateless across calls; each `run` is one isolated attempt for one issue.
 */
export function createAgentRunner(deps: AgentRunnerDeps): ClaudeAgentRunner {
  const { config, workspaceManager, promptTemplate, logger, onEvent } = deps;
  const spawn = deps.spawn ?? defaultSpawner;
  const setTimer: SetTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: ClearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  async function run(issue: Issue, attempt: number | null): Promise<AgentRunResult> {
    const started_at = new Date().toISOString();
    const base = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      started_at,
    };
    const log = logger?.child({ issue_id: issue.id, issue_identifier: issue.identifier });

    // (1) Create/reuse the per-issue workspace (§10.7 step 1).
    let workspacePath: string;
    try {
      const workspace = await workspaceManager.prepare(issue.identifier);
      workspacePath = workspace.path;
    } catch (error) {
      return fail(base, "", "invalid_workspace_cwd", messageOf(error), log);
    }

    // (3) Safety invariant A re-check IMMEDIATELY before spawn (§9.5.1, FR11):
    // the cwd we are about to launch with MUST equal the canonical workspace path.
    try {
      assertCwdIsWorkspace(workspacePath, workspaceManager.workspacePathFor(issue.identifier));
    } catch (error) {
      const message = isWorkspaceError(error) ? error.message : messageOf(error);
      return fail(base, workspacePath, "invalid_workspace_cwd", message, log);
    }

    // (2) Build the strict turn prompt (§12, FR15). A missing binding raises here.
    let prompt: string;
    let title: string;
    try {
      const built = buildAgentPrompt(promptTemplate, issue, attempt);
      prompt = built.prompt;
      title = built.title;
    } catch (error) {
      const code: AgentErrorCode = isAgentError(error) ? error.code : "prompt_render_error";
      return fail(base, workspacePath, code, messageOf(error), log);
    }

    // (4) Launch Claude Code headless via `bash -lc`, cwd == workspace path (§10.1).
    const invocation = buildClaudeInvocation(config.agent.command);
    log?.info("agent launch", {
      action: "agent_launch",
      workspace_path: workspacePath,
      invocation,
      title,
      attempt,
    });

    return spawnAndRun({
      spawn,
      invocation,
      cwd: workspacePath,
      prompt,
      turnTimeoutMs: config.agent.turn_timeout_ms,
      stallTimeoutMs: config.agent.stall_timeout_ms,
      base,
      workspacePath,
      log,
      onEvent,
      setTimer,
      clearTimer,
    });
  }

  return { run };
}

/* --------------------------------------------------------------------------- *
 * Turn execution — spawn, stream parsing, and terminal mapping (§10.3–§10.6).
 * --------------------------------------------------------------------------- */

interface SpawnRunArgs {
  spawn: Spawner;
  invocation: string;
  cwd: string;
  prompt: string;
  turnTimeoutMs: number;
  /** `agent.stall_timeout_ms`; `<= 0` (or absent) disables stall detection (§5.3). */
  stallTimeoutMs: number;
  base: { issue_id: string; issue_identifier: string; attempt: number | null; started_at: string };
  workspacePath: string;
  log?: Logger;
  onEvent?: (event: AgentEvent) => void;
  setTimer: SetTimer;
  clearTimer: ClearTimer;
}

function spawnAndRun(args: SpawnRunArgs): Promise<AgentRunResult> {
  const { spawn, invocation, cwd, prompt, turnTimeoutMs, base, workspacePath, log, onEvent } = args;
  const { stallTimeoutMs, setTimer, clearTimer } = args;
  /** Stall detection is opt-out: a non-positive (or missing) threshold disables it (§8.5 Part A). */
  const stallEnabled = typeof stallTimeoutMs === "number" && stallTimeoutMs > 0;

  return new Promise<AgentRunResult>((resolve) => {
    let threadId: string | undefined;
    let turnId: string | undefined;
    let terminal: AgentEvent["event"] | undefined;
    let terminalMessage: string | undefined;
    let inputRequired = false;
    let timedOut = false;
    let stalled = false;
    let settled = false;
    let stdoutBuffer = "";

    const finish = (
      status: RunAttempt["status"],
      code: AgentErrorCode | null,
      message?: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      disarmStall();
      const session_id = deriveSessionId(threadId, turnId);
      if (status === "succeeded") {
        log?.info("agent turn completed", {
          session_id,
          action: "agent_turn",
          outcome: "succeeded",
        });
        resolve({ ...base, workspace_path: workspacePath, status, session_id });
      } else {
        const error = code ? `${code}: ${message ?? status}` : (message ?? status);
        log?.error("agent turn failed", {
          session_id,
          action: "agent_turn",
          outcome: status,
          error,
        });
        resolve({ ...base, workspace_path: workspacePath, status, session_id, error });
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;

    /* ----------------------------------------------------------------------- *
     * Stall detection (§8.5 Part A) — distinct from `turn_timeout_ms`, which
     * bounds the WHOLE turn. This bounds the gap between consecutive parsed
     * stream events: the window is armed at launch (measured from `started_at`,
     * per §8.5) and re-armed on every event, so it can never fire while output
     * is flowing. On expiry the child is terminated and the attempt fails with
     * the distinct `turn_stalled` reason.
     * ----------------------------------------------------------------------- */

    let stallTimer: AgentTimerHandle | undefined;

    const disarmStall = (): void => {
      if (stallTimer === undefined) return;
      clearTimer(stallTimer);
      stallTimer = undefined;
    };

    const onStall = (): void => {
      if (settled) return;
      stalled = true;
      log?.warn("agent run stalled", {
        session_id: deriveSessionId(threadId, turnId),
        action: "agent_stall",
        stall_timeout_ms: stallTimeoutMs,
      });
      try {
        proc.kill("SIGTERM"); // never leave a silent run hanging until turn_timeout_ms
      } catch {
        /* best effort */
      }
      finish("failed", "turn_stalled", `no agent output for ${stallTimeoutMs}ms`);
    };

    /** (Re)start the inactivity window. Called at launch and on every event. */
    const armStall = (): void => {
      if (!stallEnabled || settled) return;
      disarmStall();
      stallTimer = setTimer(onStall, stallTimeoutMs);
    };

    let proc: AgentProcess;
    try {
      proc = spawn("bash", ["-lc", invocation], { cwd });
    } catch (error) {
      finish("failed", "agent_not_found", messageOf(error));
      return;
    }

    timer =
      turnTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              proc.kill("SIGTERM");
            } catch {
              /* best effort */
            }
            finish("timeout", "turn_timeout", `turn exceeded ${turnTimeoutMs}ms`);
          }, turnTimeoutMs)
        : undefined;

    armStall(); // elapsed is measured from launch until the first event arrives (§8.5)

    const handleEvent = (event: AgentEvent): void => {
      armStall(); // output is flowing — restart the inactivity window (§8.5 Part A)
      if (event.session_id && !threadId) threadId = event.session_id;
      if (event.turn_id) turnId = event.turn_id; // terminal result's uuid wins (arrives last)
      const session_id = deriveSessionId(threadId, turnId);
      log?.debug("agent event", { session_id, event: event.event, message: event.message });
      try {
        onEvent?.(event);
      } catch {
        /* an upstream callback must never crash the run */
      }
      if (event.event === "turn_input_required") {
        inputRequired = true;
        try {
          proc.kill("SIGTERM"); // do not let a stalled prompt hang the run (D5)
        } catch {
          /* best effort */
        }
        return;
      }
      if (
        event.event === "turn_completed" ||
        event.event === "turn_failed" ||
        event.event === "turn_cancelled"
      ) {
        terminal = event.event;
        terminalMessage = event.message;
      }
    };

    const handleLine = (line: string): void => {
      if (line.trim().length === 0) return;
      handleEvent(parseEventLine(line, new Date().toISOString()));
    };

    proc.stdout?.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      let idx: number;
      while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        handleLine(line);
      }
    });

    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) log?.debug("agent stderr", { stream: "stderr", text });
    });

    proc.on("error", (error) => {
      // ENOENT / spawn failure — the agent command could not be launched.
      finish("failed", "agent_not_found", messageOf(error));
    });

    proc.on("close", (code) => {
      if (stdoutBuffer.trim().length > 0) handleLine(stdoutBuffer); // flush trailing line
      if (timedOut || stalled) return; // already finished by the timeout / stall path
      if (inputRequired) {
        finish("failed", "turn_input_required", "agent requested user input (high-trust hard fail)");
        return;
      }
      if (terminal === "turn_completed") {
        finish("succeeded", null);
        return;
      }
      if (terminal === "turn_cancelled") {
        finish("cancelled", "turn_cancelled", terminalMessage);
        return;
      }
      if (terminal === "turn_failed") {
        finish("failed", "turn_failed", terminalMessage);
        return;
      }
      // No terminal turn result before exit — treat the subprocess exit as failure.
      finish("failed", "port_exit", `agent exited (code ${code ?? "null"}) with no turn result`);
    });

    // (5) Feed the rendered prompt over stdin and signal a single turn (§10.1).
    try {
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    } catch (error) {
      finish("failed", "port_exit", `failed to write prompt to agent stdin: ${messageOf(error)}`);
    }
  });
}

/* --------------------------------------------------------------------------- */

function fail(
  base: { issue_id: string; issue_identifier: string; attempt: number | null; started_at: string },
  workspacePath: string,
  code: AgentErrorCode,
  message: string,
  log?: Logger,
): AgentRunResult {
  const session_id = deriveSessionId(undefined, undefined);
  const error = `${code}: ${message}`;
  log?.error("agent attempt failed", { action: "agent_run", outcome: "failed", error });
  return { ...base, workspace_path: workspacePath, status: "failed", session_id, error };
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
