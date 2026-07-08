/**
 * Typed config layer (Symphony spec §6, Notion variant).
 *
 * Resolution pipeline (§6.1):
 *   1. Workflow path selected by the loader.
 *   2. Front matter parsed into a raw config map.
 *   3. Built-in defaults applied for missing OPTIONAL fields.
 *   4. `$VAR` indirection resolved ONLY for values that explicitly reference it.
 *   5. Typed values coerced and validated.
 *
 * Environment variables never globally override YAML; they are consulted only
 * where a value explicitly references `$VAR` (or, for `tracker.auth`, as a
 * documented canonical fallback when the field is omitted entirely).
 */

import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  AgentConfig,
  HooksConfig,
  PollingConfig,
  ServiceConfig,
  TrackerConfig,
  WorkspaceConfig,
} from "../domain/types.js";
import { WorkflowError } from "./errors.js";
import type { WorkflowDefinition } from "./loader.js";

/** Canonical environment variable consulted when `tracker.auth` is omitted entirely. */
const CANONICAL_AUTH_ENV = "NOTION_API_KEY";

type Env = Record<string, string | undefined>;

/**
 * Resolve a {@link WorkflowDefinition} into a typed {@link ServiceConfig}.
 *
 * @param workflow  Parsed workflow payload (carries `source_path` for relative resolution).
 * @param env       Environment used for `$VAR` indirection. Defaults to `process.env`.
 */
export function resolveConfig(
  workflow: WorkflowDefinition,
  env: Env = process.env,
): ServiceConfig {
  const root = workflow.config;
  const baseDir = dirname(workflow.source_path);

  return {
    tracker: resolveTracker(asMap(root["tracker"], "tracker"), env),
    polling: resolvePolling(asMap(root["polling"], "polling")),
    workspace: resolveWorkspace(asMap(root["workspace"], "workspace"), baseDir, env),
    hooks: resolveHooks(asMap(root["hooks"], "hooks")),
    agent: resolveAgent(asMap(root["agent"], "agent")),
  };
}

/* --------------------------------- tracker -------------------------------- */

function resolveTracker(raw: Record<string, unknown>, env: Env): TrackerConfig {
  const kind = optionalString(raw["kind"], "tracker.kind") ?? "";

  // auth: literal token or `$VAR`. Omitted entirely -> canonical env fallback.
  let auth: string | null;
  if (raw["auth"] === undefined || raw["auth"] === null) {
    auth = nonEmptyOrNull(env[CANONICAL_AUTH_ENV]);
  } else {
    const literal = requireString(raw["auth"], "tracker.auth");
    auth = nonEmptyOrNull(expandVars(literal, env));
  }

  const databaseRaw = optionalString(raw["database_id"], "tracker.database_id");
  const database_id =
    databaseRaw === undefined ? null : nonEmptyOrNull(expandVars(databaseRaw, env));

  return {
    kind,
    auth,
    database_id,
    active_states: stringList(raw["active_states"], "tracker.active_states", [
      "Todo",
      "In Progress",
    ]),
    terminal_states: stringList(raw["terminal_states"], "tracker.terminal_states", [
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]),
  };
}

/* --------------------------------- polling -------------------------------- */

function resolvePolling(raw: Record<string, unknown>): PollingConfig {
  return {
    interval_ms: positiveInt(raw["interval_ms"], "polling.interval_ms", 30_000),
  };
}

/* -------------------------------- workspace ------------------------------- */

function resolveWorkspace(
  raw: Record<string, unknown>,
  baseDir: string,
  env: Env,
): WorkspaceConfig {
  const rootRaw = optionalString(raw["root"], "workspace.root");
  const root =
    rootRaw === undefined
      ? resolve(tmpdir(), "symphony_workspaces")
      : resolvePathValue(rootRaw, baseDir, env);
  return { root };
}

/* ---------------------------------- hooks --------------------------------- */

function resolveHooks(raw: Record<string, unknown>): HooksConfig {
  return {
    after_create: optionalString(raw["after_create"], "hooks.after_create") ?? null,
    before_run: optionalString(raw["before_run"], "hooks.before_run") ?? null,
    after_run: optionalString(raw["after_run"], "hooks.after_run") ?? null,
    before_remove: optionalString(raw["before_remove"], "hooks.before_remove") ?? null,
    timeout_ms: positiveInt(raw["timeout_ms"], "hooks.timeout_ms", 60_000),
  };
}

