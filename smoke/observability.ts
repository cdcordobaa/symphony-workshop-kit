/**
 * Smoke — observability unit (ARK-60 / SYM-003).
 *
 * `BUILD-CONTRACT.md` asks this to print "a structured log line with
 * `issue_id`/`issue_identifier`/`session_id` + a status line". It does, but it also
 * *checks* what it prints: a smoke that only prints cannot fail, and a check that
 * cannot fail is not evidence. Every section shows real output and then asserts the
 * property that output is supposed to demonstrate; the process exits non-zero if
 * any assertion fails.
 *
 * Run: `npm run smoke:observability`
 */

import type { OrchestratorState, RunningEntry } from "../src/domain/index.js";
import {
  createLogger,
  createSecretRegistry,
  createStatusSurface,
  formatStatusLine,
  jsonLinesSink,
  terminalSink,
  type LogRecord,
  type LogSink,
  type WritableLike,
} from "../src/observability/index.js";

/* -- tiny harness ---------------------------------------------------------- */

const failures: string[] = [];

function check(label: string, condition: boolean): void {
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failures.push(label);
}

function section(title: string): void {
  console.log(`\n━━ ${title} ${"━".repeat(Math.max(0, 68 - title.length))}`);
}

/** Collects what a sink wrote, so the smoke can inspect its own output. */
function buffer(): WritableLike & { text(): string; lines(): string[] } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0),
  };
}

function entry(overrides: Partial<RunningEntry> & { issue_identifier: string }): RunningEntry {
  return {
    issue_id: `id-${overrides.issue_identifier}`,
    dispatch_state: "In Progress",
    workspace_path: `/tmp/symphony_workspaces/${overrides.issue_identifier}`,
    started_at: new Date(Date.now() - 192_000).toISOString(),
    attempt: null,
    ...overrides,
  };
}

function state(entries: RunningEntry[], overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  const running: Record<string, RunningEntry> = {};
  for (const item of entries) running[item.issue_id] = item;
  return {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 10,
    running,
    claimed: new Set(entries.map((item) => item.issue_id)),
    completed: new Set<string>(),
    ...overrides,
  };
}

console.log("Symphony observability smoke — ARK-60 / SYM-003 (spec §13)");

/* -- 1. structured record with the REQUIRED context fields (§13.1, FR18) --- */

section("1. structured log line — JSON Lines (machine-parseable)");

const jsonOut = buffer();
const logger = createLogger({
  sinks: [jsonLinesSink(jsonOut)],
  level: "debug",
  context: { service: "symphony" },
});

logger
  .child({ issue_id: "8058cfc4-7aec", issue_identifier: "ARK-60" })
  .child({ session_id: "thread-1-turn-1" })
  .info("agent session completed", { outcome: "completed", attempt: null, turns: 7 });

console.log(jsonOut.text().trimEnd());

const [firstLine] = jsonOut.lines();
let parsed: Record<string, unknown> = {};
try {
  parsed = JSON.parse(firstLine ?? "") as Record<string, unknown>;
  check("the line parses as JSON", true);
} catch {
  check("the line parses as JSON", false);
}

check("issue_id present (§13.1 REQUIRED)", parsed.issue_id === "8058cfc4-7aec");
check("issue_identifier present (§13.1 REQUIRED)", parsed.issue_identifier === "ARK-60");
check("session_id present (§13.1 REQUIRED)", parsed.session_id === "thread-1-turn-1");
check("context inherited through child loggers", parsed.service === "symphony");
check("outcome carried (§13.1 action outcome)", parsed.outcome === "completed");
check("ISO-8601 timestamp", typeof parsed.ts === "string" && !Number.isNaN(Date.parse(String(parsed.ts))));

/* -- 2. the same event, human-readable (§13.1 key=value) ------------------- */

section("2. same event — human-readable terminal line");

const termOut = buffer();
createLogger({
  sinks: [terminalSink(termOut, { color: false })],
  context: { issue_id: "8058cfc4-7aec", issue_identifier: "ARK-60" },
})
  .child({ session_id: "thread-1-turn-1" })
  .warn("run retrying", { reason: "connection reset by peer", attempt: 2 });

console.log(termOut.text().trimEnd());

const termLine = termOut.lines()[0] ?? "";
check("uses key=value phrasing (§13.1)", /issue_identifier=ARK-60/.test(termLine));
check("required fields on the human line", /session_id=thread-1-turn-1/.test(termLine));
check("multi-word values stay one token", /reason="connection reset by peer"/.test(termLine));

