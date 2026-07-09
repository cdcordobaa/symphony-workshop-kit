/**
 * `symphony ./WORKFLOW.md` daemon (Symphony spec §16.1 startup, §17.7 CLI, FR20).
 *
 * This is the host lifecycle around the {@link Orchestrator}: validate startup
 * (via {@link prepareStartup}), build the runtime by wiring the §4 ports
 * (observability → tracker → workspace → agent → orchestrator), start the poll
 * loop with its immediate first tick, and shut down gracefully on SIGINT/SIGTERM.
 *
 * Two run modes:
 *   - default: run until a shutdown signal (or an injected `runUntil` promise),
 *     then drain and stop cleanly.
 *   - `--once`: perform a single immediate tick and stop — the deterministic
 *     "starts, ticks immediately, shuts down gracefully" proof for FR20 and the
 *     substrate for the e2e smoke.
 *
 * Every dependency is injectable so the whole lifecycle is testable without real
 * timers, signals, Notion, or Claude Code. The production defaults wire the real
 * Notion tracker and the real Claude Code agent runner; if no Notion MCP transport
 * is supplied, the tracker fails each fetch with a clear, recoverable error so the
 * daemon degrades to skipped ticks rather than crashing (NFR reliability).
 */

import { createLogger, streamSink } from "./observability/logger.js";
import { createStatusSurface } from "./observability/status.js";
import { createWorkspaceManager } from "./workspace/manager.js";
import { createAgentRunner } from "./agent/runner.js";
import { NotionTrackerClient } from "./tracker/notion-tracker-client.js";
import { SqlNotionMcp, type NotionToolInvoker } from "./tracker/notion-mcp.js";
import { RestNotionMcp } from "./tracker/notion-rest.js";
import { TrackerError } from "./tracker/errors.js";
import { createOrchestrator, Orchestrator } from "./orchestrator/index.js";
import {
  ExitCode,
  prepareStartup,
  type HostIo,
  type StartupContext,
} from "./index.js";
import type {
  AgentRunner,
  Logger,
  StatusSurface,
  TrackerClient,
  WorkspaceManager,
} from "./domain/interfaces.js";

/** The wired runtime: the orchestrator plus the ports it drives. */
export interface Runtime {
  orchestrator: Orchestrator;
  logger: Logger;
  status: StatusSurface;
  tracker: TrackerClient;
  workspaceManager: WorkspaceManager;
  agentRunner: AgentRunner;
}

/** Overridable pieces of the runtime (tests inject fakes; the smoke injects a fixture tracker). */
export interface RuntimeOverrides {
  logger?: Logger;
  status?: StatusSurface;
  tracker?: TrackerClient;
  workspaceManager?: WorkspaceManager;
  agentRunner?: AgentRunner;
  /** A Notion MCP invoker for the default tracker (omit to get the fail-clear stub). */
  notionInvoke?: NotionToolInvoker;
  /** Notion data-source URL for the default `SqlNotionMcp` (defaults from `database_id`). */
  dataSourceUrl?: string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => Date;
}

/**
 * A tracker transport that refuses every call with a recoverable error. Used when
 * the daemon starts without a Notion MCP transport wired: the orchestrator logs
 * "candidate fetch failed; skipping" and survives, rather than crashing on startup.
 */
const unwiredNotionInvoke: NotionToolInvoker = async () => {
  throw new TrackerError(
    "notion_mcp_request",
    "No Notion MCP transport is wired for this process. Provide a NotionToolInvoker " +
      "(e.g. the claude.ai Notion connector) to fetch real issues.",
  );
};