/* ---------------------------------- agent --------------------------------- */

function resolveAgent(raw: Record<string, unknown>): AgentConfig {
  return {
    command: optionalString(raw["command"], "agent.command") ?? "claude",
    max_concurrent_agents: positiveInt(
      raw["max_concurrent_agents"],
      "agent.max_concurrent_agents",
      10,
    ),
    max_turns: positiveInt(raw["max_turns"], "agent.max_turns", 20),
    max_retry_backoff_ms: positiveInt(
      raw["max_retry_backoff_ms"],
      "agent.max_retry_backoff_ms",
      300_000,
    ),
    max_concurrent_agents_by_state: concurrencyByState(raw["max_concurrent_agents_by_state"]),
    turn_timeout_ms: positiveInt(raw["turn_timeout_ms"], "agent.turn_timeout_ms", 3_600_000),
    read_timeout_ms: positiveInt(raw["read_timeout_ms"], "agent.read_timeout_ms", 5_000),
    // stall_timeout_ms may be <= 0 to disable stall detection (§5.3.6), so it is an int, not positive-int.
    stall_timeout_ms: intOrDefault(raw["stall_timeout_ms"], "agent.stall_timeout_ms", 300_000),
    approval_policy: optionalString(raw["approval_policy"], "agent.approval_policy") ?? null,
    thread_sandbox: optionalString(raw["thread_sandbox"], "agent.thread_sandbox") ?? null,
    turn_sandbox_policy:
      optionalString(raw["turn_sandbox_policy"], "agent.turn_sandbox_policy") ?? null,
  };
}

/**
 * Normalize a per-state concurrency map (§5.3.5): keys lowercased, entries that
 * are non-numeric or non-positive are ignored rather than failing validation.
 */
function concurrencyByState(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === undefined || value === null) return out;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowError(
      "config_validation_error",
      "agent.max_concurrent_agents_by_state must be a map of state names to positive integers.",
    );
  }
  for (const [state, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isInteger(n) && n > 0) {
      out[state.toLowerCase()] = n;
    }
  }
  return out;
}

/* ----------------------- $VAR / path expansion ---------------------------- */

/**
 * Expand `$NAME` and `${NAME}` tokens against `env`. An unset variable expands to
 * an empty string (callers decide whether empty means "missing"). Used for
 * env-backed config values (auth, database id, path fields). It deliberately does
 * not rewrite arbitrary URIs or shell command strings (§6.1).
 */
export function expandVars(value: string, env: Env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
    const name = (braced ?? bare) as string;
    return env[name] ?? "";
  });
}

/**
 * Resolve a filesystem path config value: expand `$VAR`, expand a leading `~`,
 * then resolve relative paths against the WORKFLOW.md directory and normalize to
 * an absolute path (§6.1).
 */
export function resolvePathValue(value: string, baseDir: string, env: Env): string {
  let expanded = expandVars(value, env);
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = expanded === "~" ? homedir() : resolve(homedir(), expanded.slice(2));
  }
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/* ------------------------------ coercion utils ---------------------------- */

function asMap(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowError("config_validation_error", `${label} must be a map/object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new WorkflowError("config_validation_error", `${label} must be a string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label);
}

function nonEmptyOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.length > 0 ? value : null;
}

function stringList(value: unknown, label: string, fallback: string[]): string[] {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) {
    throw new WorkflowError("config_validation_error", `${label} must be a list of strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new WorkflowError(
        "config_validation_error",
        `${label}[${index}] must be a string.`,
      );
    }
    return item;
  });
}

function intOrDefault(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new WorkflowError("config_validation_error", `${label} must be an integer.`);
  }
  return n;
}

function positiveInt(value: unknown, label: string, fallback: number): number {
  const n = intOrDefault(value, label, fallback);
  if (n <= 0) {
    throw new WorkflowError("config_validation_error", `${label} must be a positive integer.`);
  }
  return n;
}
