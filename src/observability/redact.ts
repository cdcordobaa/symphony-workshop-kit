/**
 * Redaction — Symphony spec §15.3 "Secret Handling", requirement FR21.
 *
 * FR21 is absolute: *no secret value* may appear in log output. Meeting that with a
 * single mechanism is not possible, so this module carries two, and they fail in
 * different directions on purpose:
 *
 *   1. **Key-based** ({@link isSecretKey}) — a context key whose name looks like a
 *      credential has its value replaced, whatever the value is. This catches the
 *      common case (`{ auth: "ntn_..." }`) without anyone having to register
 *      anything, but it is blind to a secret that arrives under an innocent name.
 *
 *   2. **Value-based** ({@link SecretRegistry}) — the config layer registers the
 *      *resolved literal* of every secret it reads, and that literal is scrubbed
 *      from every message and every nested value. This is the mechanism that
 *      catches `logger.error("auth failed for ntn_abc123")`, which no key check can
 *      see, and it is why redaction lives in its own module instead of inside the
 *      logger: §6.4's `$VAR` indirection means the config loader is the only layer
 *      that ever holds the plaintext, so it must be able to hand it over here.
 *
 * Both run on every record. Neither is sufficient alone.
 */

/** Replacement written in place of a redacted value. */
export const REDACTED = "[REDACTED]";

/**
 * Registered secrets shorter than this are ignored by {@link SecretRegistry.scrub}.
 *
 * Scrubbing a 1-5 character literal would corrupt unrelated output — registering
 * `"key"` would rewrite every message containing that word — and a redaction
 * mechanism that mangles logs gets turned off, which is worse than the leak it
 * prevents. Short secrets stay covered by the key-based path.
 */
export const MIN_REGISTERED_SECRET_LENGTH = 6;

/**
 * Key-name fragments that mark a value as secret. Matched as substrings against the
 * key with case and separators stripped, so `apiKey`, `api_key`, and `API-KEY` all
 * hit `apikey`.
 */
const SECRET_KEY_SUBSTRINGS = [
  "apikey",
  "accesskey",
  "privatekey",
  "secretkey",
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "authorization",
  "cookie",
  "bearer",
];

/**
 * Key names that are secret only as a whole word.
 *
 * `auth` cannot be a substring rule — it would redact `author` — and `key` cannot
 * either, or the workspace layer's `workspace_key` (§4.1.4, a sanitized issue
 * identifier and explicitly not a secret) would come out as `[REDACTED]`.
 */
const SECRET_KEY_EXACT = new Set(["auth", "key", "pwd", "pass"]);

/** Lowercase a key and drop separators, so naming style cannot dodge a rule. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether a context key's value must be redacted on name alone. */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEY_EXACT.has(normalized)) return true;
  return SECRET_KEY_SUBSTRINGS.some((fragment) => normalized.includes(fragment));
}

/** Escape a literal for use inside a `RegExp`. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A set of secret literals to scrub from log output.
 *
 * Deliberately mutable and shared: the config loader (ARK-59) resolves `$VAR`s
 * after the logger has already been constructed, so the registry a logger holds
 * must be the same object the loader later writes into.
 */
export interface SecretRegistry {
  /**
   * Register secret literals. Nullish, empty, and values shorter than
   * {@link MIN_REGISTERED_SECRET_LENGTH} are ignored.
   *
   * @returns the number of values actually added.
   */
  register(...values: Array<string | null | undefined>): number;
  /** Replace every registered literal in `text` with {@link REDACTED}. */
  scrub(text: string): string;
  /** Whether this exact literal is registered. */
  has(value: string): boolean;
  /** How many literals are registered. */
  readonly size: number;
  /** Forget every registered literal. */
  clear(): void;
}

/** Create a {@link SecretRegistry}, optionally pre-registering `initial` literals. */
export function createSecretRegistry(
  ...initial: Array<string | null | undefined>
): SecretRegistry {
  const secrets = new Set<string>();

  const registry: SecretRegistry = {
    register(...values) {
      let added = 0;
      for (const value of values) {
        if (typeof value !== "string") continue;
        if (value.length < MIN_REGISTERED_SECRET_LENGTH) continue;
        if (secrets.has(value)) continue;
        secrets.add(value);
        added += 1;
      }
      return added;
    },

    scrub(text) {
      if (secrets.size === 0 || text.length === 0) return text;
      // Longest first: a short secret that is a substring of a longer one must not
      // chop the longer one into pieces that then fail to match.
      const ordered = [...secrets].sort((a, b) => b.length - a.length);
      let scrubbed = text;
      for (const secret of ordered) {
        if (!scrubbed.includes(secret)) continue;
        scrubbed = scrubbed.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
      }
      return scrubbed;
    },

    has(value) {
      return secrets.has(value);
    },

    get size() {
      return secrets.size;
    },

    clear() {
      secrets.clear();
    },
  };

  registry.register(...initial);
  return registry;
}

