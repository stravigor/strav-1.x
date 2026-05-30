/**
 * `InstantError` hierarchy — typed wrappers for failures across
 * the instant-messaging stack. Vendor-native errors (LINE API
 * failures, WhatsApp rejections) are preserved on `.cause` so
 * apps can still `instanceof` the underlying type for retry /
 * recovery logic; the wrapping just gives the framework a
 * consistent `StravError` for the standard exception handler.
 *
 * Subclasses:
 *
 *   - `InstantConfigError` — `config.instant` missing required
 *     fields. Thrown at boot from `InstantProvider`.
 *
 *   - `ProviderUnsupportedError` — driver doesn't implement the
 *     requested operation (e.g. `messenger.flex(...)`). Thrown
 *     synchronously so apps fail fast.
 *
 *   - `UnknownProviderError` — `instant.use('x')` for a name not
 *     configured. 400 — usually a config bug.
 *
 *   - `WebhookSignatureError` — signature header missing or
 *     doesn't verify. Webhook route returns 400; LINE retries.
 *
 *   - `InstantProviderError` — generic wrapper around a vendor
 *     exception that doesn't map to a more specific subclass.
 *     Preserves `.cause`; default status 502.
 */

import { StravError } from '@strav/kernel'

export class InstantError extends StravError {
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
      { code: options.code ?? 'instant.error', status: options.status ?? 500 },
      {
        ...(options.context ? { context: options.context } : {}),
        ...(options.cause !== undefined ? { cause: options.cause } : {}),
      },
    )
  }
}

export class InstantConfigError extends InstantError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'instant.config',
      status: 500,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

export class UnknownProviderError extends InstantError {
  constructor(name: string, available: readonly string[]) {
    super(
      `Instant provider "${name}" is not configured. Available: ${available.join(', ') || '<none>'}.`,
      {
        code: 'instant.unknown_provider',
        status: 400,
        context: { requested: name, available },
      },
    )
  }
}

export class ProviderUnsupportedError extends InstantError {
  constructor(provider: string, operation: string, options: { reason?: string } = {}) {
    const trailer = options.reason ? ` ${options.reason}` : ''
    super(`Instant provider "${provider}" does not support "${operation}".${trailer}`, {
      code: 'instant.provider_unsupported',
      status: 400,
      context: { provider, operation, ...(options.reason ? { reason: options.reason } : {}) },
    })
  }
}

export class WebhookSignatureError extends InstantError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'instant.webhook_signature',
      status: 400,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

export class InstantProviderError extends InstantError {
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
      code: 'instant.provider_error',
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
