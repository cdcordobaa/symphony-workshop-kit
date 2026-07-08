/**
 * The three mandatory workspace safety invariants (Symphony spec §9.5, §15.2).
 *
 * These are the single most important correctness requirement of the MVP gate
 * (PRD §9): they are implemented here as explicit, named, individually-testable
 * checks — never as incidental behavior of directory handling. They remain
 * REQUIRED even though the Security extension is opted out (PRD §7, decision D7).
 *
 *   A — {@link assertCwdIsWorkspace}: the coding agent runs ONLY in the per-issue
 *       workspace path (`cwd == workspace_path`), validated before launch.
 *   B — {@link assertWithinRoot}: the workspace path stays inside the normalized
 *       absolute workspace root; any path that would escape is rejected.
 *   C — {@link sanitizeWorkspaceKey}: workspace directory names use only
 *       `[A-Za-z0-9._-]`; every other character is replaced with `_`.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { WorkspaceError } from "./errors.js";

/** Characters permitted verbatim in a workspace key (§9.5.3). All others → `_`. */
const ALLOWED_KEY_CHAR = /[^A-Za-z0-9._-]/g;

/**
 * Invariant C (§9.5.3): sanitize an issue identifier into a workspace key.
 *
 * Every character outside `[A-Za-z0-9._-]` is replaced with `_`. This alone does
 * NOT guarantee containment — the dot is an allowed character, so an identifier of
 * `..` survives sanitization unchanged; path containment is enforced separately by
 * invariant B ({@link assertWithinRoot}) as defense in depth.
 *
 * @throws {WorkspaceError} `safety_invalid_key` when the identifier is empty/blank,
 *         or sanitizes to a value (`""`, `.`, `..`) that cannot name a per-issue
 *         subdirectory.
 */
export function sanitizeWorkspaceKey(identifier: string): string {
  if (typeof identifier !== "string" || identifier.trim().length === 0) {
    throw new WorkspaceError(
      "safety_invalid_key",
      "workspace key cannot be derived from an empty issue identifier.",
    );
  }
  const key = identifier.replace(ALLOWED_KEY_CHAR, "_");
  if (key.length === 0 || key === "." || key === "..") {
    throw new WorkspaceError(
      "safety_invalid_key",
      `issue identifier ${JSON.stringify(identifier)} sanitizes to the unusable key ${JSON.stringify(key)}.`,
    );
  }
  return key;
}

/**
 * Invariant B (§9.5.2): assert that `candidate` resolves to a location strictly
 * inside the normalized absolute `root`, and return the normalized absolute path.
 *
 * Both paths are normalized to absolute, then containment is checked via the
 * relative path from root to candidate: it must be non-empty (candidate is not the
 * root itself), must not start with `..` (candidate is not an ancestor/sibling),
 * and must not be absolute (candidate is not on a different volume). This rejects
 * classic escapes (`../evil`) and prefix look-alikes (`/srv/wsX` vs root `/srv/ws`).
 *
 * @throws {WorkspaceError} `safety_root_escape` when the candidate is not contained.
 */
export function assertWithinRoot(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(absoluteRoot, candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);

  const escapes = rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new WorkspaceError(
      "safety_root_escape",
      `workspace path ${JSON.stringify(absoluteCandidate)} escapes the workspace root ${JSON.stringify(absoluteRoot)}.`,
    );
  }
  return absoluteCandidate;
}

/**
 * Invariant A (§9.5.1 / §15.2): assert that the `cwd` a subprocess is about to be
 * launched with equals the per-issue `workspacePath`. Both are normalized to
 * absolute before comparison so equivalent-but-differently-spelled paths match.
 * Called immediately before the agent launch (re-checked in ARK-54 / SYM-006).
 *
 * @throws {WorkspaceError} `safety_cwd_mismatch` when the two do not match.
 */
export function assertCwdIsWorkspace(cwd: string, workspacePath: string): void {
  const absoluteCwd = resolve(cwd);
  const absoluteWorkspace = resolve(workspacePath);
  if (absoluteCwd !== absoluteWorkspace) {
    throw new WorkspaceError(
      "safety_cwd_mismatch",
      `agent cwd ${JSON.stringify(absoluteCwd)} must equal the workspace path ${JSON.stringify(absoluteWorkspace)}.`,
    );
  }
}
