/**
 * Typed Config Layer (SYMPHONY-SPEC §6, requirements.md §7 — Notion variant).
 *
 * Builds a fully-resolved `ServiceConfig` from the raw front-matter map:
 *  - apply defaults for missing OPTIONAL fields,
 *  - resolve `$VAR` indirection only where referenced,
 *  - `~`/relative path resolution for path fields,
 *  - coerce + lightly validate typed values.
 *
 * Unknown keys are ignored for forward-compatibility (FR-WL-7).
 */

import type {
  AgentConfig,
  HooksConfig,
  PollingConfig,
  ServiceConfig,
  TrackerConfig,
  WorkspaceConfig,
} from "../domain/config.js";
import { SymphonyError } from "../domain/errors.js";
import {
  DEFAULT_ACTIVE_STATES,
  DEFAULT_AGENT_COMMAND,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TERMINAL_STATES,
  DEFAULT_TURN_TIMEOUT_MS,
  defaultWorkspaceRoot,
} from "./defaults.js";
import { resolvePath, resolveVar } from "./resolve.js";

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return null;
  return String(value);
}

function asStringList(value: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [...fallback];
}

/** Coerce to a positive-or-zero integer, falling back when invalid. */
function asInt(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new SymphonyError(
      "invalid_config",
      `Invalid integer for ${field}: ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function asPositiveInt(value: unknown, fallback: number, field: string): number {
  const n = asInt(value, fallback, field);
  if (n <= 0) {
    throw new SymphonyError(
      "invalid_config",
      `${field} must be a positive integer, got ${n}`,
    );
  }
  return n;
}

function buildTracker(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): TrackerConfig {
  const kindRaw = asStringOrNull(raw["kind"]);
  const kind = kindRaw === null ? "" : kindRaw.trim();

  const database = asStringOrNull(raw["database"]);
  const apiKeyRaw = asStringOrNull(raw["api_key"]);
  // `$VAR` resolves; empty after resolution ⇒ treated as missing.
  const apiKey = apiKeyRaw === null ? null : resolveVar(apiKeyRaw, env);

  return {
    kind,
    database: database === null ? null : database.trim() || null,
    api_key: apiKey === null ? null : apiKey,
    active_states: asStringList(raw["active_states"], DEFAULT_ACTIVE_STATES),
    terminal_states: asStringList(
      raw["terminal_states"],
      DEFAULT_TERMINAL_STATES,
    ),
  };
}

function buildPolling(raw: Record<string, unknown>): PollingConfig {
  return {
    interval_ms: asPositiveInt(
      raw["interval_ms"],
      DEFAULT_POLL_INTERVAL_MS,
      "polling.interval_ms",
    ),
  };
}

function buildWorkspace(
  raw: Record<string, unknown>,
  baseDir: string,
  env: NodeJS.ProcessEnv,
): WorkspaceConfig {
  const rootRaw = asStringOrNull(raw["root"]);
  const root =
    rootRaw && rootRaw.trim().length > 0
      ? resolvePath(rootRaw, baseDir, env)
      : defaultWorkspaceRoot();
  return { root };
}

function buildHooks(raw: Record<string, unknown>): HooksConfig {
  return {
    after_create: asStringOrNull(raw["after_create"]),
    before_run: asStringOrNull(raw["before_run"]),
    after_run: asStringOrNull(raw["after_run"]),
    before_remove: asStringOrNull(raw["before_remove"]),
    timeout_ms: asPositiveInt(
      raw["timeout_ms"],
      DEFAULT_HOOK_TIMEOUT_MS,
      "hooks.timeout_ms",
    ),
  };
}

function buildByStateMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const obj = asObject(value);
  for (const [key, raw] of Object.entries(obj)) {
    const n = typeof raw === "number" ? raw : Number(raw);
    // Invalid entries (non-positive / non-numeric) are ignored (§5.3.5).
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      out[key.toLowerCase()] = n;
    }
  }
  return out;
}

function buildAgent(raw: Record<string, unknown>): AgentConfig {
  const commandRaw = asStringOrNull(raw["command"]);
  const command =
    commandRaw && commandRaw.trim().length > 0
      ? commandRaw
      : DEFAULT_AGENT_COMMAND;

  return {
    command,
    max_concurrent_agents: asPositiveInt(
      raw["max_concurrent_agents"],
      DEFAULT_MAX_CONCURRENT_AGENTS,
      "agent.max_concurrent_agents",
    ),
    max_turns: asPositiveInt(raw["max_turns"], DEFAULT_MAX_TURNS, "agent.max_turns"),
    max_retry_backoff_ms: asInt(
      raw["max_retry_backoff_ms"],
      DEFAULT_MAX_RETRY_BACKOFF_MS,
      "agent.max_retry_backoff_ms",
    ),
    max_concurrent_agents_by_state: buildByStateMap(
      raw["max_concurrent_agents_by_state"],
    ),
    turn_timeout_ms: asInt(
      raw["turn_timeout_ms"],
      DEFAULT_TURN_TIMEOUT_MS,
      "agent.turn_timeout_ms",
    ),
    read_timeout_ms: asInt(
      raw["read_timeout_ms"],
      DEFAULT_READ_TIMEOUT_MS,
      "agent.read_timeout_ms",
    ),
    stall_timeout_ms: asInt(
      raw["stall_timeout_ms"],
      DEFAULT_STALL_TIMEOUT_MS,
      "agent.stall_timeout_ms",
    ),
  };
}

/**
 * Build a typed, resolved `ServiceConfig` from a raw front-matter map.
 *
 * @param config  Raw front-matter root object (`WorkflowDefinition.config`).
 * @param baseDir Directory containing WORKFLOW.md (for relative path resolution).
 * @param env     Environment used for `$VAR` resolution (defaults to process env).
 */
export function buildServiceConfig(
  config: Record<string, unknown>,
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  return {
    tracker: buildTracker(asObject(config["tracker"]), env),
    polling: buildPolling(asObject(config["polling"])),
    workspace: buildWorkspace(asObject(config["workspace"]), baseDir, env),
    hooks: buildHooks(asObject(config["hooks"])),
    agent: buildAgent(asObject(config["agent"])),
  };
}
