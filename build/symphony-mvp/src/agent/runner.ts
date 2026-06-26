/**
 * Claude Code Agent Runner (U4; SYMPHONY-SPEC §10 adapted, §12; FR-AG-1..7).
 *
 * Implements the shared `AgentRunner` interface (U1 `domain/interfaces.ts`).
 * Replaces the spec's Codex app-server (§10) with a Claude Code headless
 * subprocess behind the same abstract contract so the backend stays swappable
 * (FR-AG-2). For the MVP it runs exactly ONE turn (§16.5 single-turn slice;
 * multi-turn continuation is deferred).
 *
 * Per-attempt flow (§10.7):
 *   1. Enforce safety invariants (a) + (b) via the workspace manager BEFORE any
 *      launch — `cwd === workspace_path`, contained in root. (FR-WS-3a/b)
 *   2. Render the per-turn prompt with `issue` + `attempt`; a render failure
 *      fails the attempt. (FR-PR-1,2, §12.4)
 *   3. Launch Claude Code headless via `bash -lc <agent.command>` in the
 *      workspace cwd, prompt on stdin. (FR-AG-1, §10.1)
 *   4. High-trust posture: command/file-change approvals are auto-approved by
 *      the launch flags (`agent.command`); a user-input-required result is a
 *      hard failure; unsupported tool calls never stall. (FR-AG-6, §10.5)
 *   5. Process the turn stream: derive `thread_id`/`turn_id`, emit
 *      `session_id = "<thread_id>-<turn_id>"`, forward `session_started` /
 *      `turn_completed` / `turn_failed` / `startup_failed`; map
 *      success/failure/timeout/exit to the normalized outcome. (FR-AG-3,4,5)
 *   6. On any error, fail the attempt (the orchestrator handles retry). (§10.7)
 */

import type { Logger } from "../obs/log.js";
import { errorMessage } from "../obs/log.js";
import type { AgentConfig } from "../domain/config.js";
import type {
  AgentEvent,
  AgentResult,
  AgentRunRequest,
  AgentRunner,
} from "../domain/interfaces.js";
import { isSymphonyError } from "../domain/errors.js";
import { renderPrompt } from "../prompt/render.js";
import {
  WorkspaceManagerImpl,
  WorkspaceSafetyError,
} from "../workspace/manager.js";
import {
  spawnAgentProcess,
  type AgentProcess,
  type AgentSpawner,
} from "./process.js";
import {
  makeSessionId,
  parseProtocolLine,
  type AgentErrorCategory,
} from "./protocol.js";

/** Construction options for the Claude Code runner. */
export interface ClaudeCodeAgentRunnerOptions {
  /** Resolved agent config (`agent.command`, `turn_timeout_ms`, …). */
  agent: AgentConfig;
  /** Workspace manager — enforces invariants (a)+(b) before launch. */
  workspace: WorkspaceManagerImpl;
  /** Logger; per-issue + per-session context is derived per run. */
  logger: Logger;
  /**
   * Workflow prompt template (`workflow.prompt_template`). When set and the run
   * request supplies no pre-rendered `prompt`, the runner renders this template
   * with the strict U1 renderer (`issue` + `attempt`); a render failure fails
   * the attempt (FR-PR-1,2). When absent, the empty-template fallback is used.
   */
  promptTemplate?: string;
  /** Injectable process spawner. Defaults to the real `bash -lc` launcher. */
  spawner?: AgentSpawner;
  /**
   * Injectable clock for deterministic tests. Default `() => new Date()`.
   * Used for event timestamps only.
   */
  now?: () => Date;
}

/** Internal terminal outcome of the single turn. */
interface TurnOutcome {
  ok: boolean;
  category?: AgentErrorCategory;
  error?: string;
}

/**
 * Concrete Claude Code agent runner. Stateless across runs — construct once and
 * reuse; each `run` owns its own subprocess lifecycle.
 */
export class ClaudeCodeAgentRunner implements AgentRunner {
  private readonly agent: AgentConfig;
  private readonly workspace: WorkspaceManagerImpl;
  private readonly logger: Logger;
  private readonly promptTemplate: string;
  private readonly spawner: AgentSpawner;
  private readonly now: () => Date;

