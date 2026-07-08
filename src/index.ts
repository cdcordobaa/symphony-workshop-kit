#!/usr/bin/env node
/**
 * CLI / host lifecycle (Symphony spec §5.1 path precedence, §6.3 startup
 * preflight, §17.7 CLI behavior).
 *
 * This module owns the deterministic, synchronous startup surface: select the
 * workflow path, load + resolve the typed config, and run startup preflight,
 * reporting clean operator messages with stable exit codes. The polling daemon
 * itself lives in {@link import("./cli.js")} (`runCli`) and reuses
 * {@link prepareStartup} here so the load/validate messages are identical whether
 * you are only validating (`runHost`) or launching the loop (`runCli`).
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig } from "./config/config.js";
import { isWorkflowError } from "./config/errors.js";
import { loadWorkflowFile } from "./config/loader.js";
import { preflightConfig } from "./config/preflight.js";
import type { ServiceConfig } from "./domain/types.js";

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

/** The validated startup context shared by `runHost` and the daemon (`runCli`). */
export interface StartupContext {
  /** Absolute path of the loaded workflow file. */
  path: string;
  /** Fully-resolved typed runtime config. */
  config: ServiceConfig;
  /** Per-issue prompt template (the Markdown body of `WORKFLOW.md`). */
  promptTemplate: string;
}

/** Result of {@link prepareStartup}: either a validated context or an exit code. */
export type StartupOutcome =
  | { ok: true; context: StartupContext }
  | { ok: false; code: number };

/**
 * Resolve → load → validate the workflow, emitting the exact operator messages
 * the host uses (§5.1, §6.3, §17.7). Never throws. On any failure it writes the
 * message(s) to `io.err` and returns a nonzero code; on success it returns the
 * validated {@link StartupContext}. Both the validate-only `runHost` and the
 * `runCli` daemon build on this so their startup surface is identical.
 */
export function prepareStartup(argv: string[], io: HostIo = defaultIo()): StartupOutcome {
  const selected = resolveWorkflowPath(argv, io.cwd);

  if (!existsSync(selected.path)) {
    const hint = selected.explicit
      ? ""
      : ` (no explicit path given; expected default ${DEFAULT_WORKFLOW_FILENAME})`;
    io.err(`symphony: workflow file not found: ${selected.path}${hint}`);
    return { ok: false, code: ExitCode.MISSING_WORKFLOW };
  }

  let config: ServiceConfig;
  let promptTemplate: string;
  try {
    const workflow = loadWorkflowFile(selected.path);
    config = resolveConfig(workflow, io.env);
    promptTemplate = workflow.prompt_template;
  } catch (error) {
    const detail = isWorkflowError(error)
      ? `[${error.code}] ${error.message}`
      : (error as Error).message;
    io.err(`symphony: failed to start: ${detail}`);
    return { ok: false, code: ExitCode.STARTUP_FAILURE };
  }

  const preflight = preflightConfig(config);
  if (!preflight.ok) {
    io.err("symphony: startup preflight failed:");
    for (const problem of preflight.errors) {
      io.err(`  - ${problem}`);
    }
    return { ok: false, code: ExitCode.STARTUP_FAILURE };
  }

  return { ok: true, context: { path: selected.path, config, promptTemplate } };
}

/**
 * Run the host startup sequence and return a process exit code. Never throws:
 * all failures are surfaced cleanly on the error sink with a nonzero code (§17.7).
 * This is the validate-and-report surface; the polling loop is launched by
 * `runCli` (see `src/cli.ts`).
 */
export function runHost(argv: string[], io: HostIo = defaultIo()): number {
  const outcome = prepareStartup(argv, io);
  if (!outcome.ok) return outcome.code;

  const { path, config } = outcome.context;
  io.out(`symphony: workflow loaded from ${path}`);
  io.out(
    `symphony: tracker=${config.tracker.kind} database=${config.tracker.database_id} ` +
      `agent="${config.agent.command}" workspace_root=${config.workspace.root}`,
  );
  io.out("symphony: startup preflight passed.");
  return ExitCode.OK;
}

// Only auto-run when invoked directly (not when imported by tests). The real
// entrypoint launches the polling daemon (`runCli`); it is dynamically imported
// to keep the `index` ⇄ `cli` dependency acyclic at module-evaluation time.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void import("./cli.js").then(({ runCli }) =>
    runCli(process.argv.slice(2)).then((code) => process.exit(code)),
  );
}
