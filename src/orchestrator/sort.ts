/**
 * Dispatch ordering (Symphony spec §8.2 "Sorting order").
 *
 * Stable intent, applied in order:
 *   1. `priority` ascending — 1..4 preferred; `null`/unknown sorts last.
 *   2. `created_at` oldest first — `null` sorts last.
 *   3. `identifier` lexicographic — deterministic tie-breaker.
 *
 * Pure and side-effect free: it copies the input so the caller's array is never
 * mutated, and the comparator is total so the result is deterministic (FR8).
 */

import type { Issue } from "../domain/types.js";

/** A `null`-aware ascending numeric compare where `null` is treated as `+Infinity`. */
function comparePriority(a: number | null, b: number | null): number {
  const av = a ?? Number.POSITIVE_INFINITY;
  const bv = b ?? Number.POSITIVE_INFINITY;
  return av - bv;
}

/**
 * A `null`-aware ascending timestamp compare where `null` sorts last. Timestamps
 * are normalized ISO-8601 strings (§4), so lexicographic order equals chronological
 * order; we compare via `Date` to be robust to differing precisions.
 */
function compareCreatedAt(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
  if (Number.isNaN(at)) return 1;
  if (Number.isNaN(bt)) return -1;
  return at - bt;
}

/** Return a new array of `issues` ordered for dispatch (§8.2). Input is not mutated. */
export function sortForDispatch(issues: readonly Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const byPriority = comparePriority(a.priority, b.priority);
    if (byPriority !== 0) return byPriority;
    const byCreated = compareCreatedAt(a.created_at, b.created_at);
    if (byCreated !== 0) return byCreated;
    return a.identifier.localeCompare(b.identifier);
  });
}
