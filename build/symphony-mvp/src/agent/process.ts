/**
 * Agent subprocess abstraction (U4; SYMPHONY-SPEC §10.1 adapted).
 *
 * The agent runner launches Claude Code (headless) via `bash -lc <agent.command>`
 * with the per-issue workspace as cwd, writes the rendered prompt on stdin, and
 * consumes line-delimited stream output on stdout while keeping diagnostic
 * stderr separate (§10.3). This module defines a minimal, injectable process
 * handle so the runner can be unit-tested against a fake agent for determinism.
 */

import { spawn } from "node:child_process";

/** Parameters used to launch the agent subprocess (§10.1). */
export interface AgentSpawnRequest {
  /** Shell command, executed via `bash -lc <command>`. */
  command: string;
  /** Working directory — MUST be the per-issue workspace path (Invariant a). */
  cwd: string;
  /** Fully-rendered prompt delivered to the agent on stdin. */
  prompt: string;
  /** Extra environment overlaid on the current process env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * A live agent process. The runner subscribes to stdout lines / stderr / exit,
 * never to raw byte chunks, keeping the protocol stream decoupled from
 * diagnostics (§10.3).
 */
export interface AgentProcess {
  /** Register a handler for each complete stdout line (protocol stream). */
  onStdoutLine(handler: (line: string) => void): void;
  /** Register a handler for diagnostic stderr text. */
  onStderr(handler: (text: string) => void): void;
  /** Register the spawn-failure handler (e.g. command not found). */
  onError(handler: (error: Error) => void): void;
  /** Register the exit handler (code is null when killed by signal). */
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  /** Force-terminate the process (used on turn timeout / cancellation). */
  kill(): void;
}

/** Pluggable spawner so tests can supply a fake agent process. */
export type AgentSpawner = (request: AgentSpawnRequest) => AgentProcess;

/**
 * Default spawner: `bash -lc <command>` in the workspace cwd, prompt on stdin.
 * Splits stdout into lines for the protocol consumer; stderr is forwarded raw
 * as diagnostics.
 */
export const spawnAgentProcess: AgentSpawner = (request) => {
  const child = spawn("bash", ["-lc", request.command], {
    cwd: request.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(request.env ?? {}) },
  });

  // Deliver the rendered prompt on stdin, then close it so headless agents that
  // read stdin to EOF can proceed.
  try {
    child.stdin?.write(request.prompt);
    child.stdin?.end();
  } catch {
    // If stdin is already gone the process error/exit path will surface it.
  }

  const stdoutHandlers: ((line: string) => void)[] = [];
  const stderrHandlers: ((text: string) => void)[] = [];
  const errorHandlers: ((error: Error) => void)[] = [];
  const exitHandlers: ((code: number | null, signal: string | null) => void)[] =
    [];

  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      for (const h of stdoutHandlers) h(line);
      nl = buffer.indexOf("\n");
    }
  });
  child.stdout?.on("end", () => {
    if (buffer.length > 0) {
      const line = buffer;
      buffer = "";
      for (const h of stdoutHandlers) h(line);
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const h of stderrHandlers) h(chunk);
  });

  child.on("error", (err) => {
    for (const h of errorHandlers) h(err);
  });
  child.on("close", (code, signal) => {
    for (const h of exitHandlers) h(code, signal);
  });

  return {
    onStdoutLine(handler) {
      stdoutHandlers.push(handler);
    },
    onStderr(handler) {
      stderrHandlers.push(handler);
    },
    onError(handler) {
      errorHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
};
