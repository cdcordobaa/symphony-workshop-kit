/**
 * Typed error surface for workflow loading, config resolution, and prompt
 * rendering (Symphony spec §5.5).
 *
 * Dispatch-gating note (§5.5): `missing_workflow_file` / `workflow_parse_error`
 * / `workflow_front_matter_not_a_map` / `config_validation_error` block new
 * dispatches until fixed, whereas `template_parse_error` / `template_render_error`
 * fail only the affected run attempt.
 */
export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "config_validation_error"
  | "template_parse_error"
  | "template_render_error";

/** A typed error carrying one of the {@link WorkflowErrorCode} classes. */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "WorkflowError";
    this.code = code;
    // Keep prototype chain correct when targeting ES2022 with downleveled classes.
    Object.setPrototypeOf(this, WorkflowError.prototype);
  }
}

/** Type guard for {@link WorkflowError}. */
export function isWorkflowError(value: unknown): value is WorkflowError {
  return value instanceof WorkflowError;
}