/** Build the production/injected runtime by wiring the §4 ports around one config. */
export function buildRuntime(
  context: Pick<StartupContext, "config" | "promptTemplate">,
  overrides: RuntimeOverrides = {},
): Runtime {
  const { config, promptTemplate } = context;

  const logger =
    overrides.logger ??
    createLogger({
      // Structured stderr; the human status line goes to stdout (below). FR21: register the
      // tracker secret so it is scrubbed from every record even if it reaches a context field.
      sinks: [streamSink(process.stderr, "json")],
      level: "info",
      secrets: config.tracker.auth ? [config.tracker.auth] : [],
    });

  const status = overrides.status ?? createStatusSurface({ label: "symphony" });

  const workspaceManager =
    overrides.workspaceManager ?? createWorkspaceManager({ config, logger });

  // Transport selection:
  //  - a test invoker override → SQL transport over that invoker;
  //  - a resolved Notion token (tracker.auth, e.g. $NOTION_API_KEY) → the live REST transport;
  //  - otherwise the SQL transport over the fail-clear stub (no live socket wired).
  const transport = overrides.notionInvoke
    ? new SqlNotionMcp({
        dataSourceUrl: overrides.dataSourceUrl ?? `collection://${config.tracker.database_id}`,
        invoke: overrides.notionInvoke,
      })
    : config.tracker.auth && config.tracker.database_id
      ? new RestNotionMcp({ token: config.tracker.auth, databaseId: config.tracker.database_id })
      : new SqlNotionMcp({
          dataSourceUrl: overrides.dataSourceUrl ?? `collection://${config.tracker.database_id}`,
          invoke: unwiredNotionInvoke,
        });

  const tracker =
    overrides.tracker ?? new NotionTrackerClient({ transport, config, logger });

  const agentRunner =
    overrides.agentRunner ??
    createAgentRunner({ config, workspaceManager, promptTemplate, logger });

  const orchestrator = createOrchestrator({
    config,
    tracker,
    workspaceManager,
    agentRunner,
    logger,
    status,
    setTimer: overrides.setTimer,
    clearTimer: overrides.clearTimer,
    now: overrides.now,
  });

  return { orchestrator, logger, status, tracker, workspaceManager, agentRunner };
}

/** Options for {@link runCli} beyond the runtime overrides (mostly for tests). */
export interface RunCliOptions extends RuntimeOverrides {
  io?: HostIo;
  /**
   * When provided (and not `--once`), the daemon runs until this promise settles
   * instead of installing real OS signal handlers. Tests resolve it to trigger a
   * graceful shutdown deterministically.
   */
  runUntil?: Promise<void>;
}

/**
 * Run the `symphony` daemon and resolve to a process exit code. Never throws:
 * startup failures return a nonzero code with a clean message; a running daemon
 * shuts down gracefully on signal (or `runUntil`) and returns `OK`.
 */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io;
  const outcome = prepareStartup(argv, io);
  if (!outcome.ok) return outcome.code;

  const once = argv.includes("--once");
  const { context } = outcome;
  const { orchestrator, logger } = buildRuntime(context, options);

  logger.info("symphony host starting", {
    action: "host_start",
    workflow: context.path,
    mode: once ? "once" : "daemon",
    poll_interval_ms: context.config.polling.interval_ms,
    max_concurrent_agents: context.config.agent.max_concurrent_agents,
  });

  if (once) {
    // Deterministic FR20 proof: one immediate tick, then a graceful stop.
    await orchestrator.tick();
    await orchestrator.stop();
    logger.info("symphony host stopped", { action: "host_stop", mode: "once", outcome: "clean" });
    return ExitCode.OK;
  }

  orchestrator.start(); // immediate first tick + interval loop (FR6)

  await (options.runUntil ?? waitForShutdownSignal(logger));
  await orchestrator.stop(); // drain in-flight tick + workers (FR20)

  logger.info("symphony host stopped", { action: "host_stop", mode: "daemon", outcome: "clean" });
  return ExitCode.OK;
}

/** Resolve when the process receives SIGINT or SIGTERM; removes its own listeners. */
function waitForShutdownSignal(logger: Logger): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      logger.info("shutdown signal received", { action: "signal", signal });
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolvePromise();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
