/**
 * smoke:config — evidence that the Configuration layer (SYM-002 / ARK-50) does its
 * real job: load a real `WORKFLOW.md`, split front matter from the prompt body,
 * resolve `$VAR` indirection + path normalization into a typed `ServiceConfig`,
 * run dispatch preflight, and print the result.
 *
 * SECRET SAFETY (spec §15.3): the resolved config is printed ONLY through
 * `redactConfig`, so `tracker.auth` is shown as a presence marker, never its value.
 *
 * Usage: `tsx smoke/config.ts [./WORKFLOW.md]` (defaults to `./WORKFLOW.md`).
 */

import { loadWorkflowFile } from "../src/config/loader.js";
import { resolveConfig } from "../src/config/config.js";
import { redactConfig } from "../src/config/redact.js";
import { preflightConfig } from "../src/config/preflight.js";
import { isWorkflowError } from "../src/config/errors.js";

function main(): void {
  const path = process.argv[2] ?? "./WORKFLOW.md";
  console.log(`[smoke:config] loading workflow: ${path}\n`);

  const workflow = loadWorkflowFile(path);
  console.log(`[smoke:config] front matter parsed: ${Object.keys(workflow.config).length} top-level key(s)`);
  const bodyPreview = workflow.prompt_template.split("\n", 1)[0] ?? "";
  console.log(`[smoke:config] prompt body: ${workflow.prompt_template.length} chars, first line: ${JSON.stringify(bodyPreview)}\n`);

  const config = resolveConfig(workflow);
  const redacted = redactConfig(config);
  console.log("[smoke:config] resolved ServiceConfig (secrets redacted):");
  console.log(JSON.stringify(redacted, null, 2));
  console.log();

  const preflight = preflightConfig(config);
  if (preflight.ok) {
    console.log("[smoke:config] preflight: OK (config is dispatch-ready)");
  } else {
    console.log("[smoke:config] preflight: NOT dispatch-ready (expected without live env secrets):");
    for (const err of preflight.errors) {
      console.log(`  - ${err}`);
    }
  }
  console.log("\n[smoke:config] done — config layer parsed + resolved + preflighted without leaking secrets.");
}

try {
  main();
} catch (error) {
  if (isWorkflowError(error)) {
    console.error(`[smoke:config] FAILED [${error.code}]: ${error.message}`);
  } else {
    console.error(`[smoke:config] FAILED: ${(error as Error).message}`);
  }
  process.exit(1);
}
