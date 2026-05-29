/**
 * Thrown when a workflow step raises. Carries the failing step name in
 * `context.step` and the original throw via `Error.cause` so handlers
 * downstream (HTTP exception layer, logger redaction) can render a
 * useful message without losing the underlying stack.
 *
 * `Workflow.run()` wraps any throw from a step handler / parallel entry
 * / route branch / loop body in this type; compensation failures get
 * the separate `CompensationError` (see `compensation_error.ts`).
 */

import { StravError } from '@strav/kernel'

export class WorkflowError extends StravError {
  constructor(step: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(
      `Workflow step "${step}" failed: ${message}`,
      { code: 'workflow.step-failed', status: 500 },
      { context: { step }, cause },
    )
  }
}
