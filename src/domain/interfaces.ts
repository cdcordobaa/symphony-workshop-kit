/**
 * Port interfaces — the seams later units implement (Symphony spec §9, §10.7, §11.1, §13).
 *
 * Declarations only: no behavior, and no dependency on any concrete adapter. Each port
 * is named by the §3.2 layer that owns it, so the coordination layer can be written
 * and tested against abstractions while the integration/execution layers are still
 * empty. That inversion is what makes the tracker and the coding agent swappable
 * (PRD §2) — the orchestrator never learns that Notion or Claude Code exist.
 */

import type {
  Issue,
  OrchestratorState,
  RunAttempt,
  ServiceConfig,
  Workspace,
  WorkflowDefinition,
} from "./types.js";

/* ------------------------------------------------------------------------- *
 * Integration layer — Tracker (§11.1)
 * ------------------------------------------------------------------------- */

/**
 * Read-only tracker adapter (§11.1). Three operations are REQUIRED; each returns
 * issues already normalized to the §4.1.1 {@link Issue} shape (§11.3).
 *
 * Read-only is a deliberate boundary, not an omission: the orchestrator is a
 * reader and scheduler, never a ticket-writer (§11.5). The *agent* moves the
 * ticket, using its own tools; the orchestrator only observes that a state became
 * terminal and stops the run.
 */
export interface TrackerClient {
  /** Issues currently in `tracker.active_states` for the configured project. */
  fetchCandidateIssues(): Promise<Issue[]>;
  /** Issues in the given states. Used by startup terminal cleanup (§8.6). */
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  /**
   * Current state name per issue id, for active-run reconciliation (§8.5).
   * Ids the tracker no longer returns are omitted from the map.
   */
  fetchIssueStatesByIds(issueIds: string[]): Promise<Record<string, string>>;
}

/* ------------------------------------------------------------------------- *
 * Execution layer — Workspace (§9)
 * ------------------------------------------------------------------------- */

/**
 * Per-issue filesystem lifecycle (§9), responsible for enforcing all three §9.5
 * safety invariants before any agent is launched:
 *
 * 1. the agent's `cwd` equals the workspace path;
 * 2. the workspace path resolves inside the normalized workspace root;
 * 3. the workspace key contains only `[A-Za-z0-9._-]`.
 *
 * Invariants are checked before launch, not after — isolation is enforced, not hoped.
 */
export interface WorkspaceManager {
  /** Deterministic absolute path for an identifier, under the configured root. */
  workspacePathFor(identifier: string): string;
  /**
   * Create-or-reuse the workspace for an identifier. Runs the `after_create` hook
   * only when the directory was newly created (§9.2, §9.4).
   */
  prepare(identifier: string): Promise<Workspace>;
  /** Remove the workspace, running `before_remove` first (§9.4). */
  remove(identifier: string): Promise<void>;
}

/* ------------------------------------------------------------------------- *
 * Execution layer — Agent Runner (§10.7)
 * ------------------------------------------------------------------------- */

/**
 * One coding-agent execution (§10.7): prepare the workspace, render the prompt,
 * start the session, stream events, and resolve when the turn ends.
 *
 * The runner's whole contract is "prompt in, {@link RunAttempt} out", which is why
 * the agent is the replaceable part of the system. On any error it fails the
 * attempt and lets the orchestrator decide retry behavior; it never retries itself.
 * Workspaces are intentionally preserved after a successful run (§10.7).
 */
export interface AgentRunner {
  /** @param attempt `null` for the first run, `>= 1` for retries/continuations (§12.3). */
  run(issue: Issue, attempt: number | null): Promise<RunAttempt>;
}

/* ------------------------------------------------------------------------- *
 * Observability layer — Logger (§13.1) and Status Surface (§13.4)
 * ------------------------------------------------------------------------- */

/** Log severity, ordered least to most severe. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured context attached to a log record (§13.1).
 *
 * `issue_id` and `issue_identifier` are REQUIRED on issue-related logs; `session_id`
 * is REQUIRED on coding-agent session-lifecycle logs. Extra keys are permitted, and
 * secrets MUST be redacted before they reach a sink (§15.3).
 */
export interface LogContext {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
  [key: string]: unknown;
}

/**
 * Structured logger (§13.1–§13.2). Messages use stable `key=value` phrasing and
 * carry the action outcome (`completed`, `failed`, `retrying`, …).
 *
 * Sinks are unspecified by the spec, but startup, validation, and dispatch failures
 * MUST reach an operator without a debugger attached (§13.2).
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Derive a logger that merges `context` into every record it emits. */
  child(context: LogContext): Logger;
}

/**
 * Human-readable operator view (§13.4) — terminal output, dashboard, or similar.
 *
 * OPTIONAL by the spec and explicitly non-load-bearing: it draws from orchestrator
 * state only and MUST NOT be required for correctness, so a failing status surface
 * can never break a run.
 */
export interface StatusSurface {
  /** Render the current snapshot of orchestrator state. */
  render(state: OrchestratorState): void;
  /** Release any resources held by the surface (timers, terminal modes). */
  stop(): void;
}

/* ------------------------------------------------------------------------- *
 * Configuration layer — loader seam (§5, §6)
 * ------------------------------------------------------------------------- */

/**
 * Reads a `WORKFLOW.md` and produces the typed runtime view (§5.1, §6.1).
 *
 * Not one of the five named ports, but the orchestrator needs a seam here to be
 * testable without touching the filesystem. Implemented by ARK-59.
 */
export interface WorkflowLoader {
  /** Parse front matter + prompt body from the file at `path` (§5.2). */
  load(path: string): Promise<WorkflowDefinition>;
  /** Apply defaults, resolve `$VAR`s, normalize paths (§6.1). */
  toServiceConfig(definition: WorkflowDefinition): ServiceConfig;
}