  constructor(options: ClaudeCodeAgentRunnerOptions) {
    this.agent = options.agent;
    this.workspace = options.workspace;
    this.logger = options.logger;
    this.promptTemplate = options.promptTemplate ?? "";
    this.spawner = options.spawner ?? spawnAgentProcess;
    this.now = options.now ?? (() => new Date());
  }

  async run(
    request: AgentRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentResult> {
    const { issue, workspace, attempt } = request;
    const log = this.logger.forIssue({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    const emit = (event: AgentEvent): void => {
      try {
        onEvent?.(event);
      } catch {
        // A misbehaving consumer callback must never break the run.
      }
    };
    const ts = (): string => this.now().toISOString();

    // ── Safety invariants (a) + (b), BEFORE any launch (FR-WS-3a/b, §15.2) ──
    const cwd = workspace.path;
    try {
      this.workspace.assertCwdMatchesWorkspace(cwd, workspace.path);
    } catch (err) {
      return this.failBeforeLaunch(log, emit, ts, err, "invalid_workspace_cwd");
    }

    // ── Prompt render (FR-PR-1,2; render failure fails the attempt, §12.4) ──
    let prompt: string;
    try {
      // Prefer a caller-supplied prompt (orchestrator may pre-render); else
      // render the configured workflow template from issue + attempt using U1's
      // strict renderer (empty template ⇒ FALLBACK_PROMPT).
      prompt =
        request.prompt && request.prompt.length > 0
          ? request.prompt
          : renderPrompt(this.promptTemplate, issue, attempt);
    } catch (err) {
      const reason = isSymphonyError(err) ? err.message : errorMessage(err);
      log.error("prompt_render_failed", {
        outcome: "failed",
        category: "render_failed",
        reason,
      });
      emit({ type: "startup_failed", timestamp: ts(), error: reason });
      return { ok: false, session_id: null, error_category: "render_failed", error: reason };
    }

    // ── Launch Claude Code headless (FR-AG-1, §10.1) ──
    let proc: AgentProcess;
    try {
      proc = this.spawner({ command: this.agent.command, cwd, prompt });
    } catch (err) {
      return this.failBeforeLaunch(log, emit, ts, err, "agent_not_found");
    }

    return this.processTurn({ proc, log, emit, ts });
  }

  /** Drive the single turn to a terminal outcome and shape the result. */
  private processTurn(args: {
    proc: AgentProcess;
    log: Logger;
    emit: (event: AgentEvent) => void;
    ts: () => string;
  }): Promise<AgentResult> {
    const { proc, log, emit, ts } = args;
    const turnId = "1"; // MVP: exactly one turn (§16.5 single-turn slice).

    return new Promise<AgentResult>((resolve) => {
      let threadId: string | null = null;
      let sessionId: string | null = null;
      let sessionLog: Logger = log;
      let settled = false;
      let sawTerminal = false;
      let outcome: TurnOutcome | null = null;

      const ensureSession = (tid: string): void => {
        if (sessionId !== null) return;
        threadId = tid;
        sessionId = makeSessionId(tid, turnId);
        sessionLog = log.forSession({ session_id: sessionId });
        sessionLog.info("session_started", { outcome: "started" });
        emit({ type: "session_started", timestamp: ts(), session_id: sessionId });
      };

      const finish = (final: TurnOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          proc.kill();
        } catch {
          // Best-effort termination.
        }
        if (final.ok) {
          sessionLog.info("turn_completed", { outcome: "completed" });
          emit({
            type: "turn_completed",
            timestamp: ts(),
            ...(sessionId ? { session_id: sessionId } : {}),
          });
          resolve({ ok: true, session_id: sessionId });
        } else {
          const category = final.category ?? "turn_failed";
          const error = final.error ?? "agent turn failed";
          sessionLog.error("turn_failed", {
            outcome: "failed",
            category,
            reason: error,
          });
          // startup_failed if we never even started a session; else turn_failed.
          emit({
            type: sessionId ? "turn_failed" : "startup_failed",
            timestamp: ts(),
            ...(sessionId ? { session_id: sessionId } : {}),
            error,
          });
          resolve({ ok: false, session_id: sessionId, error_category: category, error });
        }
      };

      // Total turn timeout (§10.3 turn_timeout_ms → failure).
      const timer = setTimeout(() => {
        finish({
          ok: false,
          category: "turn_timeout",
          error: `turn exceeded turn_timeout_ms=${this.agent.turn_timeout_ms}`,
        });
      }, Math.max(1, this.agent.turn_timeout_ms));

      proc.onStdoutLine((line) => {
        const parsed = parseProtocolLine(line);
        switch (parsed.kind) {
          case "session_init":
            ensureSession(parsed.threadId);
            break;
          case "notification":
            if (parsed.threadId) ensureSession(parsed.threadId);
            emit({
              type: "notification",
              timestamp: ts(),
              ...(sessionId ? { session_id: sessionId } : {}),
              ...(parsed.message ? { message: parsed.message } : {}),
            });
            break;
          case "turn_completed":
            if (parsed.threadId) ensureSession(parsed.threadId);
            sawTerminal = true;
            outcome = { ok: true };
            finish(outcome);
            break;
          case "turn_failed":
            if (parsed.threadId) ensureSession(parsed.threadId);
            sawTerminal = true;
            outcome = { ok: false, category: parsed.category, error: parsed.reason };
            finish(outcome);
            break;
          case "input_required":
            // High-trust: user-input-required ⇒ hard failure, never stall.
            if (parsed.threadId) ensureSession(parsed.threadId);
            sawTerminal = true;
            outcome = {
              ok: false,
              category: "turn_input_required",
              error: parsed.reason,
            };
            finish(outcome);
            break;
          case "malformed":
            emit({
              type: "malformed",
              timestamp: ts(),
              ...(sessionId ? { session_id: sessionId } : {}),
              error: parsed.raw.slice(0, 500),
            });
            break;
          case "ignored":
          default:
            break;
        }
      });

      // Diagnostic stderr stays separate from the protocol stream (§10.3).
      proc.onStderr((text) => {
        sessionLog.debug("agent_stderr", { text });
      });

      // Spawn-level failure (e.g. `command not found`) ⇒ startup failure.
      proc.onError((err) => {
        finish({
          ok: false,
          category: "agent_not_found",
          error: `agent launch failed: ${err.message}`,
        });
      });

      // Subprocess exit (§10.3 subprocess exit → failure unless a terminal
      // result already arrived).
      proc.onExit((code, signal) => {
        if (sawTerminal && outcome) {
          finish(outcome);
          return;
        }
        if (code === 0) {
          // Clean exit with no explicit result line: treat as completed so a
          // minimal agent that just exits 0 is not spuriously failed.
          finish({ ok: true });
          return;
        }
        finish({
          ok: false,
          category: "port_exit",
          error: `agent exited code=${code ?? "null"} signal=${signal ?? "null"}`,
        });
      });
    });
  }

  /** Shape a failure that happened before/at launch (no session started). */
  private failBeforeLaunch(
    log: Logger,
    emit: (event: AgentEvent) => void,
    ts: () => string,
    err: unknown,
    fallbackCategory: AgentErrorCategory,
  ): AgentResult {
    const category =
      err instanceof WorkspaceSafetyError && err.category === "invalid_workspace_cwd"
        ? "invalid_workspace_cwd"
        : fallbackCategory;
    const reason = errorMessage(err);
    log.error("startup_failed", { outcome: "failed", category, reason });
    emit({ type: "startup_failed", timestamp: ts(), error: reason });
    return { ok: false, session_id: null, error_category: category, error: reason };
  }
}

/** Factory: build the Claude Code agent runner from options. */
export function createClaudeCodeAgentRunner(
  options: ClaudeCodeAgentRunnerOptions,
): ClaudeCodeAgentRunner {
  return new ClaudeCodeAgentRunner(options);
}
