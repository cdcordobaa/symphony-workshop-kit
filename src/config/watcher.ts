/**
 * Dynamic `WORKFLOW.md` watch/reload (Symphony spec §6.2, PRD §5.3 / DEV-5).
 *
 * Editing the loaded workflow file must take effect **without restarting the
 * daemon**. This module owns the detect → re-read → re-resolve → re-validate
 * half of that contract; applying the result to the running loop is the
 * orchestrator's job ({@link import("../orchestrator/orchestrator.js").Orchestrator.applyConfig}).
 *
 * Design commitments:
 *
 *   - **Injected watch seam.** The filesystem notification source is a
 *     {@link WorkflowWatch} function. Production passes {@link createFsWatch};
 *     tests pass a fake that fires `onChange()` synchronously, so no test ever
 *     sleeps on a real `fs.watch` event.
 *   - **A bad edit never takes the orchestrator down** (§6.2 last bullet). A
 *     reload that fails to read, parse, resolve, or preflight is REJECTED: the
 *     error is logged operator-visibly, the previous good config is retained, and
 *     {@link ConfigWatcher.reloadNow} returns `false`. Nothing throws.
 *   - **FR21 redaction holds across reloads.** `tracker.auth` is compared in
 *     memory but never logged — success logs carry only the workflow path and the
 *     two live-tunable scheduling fields.
 *   - **In-flight runs are undisturbed.** A reload only changes what SUBSEQUENT
 *     scheduling decisions see; this module never touches workers.
 */

import { watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { Logger } from "../domain/interfaces.js";
import type { ServiceConfig } from "../domain/types.js";
import { resolveConfig } from "./config.js";
import { isWorkflowError } from "./errors.js";
import { loadWorkflowFile } from "./loader.js";
import { preflightConfig } from "./preflight.js";

type Env = Record<string, string | undefined>;

/** Handle returned by a {@link WorkflowWatch}; `close()` MUST be idempotent. */
export interface WorkflowWatchHandle {
  close(): void;
}

/**
 * The injected watch seam: subscribe to changes of `path` and invoke `onChange`
 * whenever the file may have changed. Implementations MAY over-notify (the
 * reloader is idempotent and skips no-op reloads).
 */
export type WorkflowWatch = (path: string, onChange: () => void) => WorkflowWatchHandle;

/** The workflow payload a successful reload produces. */
export interface WorkflowSnapshot {
  config: ServiceConfig;
  promptTemplate: string;
}

/** A rejected reload, carrying operator-visible reasons. */
export interface ReloadFailure {
  ok: false;
  errors: string[];
}

/** An accepted reload. */
export interface ReloadSuccess extends WorkflowSnapshot {
  ok: true;
}

export type ReloadResult = ReloadSuccess | ReloadFailure;

/**
 * Re-read + re-resolve + re-validate a workflow file. Never throws: a read,
 * parse, coercion, or preflight failure comes back as {@link ReloadFailure} with
 * the operator-visible messages (§6.2, §6.3).
 */
export function reloadWorkflow(path: string, env: Env = process.env): ReloadResult {
  let snapshot: WorkflowSnapshot;
  try {
    const workflow = loadWorkflowFile(path);
    snapshot = {
      config: resolveConfig(workflow, env),
      promptTemplate: workflow.prompt_template,
    };
  } catch (error) {
    const detail = isWorkflowError(error)
      ? `[${error.code}] ${error.message}`
      : `Failed to load workflow: ${(error as Error)?.message ?? String(error)}`;
    return { ok: false, errors: [detail] };
  }

  const preflight = preflightConfig(snapshot.config);
  if (!preflight.ok) return { ok: false, errors: preflight.errors };

  return { ok: true, ...snapshot };
}

/**
 * Default production watch seam. Watches the *directory* containing the workflow
 * file (filtering on its basename) rather than the file itself, so an editor that
 * replaces the file atomically — write-to-temp + rename, which detaches an inode
 * watch — still produces change events. Bursts are debounced because a single
 * save commonly emits several `rename`/`change` events.
 *
 * A watcher error is logged and swallowed: losing the watch degrades the daemon
 * to "no dynamic reload", it never kills it.
 */
export function createFsWatch(logger?: Logger, debounceMs = 50): WorkflowWatch {
  return (path, onChange) => {
    const dir = dirname(path);
    const name = basename(path);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: FSWatcher | null = null;

    const fire = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, debounceMs);
      // A pending reload must never hold the process open on its own.
      timer.unref?.();
    };

    try {
      watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
        if (filename === null || filename === undefined || basename(String(filename)) === name) {
          fire();
        }
      });
      watcher.on("error", (error) => {
        logger?.warn("workflow watch error (dynamic reload disabled)", {
          action: "config_watch",
          error: (error as Error)?.message ?? String(error),
        });
      });
    } catch (error) {
      logger?.warn("could not watch workflow file (dynamic reload disabled)", {
        action: "config_watch",
        workflow: path,
        error: (error as Error)?.message ?? String(error),
      });
    }

    return {
      close: () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        watcher?.close();
        watcher = null;
      },
    };
  };
}

