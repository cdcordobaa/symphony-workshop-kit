/**
 * Secret-safe rendering of a {@link ServiceConfig} (Symphony spec §15.3).
 *
 * The resolved config carries a live secret in `tracker.auth` (the Notion
 * integration token). Anything that prints or logs the config — the `smoke:config`
 * evidence run, operator diagnostics, structured logs — MUST go through
 * {@link redactConfig} first so the token value is NEVER emitted. We report only
 * its *presence* (`"<set>"` / `"<missing>"`), never the value or its length.
 */

import type { ServiceConfig } from "../domain/types.js";

/** Presence marker substituted for a secret value that is set. */
export const SECRET_SET = "<set>";
/** Presence marker substituted for a secret value that is absent/empty. */
export const SECRET_MISSING = "<missing>";

/** A {@link ServiceConfig} view safe to print/log: secrets replaced by presence markers. */
export interface RedactedConfig extends Omit<ServiceConfig, "tracker"> {
  tracker: Omit<ServiceConfig["tracker"], "auth"> & { auth: string };
}

/** Map a secret to its presence marker without revealing the value or length. */
function presence(secret: string | null): string {
  return secret !== null && secret.length > 0 ? SECRET_SET : SECRET_MISSING;
}

/**
 * Return a deep-safe copy of `config` with `tracker.auth` reduced to a presence
 * marker. The `database_id` is an identifier (not a secret) and is preserved so
 * operators can confirm which board is targeted.
 */
export function redactConfig(config: ServiceConfig): RedactedConfig {
  return {
    ...config,
    tracker: {
      ...config.tracker,
      auth: presence(config.tracker.auth),
    },
  };
}
