/**
 * Thrown when one or more compensation handlers raise during the
 * saga-rollback pass. Carries the original step error that triggered
 * the rollback (`context.originalError.message`) plus a per-handler
 * breakdown of which compensators failed (`context.failures`).
 *
 * The user-facing message lists each failed compensator's name and
 * message so an operator can see what's still in an inconsistent state
 * without re-reading the structured payload. Apps that need finer
 * inspection should reach for `error.context.failures`.
 */

import { StravError } from '@strav/kernel'

export interface CompensationFailure {
  step: string
  error: unknown
}

export class CompensationError extends StravError {
  constructor(originalError: unknown, failures: readonly CompensationFailure[]) {
    const originalMessage =
      originalError instanceof Error ? originalError.message : String(originalError)
    const failureSummary = failures
      .map((f) => `${f.step}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
      .join(', ')
    super(
      `Compensation failed for ${failures.length} step(s) [${failureSummary}]. Original error: ${originalMessage}`,
      { code: 'workflow.compensation-failed', status: 500 },
      {
        context: {
          originalError: {
            message: originalMessage,
            name: originalError instanceof Error ? originalError.name : 'Error',
          },
          failures: failures.map((f) => ({
            step: f.step,
            message: f.error instanceof Error ? f.error.message : String(f.error),
          })),
        },
        cause: originalError,
      },
    )
  }
}
