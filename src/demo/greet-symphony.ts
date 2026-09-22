/**
 * Demo unit (ARK-67) — a wrapper whose only job is to call ARK-66's function.
 *
 * It exists to prove the blocker chain: the import below cannot resolve until
 * `src/demo/hello-symphony.ts` is in the baseline, so this file genuinely could not
 * have been built before ARK-66 merged. It prints nothing itself — the log line is
 * `helloSymphony()`'s, which is what makes the dependency observable rather than
 * decorative. Like its siblings, this is loop instrumentation, not product surface.
 */
import { helloSymphony } from "./hello-symphony.js";

export function greetSymphony(): void {
  helloSymphony();
}
