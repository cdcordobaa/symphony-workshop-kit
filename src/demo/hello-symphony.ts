/**
 * Demo unit (ARK-66) — exists to exercise the orchestration loop end to end.
 *
 * Deliberately trivial: one log line, no arguments, no dependencies, no coupling to
 * `src/domain/` or any other unit. Nothing here is part of the Symphony product surface.
 */
export function helloSymphony(): void {
  console.log("Hello Symphony");
}
