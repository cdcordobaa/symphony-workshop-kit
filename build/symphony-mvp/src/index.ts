#!/usr/bin/env node
/**
 * CLI entrypoint / host lifecycle (SYMPHONY-SPEC §16.1, §17.7; FR-CLI-1).
 *
 * This is the final integration point (U3). It boots the foundation layer (U1:
 * resolve path → load workflow → preflight), then wires the read-only Notion
 * tracker (U2), the workspace manager + Claude Code agent runner (U4), the
 * logger / status surface (U5), and the orchestrator core (U3) into a single
 * running daemon and starts the poll loop end-to-end.
 *
 * Lifecycle:
 *  - startup failure (bad path / invalid config / failed preflight) ⇒ clean
 *    operator-visible message on stderr + non-zero exit (FR-CLI-1),
 *  - on a clean start the poll loop runs until SIGINT/SIGTERM, then shuts down
 *    cleanly with exit 0.
 *
 * `boot()` stays pure (no process.exit, no I/O wiring) so it remains unit-
 * testable and reusable; the daemon wiring lives in `buildDaemon()` / `run()`.
 */

import { loadWorkflow, resolveWorkflowPath } from "./config/loader.js";
import { assertDispatchConfig } from "./config/preflight.js";
import { isSymphonyError } from "./domain/errors.js";
import type { WorkflowDefinition } from "./domain/config.js";
import { createRuntimeState } from "./domain/state.js";
import { createLogger, type Logger } from "./obs/log.js";
import { createNotionTracker } from "./tracker/notion.js";
import { StdioNotionMcpTransport } from "./tracker/mcp-transport.js";
import { createWorkspaceManager } from "./workspace/manager.js";
import { createClaudeCodeAgentRunner } from "./agent/runner.js";
import {
  createOrchestrator,
  type Orchestrator,
  type OrchestratorHandle,
} from "./orchestrator/loop.js";

export interface BootResult {
  workflow: WorkflowDefinition;
  /** Effective runtime state seeded from config (handed to U3). */
  state: ReturnType<typeof createRuntimeState>;
}

/**
 * Boot the foundation layer: resolve path → load workflow → preflight.
 * Pure-ish (no process.exit); throws SymphonyError on startup failure so it can
 * be unit-tested and reused by the daemon wiring.
 */
export function boot(
  argv: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): BootResult {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const explicit = argv[0];
  const workflowPath = resolveWorkflowPath(explicit, cwd);

  const workflow = loadWorkflow(workflowPath, env);
  assertDispatchConfig(workflow);

  const state = createRuntimeState(
    workflow.service.polling.interval_ms,
    workflow.service.agent.max_concurrent_agents,
  );

  return { workflow, state };
}

/**
 * Wire every unit into a ready-to-start orchestrator (U3) from a booted
 * workflow. The Notion auth token is registered with the logger as a secret so
 * it can never leak into structured output (NFR-SECRETS).
 */
export function buildDaemon(
  workflow: WorkflowDefinition,
  opts: { env?: NodeJS.ProcessEnv; logger?: Logger } = {},
): Orchestrator {
  const env = opts.env ?? process.env;
  const service = workflow.service;

  const logger = opts.logger ?? createLogger({ level: "info" });
  // Never log the resolved Notion token (NFR-SECRETS / §15.3).
  logger.addSecret(service.tracker.api_key);

  // U2 — read-only Notion tracker over a real stdio MCP server.
  const transport = new StdioNotionMcpTransport({
    apiKey: service.tracker.api_key ?? "",
    env,
  });
  const tracker = createNotionTracker({
    config: service.tracker,
    transport,
    logger,
  });

  // U4 — sanitized workspace manager + Claude Code agent runner.
  const workspace = createWorkspaceManager({
    root: service.workspace.root,
    hooks: service.hooks,
    logger,
  });
  const agent = createClaudeCodeAgentRunner({
    agent: service.agent,
    workspace,
    logger,
    promptTemplate: workflow.prompt_template,
  });

  // U3 — orchestrator core wiring U2/U4/U5 + U1 config/validation.
  return createOrchestrator({ workflow, tracker, workspace, agent, logger });
}

/** Write an operator-visible startup failure to stderr. */
function reportStartupFailure(err: unknown): void {
  if (isSymphonyError(err)) {
    process.stderr.write(`startup_failed code=${err.code} reason="${err.message}"\n`);
    for (const detail of err.details) {
      process.stderr.write(`  - ${detail}\n`);
    }
  } else {
    process.stderr.write(
      `startup_failed code=unknown reason="${(err as Error).message ?? String(err)}"\n`,
    );
  }
}

/**
 * Run the daemon: boot → wire units → start the poll loop, then block until a
 * shutdown signal arrives and stop cleanly. Resolves with the intended exit
 * code (0 on clean start/shutdown, 1 on startup failure).
 */
export async function run(argv: string[]): Promise<number> {
  let booted: BootResult;
  try {
    booted = boot(argv);
  } catch (err) {
    reportStartupFailure(err);
    return 1;
  }

  const { workflow, state } = booted;
  process.stdout.write(
    `startup_ok workflow="${workflow.source_path}" ` +
      `tracker_kind=${workflow.service.tracker.kind} ` +
      `poll_interval_ms=${state.poll_interval_ms} ` +
      `max_concurrent_agents=${state.max_concurrent_agents}\n`,
  );

  const orchestrator = buildDaemon(workflow);
  const handle: OrchestratorHandle = orchestrator.start();

  // Block until a shutdown signal, then stop the loop cleanly (exit 0).
  await new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals): void => {
      process.stdout.write(`shutdown signal=${signal}\n`);
      handle.stop();
      resolve();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });

  return 0;
}

/**
 * Synchronous startup gate used by tests (FR-CLI-1 exit-code contract). Returns
 * 0 when boot succeeds and 1 when startup fails — without starting the loop.
 */
export function main(argv: string[]): number {
  try {
    const { workflow, state } = boot(argv);
    process.stdout.write(
      `startup_ok workflow="${workflow.source_path}" ` +
        `tracker_kind=${workflow.service.tracker.kind} ` +
        `poll_interval_ms=${state.poll_interval_ms} ` +
        `max_concurrent_agents=${state.max_concurrent_agents}\n`,
    );
    return 0;
  } catch (err) {
    reportStartupFailure(err);
    return 1;
  }
}

// Only run when invoked directly (not when imported by tests / other units).
const invokedPath = process.argv[1] ? process.argv[1] : "";
if (
  invokedPath.endsWith("index.js") ||
  invokedPath.endsWith("index.ts") ||
  invokedPath.endsWith("/symphony")
) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      reportStartupFailure(err);
      process.exit(1);
    },
  );
}
