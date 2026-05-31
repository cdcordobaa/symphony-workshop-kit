/**
 * WORKFLOW.md loader (Symphony spec §5.1–§5.2).
 *
 * Splits optional YAML front matter (delimited by `---`) from the trimmed
 * Markdown prompt body. Absent front matter yields an empty config map; non-map
 * front matter is a typed error.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { WorkflowError } from "./errors.js";

/** Parsed `WORKFLOW.md` payload (§4.1.2). */
export interface WorkflowDefinition {
  /** YAML front-matter root object (not nested under a `config` key). Empty when absent. */
  config: Record<string, unknown>;
  /** Trimmed Markdown body after the front matter. */
  prompt_template: string;
  /** Absolute path of the loaded file; used to resolve relative path config values (§6.1). */
  source_path: string;
}

/**
 * Load and parse a `WORKFLOW.md` file by path.
 * @throws {WorkflowError} `missing_workflow_file` when the file cannot be read.
 */
export function loadWorkflowFile(path: string): WorkflowDefinition {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (cause) {
    throw new WorkflowError(
      "missing_workflow_file",
      `Cannot read workflow file: ${absolute}`,
      { cause },
    );
  }
  return parseWorkflow(raw, absolute);
}

/**
 * Parse raw `WORKFLOW.md` text into a {@link WorkflowDefinition}.
 *
 * @param raw         Full file contents.
 * @param sourcePath  Absolute path used for relative-path resolution downstream.
 */
export function parseWorkflow(raw: string, sourcePath: string): WorkflowDefinition {
  const { frontMatter, body } = splitFrontMatter(raw);

  let config: Record<string, unknown> = {};
  if (frontMatter !== null) {
    let parsed: unknown;
    try {
      parsed = parseYaml(frontMatter);
    } catch (cause) {
      throw new WorkflowError(
        "workflow_parse_error",
        "Failed to parse YAML front matter in WORKFLOW.md.",
        { cause },
      );
    }
    // An empty front-matter block decodes to null/undefined; treat it as an empty map.
    if (parsed === null || parsed === undefined) {
      config = {};
    } else if (typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    } else {
      throw new WorkflowError(
        "workflow_front_matter_not_a_map",
        "WORKFLOW.md front matter must decode to a map/object.",
      );
    }
  }

  return {
    config,
    prompt_template: body.trim(),
    source_path: sourcePath,
  };
}

/**
 * Split optional YAML front matter from the body using the line-based fence rules
 * in §5.2: if the file's first line is `---`, everything up to the next `---`
 * line is front matter and the remainder is the body.
 *
 * @returns `frontMatter` is `null` when no front matter is present.
 */
function splitFrontMatter(raw: string): { frontMatter: string | null; body: string } {
  const lines = raw.split("\n");
  if (lines.length === 0 || (lines[0] ?? "").trim() !== "---") {
    return { frontMatter: null, body: raw };
  }

  // Find the closing fence (a line that is exactly `---`) after the opening one.
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      "WORKFLOW.md opens a `---` front-matter block that is never closed.",
    );
  }

  const frontMatter = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n");
  return { frontMatter, body };
}
