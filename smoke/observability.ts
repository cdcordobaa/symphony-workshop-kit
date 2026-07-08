/**
 * smoke:observability — evidence that the Observability layer (SYM-003 / ARK-51)
 * does its real job (§13):
 *   1. emits a structured log line carrying the REQUIRED §13.1 context fields
 *      `issue_id` / `issue_identifier` / `session_id`, in both JSON-line
 *      (machine-parseable) and `key=value` (human-readable) form;
 *   2. renders a status line reflecting N currently-active runs (FR19);
 *   3. proves secret values never appear in output (FR21);
 *   4. proves a failing sink does not crash the caller.
 *
 * Usage: `tsx smoke/observability.ts`
 */

import { createLogger, formatJsonLine, formatTextLine } from "../src/observability/logger.js";
import { createStatusSurface } from "../src/observability/status.js";
import type { LogRecord } from "../src/domain/interfaces.js";

function main(): void {
  const SECRET = "ntn_live_this_must_never_be_printed";
  const captured: LogRecord[] = [];
  const capture = { write: (r: LogRecord) => void captured.push(r) };

  console.log("[smoke:observability] 1) structured log with §13.1 context fields\n");
  const base = createLogger({ sinks: [capture], secrets: [SECRET] });
  const issueLog = base.child({ issue_id: "iss_9f2", issue_identifier: "ARK-51" });
  const sessionLog = issueLog.child({ session_id: "sess_c0ffee" });

  sessionLog.info(`agent turn completed (using token ${SECRET})`, {
    outcome: "completed",
    auth: SECRET,
  });

  const rec = captured[0]!;
  console.log("  JSON line (machine-parseable):");
  console.log("    " + formatJsonLine(rec));
  console.log("  text line (human-readable key=value):");
  console.log("    " + formatTextLine(rec));

  const hasFields =
    rec.context.issue_id === "iss_9f2" &&
    rec.context.issue_identifier === "ARK-51" &&
    rec.context.session_id === "sess_c0ffee";
  console.log(`  context fields present (issue_id/issue_identifier/session_id): ${hasFields}`);

  console.log("\n[smoke:observability] 2) terminal status line for N active runs (FR19)\n");
  const status = createStatusSurface({ label: "symphony" });
  console.log("  " + status.render());
  status.upsert({ issue_identifier: "ARK-51", session_id: "sess_c0ffee", phase: "running" });
  status.upsert({ issue_identifier: "ARK-52", phase: "running" });
  status.upsert({ issue_identifier: "ARK-53", phase: "retrying" });
  console.log("  " + status.render());
  status.remove("ARK-52");
  console.log("  " + status.render());

  console.log("\n[smoke:observability] 3) secret redaction (FR21)\n");
  const serialized = JSON.stringify(captured);
  const leaked = serialized.includes(SECRET);
  console.log(`  secret present in any log output: ${leaked}`);

  console.log("\n[smoke:observability] 4) failing sink does not crash the caller (§13.2)\n");
  const boom = {
    write() {
      throw new Error("simulated sink failure");
    },
  };
  const resilient = createLogger({ sinks: [boom, capture] });
  let threw = false;
  try {
    resilient.error("this record hits a broken sink first", { issue_identifier: "ARK-51" });
  } catch {
    threw = true;
  }
  console.log(`  logger threw into caller: ${threw}`);

  const ok = hasFields && !leaked && !threw;
  console.log(
    `\n[smoke:observability] done — ${ok ? "PASS" : "FAIL"}: structured logs + status line + no secret leak + sink-failure isolation.`,
  );
  if (!ok) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`[smoke:observability] FAILED: ${(error as Error).message}`);
  process.exit(1);
}
