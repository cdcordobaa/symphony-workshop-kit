/**
 * Value-resolution primitives (SYMPHONY-SPEC §6.1):
 *  - `$VAR_NAME` indirection, resolved ONLY for values that explicitly
 *    reference an env var (env does not globally override YAML).
 *  - `~` home expansion + relative-path resolution (relative to the WORKFLOW.md
 *    directory) for path fields.
 */

import os from "node:os";
import path from "node:path";

/** Matches a value that is exactly `$VAR_NAME` (optionally `${VAR_NAME}`). */
const FULL_VAR_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

/**
 * Resolve `$VAR` indirection for a single string value.
 *
 * Only applies when the WHOLE value is a `$VAR` reference (per §6.1: "only for
 * config values that explicitly reference them"). A `$VAR` that resolves to an
 * empty/undefined env value yields an empty string so callers can treat it as
 * "missing". Non-`$VAR` strings are returned unchanged.
 */
export function resolveVar(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const m = FULL_VAR_RE.exec(value.trim());
  if (!m) return value;
  const name = m[1]!;
  const resolved = env[name];
  return resolved === undefined ? "" : resolved;
}

/**
 * Expand a path field: `$VAR` indirection, then `~` home expansion, then
 * absolute normalization relative to `baseDir` (the WORKFLOW.md directory).
 */
export function resolvePath(
  value: string,
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let v = resolveVar(value, env);

  if (v === "~") {
    v = os.homedir();
  } else if (v.startsWith("~/") || v.startsWith("~\\")) {
    v = path.join(os.homedir(), v.slice(2));
  }

  if (path.isAbsolute(v)) {
    return path.normalize(v);
  }
  return path.resolve(baseDir, v);
}
