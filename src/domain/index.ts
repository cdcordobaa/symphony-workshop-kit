/**
 * Public surface of the domain layer (Symphony spec §4).
 *
 * Every other unit imports from `src/domain/index.js` rather than reaching into
 * individual files, so the §3.2 boundary stays a single, greppable seam.
 */

export type {
  AgentConfig,
  BlockerRef,
  HooksConfig,
  Issue,
  OrchestratorState,
  PollingConfig,
  RunAttempt,
  RunAttemptStatus,
  RunningEntry,
  ServiceConfig,
  TrackerConfig,
  Workspace,
  WorkspaceConfig,
  WorkflowDefinition,
} from "./types.js";

export type {
  AgentRunner,
  LogContext,
  Logger,
  LogLevel,
  StatusSurface,
  TrackerClient,
  WorkflowLoader,
  WorkspaceManager,
} from "./interfaces.js";
