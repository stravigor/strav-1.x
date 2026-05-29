/**
 * `PaymentError` hierarchy — typed wrappers for failures across
 * the payment stack. Driver-native exceptions (Stripe API errors,
 * Paddle rate limits, Omise card declines) are preserved on
 * `.cause` so apps can still `instanceof` the vendor class for
 * retry / recovery logic; the wrapping just gives the framework a
 * consistent `StravError` to render through the standard
 * exception handler.
 *
 * Concrete subclasses:
 *
 *   - `PaymentConfigError` — `config.payment` missing required
 *     fields. Thrown at boot from `PaymentProvider`.
 *
 *   - `ProviderUnsupportedError` — a driver doesn't implement the
 *     requested operation (e.g., `omise.checkout.create` when
 *     hosted checkout isn't available). Thrown synchronously from
 *     the *Ops call so apps fail fast rather than after a network
 *     round-trip.
 *
 *   - `UnknownProviderError` — `payment.use('x')` for a name not
 *     configured. 400 — apps usually have a config bug.
 *
 *   - `WebhookSignatureError` — provider signature header missing
 *     or doesn't verify. Webhook route returns 400; the provider
 *     retries per its backoff schedule.
 *
 *   - `WebhookIdempotencyError` — malformed / missing event id.
 *     400 — apps that hit this usually have a non-provider payload
 *     reaching the route.
 *
 *   - `PaymentProviderError` — generic wrapper around a vendor
 *     exception that doesn't map to a specific subclass.
 *     Preserves `.cause`; default status 502 (upstream failure).
 */

import { StravError } from '@strav/kernel'

export class PaymentError extends StravError {
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
      { code: options.code ?? 'payment.error', status: options.status ?? 500 },
      {
        ...(options.context ? { context: options.context } : {}),
        ...(options.cause !== undefined ? { cause: options.cause } : {}),
      },
    )
  }
}

export class PaymentConfigError extends PaymentError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'payment.config',
      status: 500,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

export class UnknownProviderError extends PaymentError {
  constructor(name: string, available: readonly string[]) {
    super(
      `Payment provider "${name}" is not configured. Available: ${available.join(', ') || '<none>'}.`,
      {
        code: 'payment.unknown_provider',
        status: 400,
        context: { requested: name, available },
      },
    )
  }
}

/**
 * Thrown when a driver doesn't implement the requested operation.
 * The driver's `capabilities` set declares what it can do; calls
 * to unsupported operations throw this synchronously so apps fail
 * fast rather than after the network round-trip.
 */
export class ProviderUnsupportedError extends PaymentError {
  constructor(provider: string, operation: string, options: { reason?: string } = {}) {
    const trailer = options.reason ? ` ${options.reason}` : ''
    super(
      `Payment provider "${provider}" does not support "${operation}".${trailer}`,
      {
        code: 'payment.provider_unsupported',
        status: 400,
        context: { provider, operation, ...(options.reason ? { reason: options.reason } : {}) },
      },
    )
  }
}

export class WebhookSignatureError extends PaymentError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'payment.webhook_signature',
      status: 400,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

export class WebhookIdempotencyError extends PaymentError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'payment.webhook_idempotency',
      status: 400,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

/**
 * Generic wrapper around a vendor exception. Drivers throw this
 * for failures that don't map to a more specific subclass —
 * declined cards, rate limits, etc. The original vendor error is
 * preserved on `.cause`.
 */
export class PaymentProviderError extends PaymentError {
  constructor(
    message: string,
    options: {
      provider: string
      operation: string
      context?: Record<string, unknown>
      cause?: unknown
      status?: number
    },
  ) {
    super(message, {
      code: 'payment.provider_error',
      status: options.status ?? 502,
      context: {
        provider: options.provider,
        operation: options.operation,
        ...(options.context ?? {}),
      },
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}