/** Tuning for {@link redactValue} / {@link redactContext}. */
export interface RedactOptions {
  /** Literals to scrub from strings. Defaults to no value-based scrubbing. */
  secrets?: SecretRegistry;
  /** Maximum nesting depth before a value is replaced by a marker. Default `6`. */
  maxDepth?: number;
  /** Maximum length of any single string. Default `2048`. */
  maxStringLength?: number;
  /** Maximum array entries kept. Default `50`. */
  maxArrayLength?: number;
}

interface ResolvedRedactOptions {
  secrets: SecretRegistry | undefined;
  maxDepth: number;
  maxStringLength: number;
  maxArrayLength: number;
}

function resolve(options: RedactOptions | undefined): ResolvedRedactOptions {
  return {
    secrets: options?.secrets,
    maxDepth: options?.maxDepth ?? 6,
    maxStringLength: options?.maxStringLength ?? 2048,
    maxArrayLength: options?.maxArrayLength ?? 50,
  };
}

/** Scrub, then truncate — §13.1 "avoid logging large raw payloads". */
function cleanString(value: string, options: ResolvedRedactOptions): string {
  const scrubbed = options.secrets ? options.secrets.scrub(value) : value;
  if (scrubbed.length <= options.maxStringLength) return scrubbed;
  const kept = scrubbed.slice(0, options.maxStringLength);
  return `${kept}...[truncated ${scrubbed.length - options.maxStringLength} chars]`;
}

function walk(
  value: unknown,
  options: ResolvedRedactOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return cleanString(value, options);
    case "number":
      // JSON has no NaN/Infinity; emit something a parser will accept.
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
      return undefined;
    case "function":
      return "[Function]";
    case "symbol":
      return value.toString();
    default:
      break;
  }

  const object = value as object;

  if (seen.has(object)) return "[Circular]";
  if (depth >= options.maxDepth) return "[MaxDepth]";

  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
  }

  if (object instanceof Error) {
    seen.add(object);
    const shaped: Record<string, unknown> = {
      name: cleanString(object.name, options),
      message: cleanString(object.message, options),
    };
    if (typeof object.stack === "string") {
      shaped.stack = cleanString(object.stack, options);
    }
    if (object.cause !== undefined) {
      shaped.cause = walk(object.cause, options, depth + 1, seen);
    }
    seen.delete(object);
    return shaped;
  }

  if (Array.isArray(object)) {
    seen.add(object);
    const kept = object.slice(0, options.maxArrayLength);
    const mapped: unknown[] = kept.map((entry) =>
      walk(entry, options, depth + 1, seen),
    );
    if (object.length > options.maxArrayLength) {
      mapped.push(`[+${object.length - options.maxArrayLength} more]`);
    }
    seen.delete(object);
    return mapped;
  }

  if (object instanceof Set) {
    return walk([...object], options, depth, seen);
  }

  if (object instanceof Map) {
    return walk(Object.fromEntries(object), options, depth, seen);
  }

  seen.add(object);
  const shaped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object as Record<string, unknown>)) {
    if (entry === undefined) continue;
    shaped[key] = isSecretKey(key)
      ? REDACTED
      : walk(entry, options, depth + 1, seen);
  }
  seen.delete(object);
  return shaped;
}

/**
 * Redact one arbitrary value: scrub registered secrets from every string, replace
 * values under secret-looking keys, and bound depth, string length, and array size.
 *
 * Always returns JSON-safe data, and never mutates the input.
 */
export function redactValue(value: unknown, options?: RedactOptions): unknown {
  return walk(value, resolve(options), 0, new WeakSet<object>());
}

/**
 * Redact a log context into a JSON-serializable object.
 *
 * `undefined` entries are dropped rather than emitted as `null`: `LogContext`
 * declares `issue_id` and friends optional, and a caller spreading a partially
 * populated object should not produce `"issue_id": null` noise in the output.
 */
export function redactContext(
  context: Record<string, unknown> | undefined,
  options?: RedactOptions,
): Record<string, unknown> {
  if (!context) return {};
  const resolved = resolve(options);
  const seen = new WeakSet<object>();
  const shaped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    shaped[key] = isSecretKey(key) ? REDACTED : walk(value, resolved, 1, seen);
  }
  return shaped;
}
