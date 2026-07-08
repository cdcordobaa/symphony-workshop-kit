/**
 * Test doubles for the Agent Runner: a scripted fake subprocess + a spawner that
 * records how it was invoked, plus minimal config / workspace-manager stubs. These
 * let the unit tests exercise the runner without launching a real `claude` process.
 */

import { EventEmitter } from "node:events";
import type { ServiceConfig } from "../../src/domain/types.js";
import type { WorkspaceManager } from "../../src/domain/interfaces.js";
import type { AgentProcess, Spawner } from "../../src/agent/runner.js";

/** A scripted fake of the launched subprocess. */
export class FakeProcess extends EventEmitter implements AgentProcess {
  readonly stdinChunks: string[] = [];
  stdinEnded = false;
  killed = false;
  readonly stdin = {
    write: (chunk: string) => {
      this.stdinChunks.push(chunk);
    },
    end: () => {
      this.stdinEnded = true;
    },
  };
  readonly stdout = new EventEmitter() as unknown as AgentProcess["stdout"];
  readonly stderr = new EventEmitter() as unknown as AgentProcess["stderr"];

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  cwd: string;
}

export interface FakeSpawnerOptions {
  /** stream-json lines to emit on stdout (one per array entry). */
  lines?: string[];
  /** exit code delivered on `close`. Default `0`. */
  exitCode?: number | null;
  /** when true, never emit `close` (used for timeout tests). */
  neverClose?: boolean;
  /** when set, the spawner throws synchronously (spawn failure). */
  throwOnSpawn?: Error;
}

/** Build a spawner that records calls and drives a {@link FakeProcess}. */
export function fakeSpawner(options: FakeSpawnerOptions = {}): {
  spawn: Spawner;
  calls: SpawnCall[];
  process: () => FakeProcess | undefined;
} {
  const calls: SpawnCall[] = [];
  let proc: FakeProcess | undefined;
  const spawn: Spawner = (command, args, opts) => {
    if (options.throwOnSpawn) throw options.throwOnSpawn;
    calls.push({ command, args, cwd: opts.cwd });
    proc = new FakeProcess();
    const p = proc;
    // Emit after the runner has attached its listeners (next tick).
    setImmediate(() => {
      const emitter = p.stdout as unknown as EventEmitter;
      for (const line of options.lines ?? []) emitter.emit("data", Buffer.from(`${line}\n`));
      if (!options.neverClose) p.emit("close", options.exitCode ?? 0);
    });
    return p;
  };
  return { spawn, calls, process: () => proc };
}

/** Minimal ServiceConfig for the runner (only `agent.command` + timeout consulted). */
export function agentConfig(overrides: Partial<ServiceConfig["agent"]> = {}): ServiceConfig {
  return {
    agent: {
      command: "claude",
      turn_timeout_ms: 3_600_000,
      ...overrides,
    },
  } as ServiceConfig;
}

/**
 * Stub {@link WorkspaceManager}. `path` is what `prepare` returns as the cwd;
 * `canonical` is what `workspacePathFor` returns for the Safety A re-check — set
 * them unequal to simulate an invariant-A violation.
 */
export function stubWorkspaceManager(path: string, canonical: string = path): WorkspaceManager {
  return {
    workspacePathFor: () => canonical,
    prepare: async () => ({ path, workspace_key: "key", created_now: true }),
    remove: async () => {},
  };
}
