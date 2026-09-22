/**
 * Demo unit (ARK-65).
 *
 * Deliberately trivial: this exists to exercise the orchestration loop end to end,
 * not to carry product behaviour. It is not part of the §4 domain model and nothing
 * under `src/` depends on it.
 */

export function helloWorld(): void {
  console.log("Hello World");
}
