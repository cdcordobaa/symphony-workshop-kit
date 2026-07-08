/**
 * State-name predicates shared by eligibility, reconciliation, and the blocker
 * rule (Symphony spec §7, §8.2). Tracker state names are compared
 * case-insensitively (§4.1.1: "Current tracker state name (compared after
 * lowercasing)").
 */

/** Lowercased, trimmed set for O(1) case-insensitive membership tests. */
export function stateSet(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map((n) => n.trim().toLowerCase()));
}

/** True when `state` (case-insensitive) is a member of `names`. `null` is never a member. */
export function stateIn(state: string | null, names: readonly string[]): boolean {
  if (state === null) return false;
  return stateSet(names).has(state.trim().toLowerCase());
}