/* -- 3. no secret values in output (§15.3, FR21) --------------------------- */

section("3. secret redaction — both mechanisms");

const FAKE_SECRET = "ntn_FAKE_SECRET_abcdef123456";
const secrets = createSecretRegistry();
const secretOut = buffer();
const secretLogger = createLogger({
  sinks: [jsonLinesSink(secretOut)],
  secrets,
});

// Registered after the logger is built, exactly as ARK-59's `$VAR` resolution will.
secrets.register(FAKE_SECRET);

secretLogger.error("tracker rejected credentials", {
  issue_identifier: "ARK-60",
  auth: FAKE_SECRET, // caught by the key name
  hint: `retry with ${FAKE_SECRET}`, // caught only by the value registry
  request: { headers: { Authorization: `Bearer ${FAKE_SECRET}` } }, // nested
});

console.log(secretOut.text().trimEnd());

check("the secret literal appears nowhere in the output", !secretOut.text().includes(FAKE_SECRET));
check("redaction marker present", secretOut.text().includes("[REDACTED]"));
check("non-secret context survives", secretOut.text().includes('"issue_identifier":"ARK-60"'));

/* -- 4. status line reflecting active runs (§13.4, FR19) ------------------- */

section("4. status line — N active runs");

const three = [
  entry({ issue_identifier: "ARK-61" }),
  entry({ issue_identifier: "ARK-62", attempt: 2 }),
  entry({ issue_identifier: "ARK-63", dispatch_state: "Todo" }),
];
const many = Array.from({ length: 8 }, (_, index) =>
  entry({ issue_identifier: `ARK-${70 + index}` }),
);

const idleLine = formatStatusLine(state([]));
const oneLine = formatStatusLine(state([entry({ issue_identifier: "ARK-60" })]));
const threeLine = formatStatusLine(state(three, { completed: new Set(["id-ARK-58", "id-ARK-59"]) }));
const manyLine = formatStatusLine(state(many));

console.log(`  N=0  ${idleLine}`);
console.log(`  N=1  ${oneLine}`);
console.log(`  N=3  ${threeLine}`);
console.log(`  N=8  ${manyLine}`);

check("N=0 renders an idle line with the poll interval", /idle/.test(idleLine) && /poll 30s/.test(idleLine));
check("N=1 names the run, its state, and its age", /1\/10 running/.test(oneLine) && /ARK-60 In Progress 3m12s/.test(oneLine));
check("N=3 lists every active run", ["ARK-61", "ARK-62", "ARK-63"].every((id) => threeLine.includes(id)));
check("N=3 shows the retry attempt", /try2/.test(threeLine));
check("N=3 shows the completed count", /2 done/.test(threeLine));
check("N=8 collapses the tail rather than wrapping", /\+\d+ more/.test(manyLine));
check("every line fits one terminal row", [idleLine, oneLine, threeLine, manyLine].every((line) => line.length <= 120));

/* -- 4b. the surface writes through the port ------------------------------- */

const surfaceOut = buffer();
const surface = createStatusSurface({ stream: surfaceOut, inPlace: false });
surface.render(state(three));
surface.render(state([]));
surface.stop();

check("StatusSurface.render wrote one line per call", surfaceOut.lines().length === 2);

/* -- 5. a failing sink does not reach the caller (§13.2) ------------------- */

section("5. sink failure isolation");

const survivorOut = buffer();
const brokenSink: LogSink = (_record: LogRecord) => {
  throw new Error("EPIPE: broken pipe");
};

const resilient = createLogger({
  sinks: [brokenSink, jsonLinesSink(survivorOut)],
  maxSinkFailures: 2,
});

let threw = false;
try {
  resilient.info("dispatch completed", { issue_identifier: "ARK-60" });
  resilient.info("dispatch completed", { issue_identifier: "ARK-61" });
  resilient.info("dispatch completed", { issue_identifier: "ARK-62" });
} catch {
  threw = true;
}

console.log(survivorOut.text().trimEnd());

check("the caller never sees the sink's exception", !threw);
check("records still reach the healthy sink", survivorOut.text().includes("ARK-62"));
check("the failure is reported through a surviving sink (§13.2)", survivorOut.text().includes("log sink failed"));
check("a repeatedly failing sink is disabled, not retried forever", survivorOut.text().includes('"sink_disabled":true'));

/* -- verdict --------------------------------------------------------------- */

section("verdict");

if (failures.length > 0) {
  console.error(`OBSERVABILITY SMOKE FAIL — ${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("OBSERVABILITY SMOKE PASS — structured logging, redaction, status line, sink isolation");
