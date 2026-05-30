/**
 * Typed error hierarchy. Same shape as `@strav/notification` — base
 * `BroadcastError` extending `StravError`, narrower subclasses with
 * stable `code`s apps branch on.
 */

import { StravError } from '@strav/kernel'

interface BroadcastErrorOptions {
  code?: string
  status?: number
  context?: Record<string, unknown>
  cause?: unknown
}

export class BroadcastError extends StravError {
  constructor(message: string, options: BroadcastErrorOptions = {}) {
    super(
      message,
      { code: options.code ?? 'broadcast.error', status: options.status ?? 500 },
      {
        ...(options.context ? { context: options.context } : {}),
        ...(options.cause !== undefined ? { cause: options.cause } : {}),
      },
    )
  }
}

export class BroadcastConfigError extends BroadcastError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'broadcast.config',
      status: 500,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

export class BroadcastPublishError extends BroadcastError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'broadcast.publish',
      status: 502,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

export class BroadcastUnauthorizedError extends BroadcastError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'broadcast.unauthorized',
      status: 403,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}
