/**
 * Typed error surface for the foundation layer (§5.5).
 *
 * Using a discriminated `code` keeps the loader/config/preflight errors
 * machine-checkable for the CLI startup surface and per-tick dispatch handling.
 */

export type SymphonyErrorCode =
  | "missing_workflow_file"
  | "invalid_front_matter"
  | "invalid_config"
  | "preflight_failed"
  | "render_failed";

export class SymphonyError extends Error {
  readonly code: SymphonyErrorCode;
  /** Operator-visible detail lines (e.g. each failed preflight check). */
  readonly details: string[];

  constructor(code: SymphonyErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "SymphonyError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, SymphonyError.prototype);
  }
}

export function isSymphonyError(err: unknown): err is SymphonyError {
  return err instanceof SymphonyError;
}