/** Dependencies for {@link createConfigWatcher}. */
export interface ConfigWatcherDeps {
  /** Absolute path of the loaded `WORKFLOW.md`. */
  path: string;
  /** The last-known-good snapshot from startup (already validated). */
  initial: WorkflowSnapshot;
  /** Called ONLY for an accepted, changed reload. Must not throw. */
  onReload: (snapshot: WorkflowSnapshot) => void;
  logger: Logger;
  /** Environment used for `$VAR` indirection on each reload. Defaults to `process.env`. */
  env?: Env;
  /** Injected watch seam (tests). Defaults to {@link createFsWatch}. */
  watch?: WorkflowWatch;
}

/**
 * Watches one `WORKFLOW.md` and pushes accepted reloads to `onReload`.
 *
 * The watcher is the sole owner of "what is the current good config"; the caller
 * reads it back with {@link ConfigWatcher.current}. A rejected reload leaves that
 * value untouched, which is precisely the §6.2 "keep operating with the last
 * known good effective configuration" guarantee.
 */
export class ConfigWatcher {
  private readonly path: string;
  private readonly onReload: (snapshot: WorkflowSnapshot) => void;
  private readonly logger: Logger;
  private readonly env: Env;
  private readonly watch: WorkflowWatch;

  /** Last-known-good snapshot. Only ever replaced by an accepted reload. */
  private snapshot: WorkflowSnapshot;
  private handle: WorkflowWatchHandle | null = null;
  private stopped = false;

  constructor(deps: ConfigWatcherDeps) {
    this.path = deps.path;
    this.onReload = deps.onReload;
    this.logger = deps.logger;
    this.env = deps.env ?? process.env;
    this.watch = deps.watch ?? createFsWatch(deps.logger);
    this.snapshot = deps.initial;
  }

  /** The last-known-good workflow snapshot (startup's, or the newest accepted reload). */
  current(): WorkflowSnapshot {
    return this.snapshot;
  }

  /** Subscribe to file changes. Idempotent; a second call is a no-op. */
  start(): void {
    if (this.handle !== null || this.stopped) return;
    this.handle = this.watch(this.path, () => {
      this.reloadNow();
    });
    this.logger.info("watching workflow for changes", {
      action: "config_watch",
      workflow: this.path,
    });
  }

  /** Unsubscribe. Idempotent and safe to call from a shutdown path. */
  stop(): void {
    this.stopped = true;
    if (this.handle === null) return;
    try {
      this.handle.close();
    } catch {
      /* a watcher that fails to close must not break shutdown. */
    }
    this.handle = null;
  }

  /**
   * Re-read the workflow now and, if it is valid AND different from the last good
   * snapshot, adopt it and notify `onReload`.
   *
   * @returns `true` when a new config was adopted; `false` when the edit was
   *          rejected (previous config retained) or was a no-op. NEVER throws —
   *          this is invoked straight from a filesystem callback.
   */
  reloadNow(): boolean {
    if (this.stopped) return false;

    const result = reloadWorkflow(this.path, this.env);

    if (!result.ok) {
      // §6.2: invalid reloads keep the last known good config and stay alive.
      this.logger.error("workflow reload rejected; keeping previous config", {
        action: "config_reload",
        outcome: "rejected",
        workflow: this.path,
        errors: result.errors,
      });
      return false;
    }

    const next: WorkflowSnapshot = {
      config: result.config,
      promptTemplate: result.promptTemplate,
    };
    if (!hasChanged(this.snapshot, next)) {
      // fs.watch over-notifies (one save can emit several events); do not churn.
      this.logger.debug("workflow reload skipped; no effective change", {
        action: "config_reload",
        outcome: "unchanged",
        workflow: this.path,
      });
      return false;
    }

    this.snapshot = next;
    // FR21: log the path and the live-tunable scheduling fields ONLY — never `tracker.auth`.
    this.logger.info("workflow reloaded", {
      action: "config_reload",
      outcome: "applied",
      workflow: this.path,
      poll_interval_ms: next.config.polling.interval_ms,
      max_concurrent_agents: next.config.agent.max_concurrent_agents,
    });

    try {
      this.onReload(next);
    } catch (error) {
      // An apply failure is logged, not propagated: the daemon outlives it.
      this.logger.error("applying reloaded workflow failed (recovered)", {
        action: "config_reload",
        outcome: "apply_failed",
        error: (error as Error)?.message ?? String(error),
      });
    }
    return true;
  }
}

/**
 * Structural comparison of two snapshots. Config is compared by value (the typed
 * view is plain JSON-serializable data), so a touch that does not change meaning
 * is a no-op. The comparison happens entirely in memory — nothing is printed.
 */
function hasChanged(previous: WorkflowSnapshot, next: WorkflowSnapshot): boolean {
  if (previous.promptTemplate !== next.promptTemplate) return true;
  return JSON.stringify(previous.config) !== JSON.stringify(next.config);
}

/** Create a {@link ConfigWatcher} bound to `deps`. */
export function createConfigWatcher(deps: ConfigWatcherDeps): ConfigWatcher {
  return new ConfigWatcher(deps);
}
