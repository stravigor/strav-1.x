/**
 * `MailTransportError` — typed error raised by mail `Transport`
 * implementations when a `send()` fails at the transport level
 * (network / HTTP non-2xx / provider rejection).
 *
 * The Worker's `failed(ctx)` hook receives the thrown error as
 * `ctx.error`, so carrying provider + status + retry-hint in the
 * `context` payload makes log records and dead-letter rows actionable
 * without parsing exception strings.
 *
 *   throw new MailTransportError('Resend rejected the request', {
 *     context: {
 *       provider: 'resend',
 *       status: 422,
 *       retryable: false,
 *       providerError: { name: 'validation_error', message: '...' },
 *     },
 *   })
 *
 * `status` on the error itself is fixed at 502 — this is a Strav
 * server-side surface ("an upstream mail provider failed"). The
 * provider's HTTP status lives under `context.status`.
 */

import { StravError, type StravErrorOptions } from '@strav/kernel'

export class MailTransportError extends StravError {
  constructor(message: string, options: StravErrorOptions = {}) {
    super(message, { code: 'mail-transport-error', status: 502 }, options)
  }
}
