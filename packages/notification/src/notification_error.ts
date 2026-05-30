/**
 * Typed error hierarchy. Mirrors `@strav/payment`'s `PaymentError`
 * shape: a base `NotificationError` extending `StravError`, plus
 * subclasses with specific codes apps can branch on.
 */

import { StravError } from '@strav/kernel'

export class NotificationError extends StravError {
  constructor(
    message: string,
    options: {
      code?: string
      status?: number
      context?: Record<string, unknown>
      cause?: unknown
    } = {},
  ) {
    super(
      message,
      { code: options.code ?? 'notification.error', status: options.status ?? 500 },
      {
        ...(options.context ? { context: options.context } : {}),
        ...(options.cause !== undefined ? { cause: options.cause } : {}),
      },
    )
  }
}

export class NotificationConfigError extends NotificationError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'notification.config',
      status: 500,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

export class UnknownChannelError extends NotificationError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'notification.unknown_channel',
      status: 400,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

export class NotificationDeliveryError extends NotificationError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'notification.delivery',
      status: 502,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}
