/**
 * Typed StravError subclasses for durable execution.
 *
 * `DurableError` is the base — generic infrastructure failure. The
 * two more-specific subclasses cover the common "the caller asked
 * for something that doesn't exist" cases.
 */

import { StravError } from '@strav/kernel'

export class DurableError extends StravError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { code: 'durable.error', status: 500 }, options)
  }
}

export class RunNotFoundError extends StravError {
  constructor(runId: string) {
    super(
      `Durable run "${runId}" not found.`,
      { code: 'durable.run-not-found', status: 404 },
      { context: { runId } },
    )
  }
}

export class WorkflowNotRegisteredError extends StravError {
  constructor(name: string, known: readonly string[]) {
    super(
      `Durable workflow "${name}" is not registered. Known: ${known.length === 0 ? '(none)' : known.join(', ')}.`,
      { code: 'durable.workflow-not-registered', status: 500 },
      { context: { name, known: [...known] } },
    )
  }
}
