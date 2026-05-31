#!/usr/bin/env node
/**
 * CLI / host lifecycle (Symphony spec §5.1 path precedence, §6.3 startup
 * preflight, §17.7 CLI behavior).
 *
 * Scope for U1 (walking skeleton): select the workflow path, load + resolve the
 * typed config, run startup preflight, and report a clean startup/shutdown
 * surface with deterministic exit codes. The polling/orchestration loop is a
 * later unit; "starts and shuts down normally" here means a successful preflight.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig } from "./config/config.js";
import { isWorkflowError } from "./config/errors.js";
import { loadWorkflowFile } from "./config/loader.js";
import { preflightConfig } from "./config/preflight.js";

/** Default workflow filename resolved against the process working directory (§5.1). */
export const DEFAULT_WORKFLOW_FILENAME = "WORKFLOW.md";

/** Process exit codes for the host (§17.7). */
export const ExitCode = {
  /** Application started and shut down normally. */
  OK: 0,
  /** Startup failed (load/parse/config/preflight error). */
  STARTUP_FAILURE: 1,
  /** The selected workflow file does not exist. */
  MISSING_WORKFLOW: 2,
} as const;

/** Selected workflow path and whether it came from an explicit CLI argument. */
export interface SelectedWorkflow {
  path: string;
  explicit: boolean;
}

/**
 * Resolve the workflow path from CLI args (§5.1 precedence):
 *   1. First positional (non-flag) argument, if provided.
 *   2. Otherwise `./WORKFLOW.md` in the working directory.
 */
export function resolveWorkflowPath(argv: string[], cwd: string = process.cwd()): SelectedWorkflow {
  const positional = argv.find((arg) => !arg.startsWith("-"));
  if (positional !== undefined) {
    const path = isAbsolute(positional) ? positional : resolve(cwd, positional);
    return { path, explicit: true };
  }
  return { path: resolve(cwd, DEFAULT_WORKFLOW_FILENAME), explicit: false };
}

/** I/O sink so the host is testable without touching the real process streams. */
export interface HostIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
}

function defaultIo(): HostIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
  };
}

/**
 * Run the host startup sequence and return a process exit code. Never throws:
 * all failures are surfaced cleanly on the error sink with a nonzero code (§17.7).
 */
export function runHost(argv: string[], io: HostIo = defaultIo()): number {
  const selected = resolveWorkflowPath(argv, io.cwd);

  if (!existsSync(selected.path)) {
    const hint = selected.explicit
      ? ""
      : ` (no explicit path given; expected default ${DEFAULT_WORKFLOW_FILENAME})`;
    io.err(`symphony: workflow file not found: ${selected.path}${hint}`);
    return ExitCode.MISSING_WORKFLOW;
  }

  let config;
  try {
    config = resolveConfig(loadWorkflowFile(selected.path), io.env);
  } catch (error) {
    const detail = isWorkflowError(error)
      ? `[${error.code}] ${error.message}`
      : (error as Error).message;
    io.err(`symphony: failed to start: ${detail}`);
    return ExitCode.STARTUP_FAILURE;
  }

  const preflight = preflightConfig(config);
  if (!preflight.ok) {
    io.err("symphony: startup preflight failed:");
    for (const problem of preflight.errors) {
      io.err(`  - ${problem}`);
    }
    return ExitCode.STARTUP_FAILURE;
  }

  io.out(`symphony: workflow loaded from ${selected.path}`);
  io.out(
    `symphony: tracker=${config.tracker.kind} database=${config.tracker.database_id} ` +
      `agent="${config.agent.command}" workspace_root=${config.workspace.root}`,
  );
  io.out("symphony: startup preflight passed.");
  return ExitCode.OK;
}

/** Process entrypoint. */
export function main(argv: string[] = process.argv.slice(2)): number {
  return runHost(argv);
}

// Only auto-run when invoked directly (not when imported by tests).
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exit(main());
}
