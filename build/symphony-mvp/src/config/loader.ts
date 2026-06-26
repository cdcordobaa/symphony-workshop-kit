/**
 * Workflow Loader (SYMPHONY-SPEC §5.1, §5.2; FR-WL-1, FR-WL-2).
 *
 * Resolves the WORKFLOW.md path, splits optional YAML front matter from the
 * trimmed prompt body, parses the front matter to a map, and builds the typed
 * `ServiceConfig`.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowDefinition } from "../domain/config.js";
import { SymphonyError } from "../domain/errors.js";
import { buildServiceConfig } from "./typed-config.js";

/**
 * Resolve the effective workflow path (§5.1):
 *  1. explicit CLI/runtime path,
 *  2. otherwise `./WORKFLOW.md` in cwd.
 */
export function resolveWorkflowPath(
  explicit: string | undefined,
  cwd: string = process.cwd(),
): string {
  const target = explicit && explicit.length > 0 ? explicit : "WORKFLOW.md";
  return path.resolve(cwd, target);
}

/**
 * Split raw file content into `{ frontMatterText, body }`.
 *
 * If the file begins with a `---` line, content up to the next `---` line is
 * the front matter; the remainder is the body. Otherwise there is no front
 * matter and the entire file is the body. (§5.2)
 */
export function splitFrontMatter(raw: string): {
  frontMatterText: string | null;
  body: string;
} {
  // Normalize newlines so the delimiter scan is platform-independent.
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontMatterText: null, body: normalized };
  }

  // Find the closing delimiter.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      close = i;
      break;
    }
  }

  if (close === -1) {
    // Opening `---` with no closing delimiter: treat as malformed front matter.
    throw new SymphonyError(
      "invalid_front_matter",
      "Front matter opening '---' has no closing '---' delimiter.",
    );
  }

  const frontMatterText = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  return { frontMatterText, body };
}

/** Parse front-matter YAML text to a map, enforcing the map/object rule. */
export function parseFrontMatter(text: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = parseYaml(text);
  } catch (err) {
    throw new SymphonyError(
      "invalid_front_matter",
      `Failed to parse YAML front matter: ${(err as Error).message}`,
    );
  }

  // Empty front matter (only comments/whitespace) decodes to null ⇒ empty map.
  if (decoded === null || decoded === undefined) {
    return {};
  }
  if (typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new SymphonyError(
      "invalid_front_matter",
      "YAML front matter MUST decode to a map/object.",
    );
  }
  return decoded as Record<string, unknown>;
}

/**
 * Load and parse a WORKFLOW.md file into a typed `WorkflowDefinition`.
 *
 * @throws SymphonyError `missing_workflow_file` if the file cannot be read,
 *         `invalid_front_matter` for non-map / malformed front matter,
 *         `invalid_config` for typed-config coercion failures.
 */
export function loadWorkflow(
  workflowPath: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkflowDefinition {
  const absolute = path.resolve(workflowPath);

  let raw: string;
  try {
    raw = fs.readFileSync(absolute, "utf8");
  } catch {
    throw new SymphonyError(
      "missing_workflow_file",
      `Cannot read workflow file: ${absolute}`,
    );
  }

  const { frontMatterText, body } = splitFrontMatter(raw);
  const config =
    frontMatterText === null ? {} : parseFrontMatter(frontMatterText);

  const baseDir = path.dirname(absolute);
  const service = buildServiceConfig(config, baseDir, env);

  return {
    config,
    prompt_template: body.trim(),
    service,
    source_path: absolute,
  };
}
