/**
 * `SocialError` hierarchy — typed wrappers for OAuth/OIDC
 * failures. Provider-native errors are preserved on `.cause`
 * so apps can `instanceof` the vendor exception for retry /
 * recovery logic; the wrapper gives the framework a consistent
 * `StravError` to render through the standard exception handler.
 *
 * Subclasses:
 *
 *   - `SocialConfigError` — boot-time misconfiguration
 *     (missing client id / secret / redirect uri).
 *
 *   - `UnknownProviderError` — `social.use(name)` for a name
 *     not configured.
 *
 *   - `ProviderUnsupportedError` — driver doesn't implement the
 *     requested operation (Facebook driver lacks
 *     `tokens.refresh` for example).
 *
 *   - `StateMismatchError` — `state` returned on the callback
 *     doesn't match what `authorize()` issued. Strong signal
 *     of CSRF or a misrouted callback.
 *
 *   - `OAuthExchangeError` — provider rejected the authorization
 *     code (expired, already used, wrong client).
 *
 *   - `InvalidTokenError` — provider rejected the access /
 *     refresh token (expired, revoked, scope-mismatched).
 *
 *   - `SocialProviderError` — generic wrapper for vendor
 *     exceptions that don't map to a more specific subclass.
 *     `cause` preserved.
 */

import { StravError } from '@strav/kernel'

export class SocialError extends StravError {
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
      { code: options.code ?? 'social.error', status: options.status ?? 500 },
      {
        ...(options.context ? { context: options.context } : {}),
        ...(options.cause !== undefined ? { cause: options.cause } : {}),
      },
    )
  }
}

export class SocialConfigError extends SocialError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'social.config',
      status: 500,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

export class UnknownProviderError extends SocialError {
  constructor(name: string, available: readonly string[]) {
    super(
      `Social provider "${name}" is not configured. Available: ${available.join(', ') || '<none>'}.`,
      {
        code: 'social.unknown_provider',
        status: 400,
        context: { requested: name, available },
      },
    )
  }
}

export class ProviderUnsupportedError extends SocialError {
  constructor(provider: string, operation: string, options: { reason?: string } = {}) {
    const trailer = options.reason ? ` ${options.reason}` : ''
    super(
      `Social provider "${provider}" does not support "${operation}".${trailer}`,
      {
        code: 'social.provider_unsupported',
        status: 400,
        context: {
          provider,
          operation,
          ...(options.reason ? { reason: options.reason } : {}),
        },
      },
    )
  }
}

export class StateMismatchError extends SocialError {
  constructor(message = 'Social OAuth callback state mismatch — possible CSRF or misrouted callback.') {
    super(message, { code: 'social.state_mismatch', status: 400 })
  }
}

export class OAuthExchangeError extends SocialError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'social.oauth_exchange',
      status: 400,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

export class InvalidTokenError extends SocialError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'social.invalid_token',
      status: 401,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

export class SocialProviderError extends SocialError {
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
      code: 'social.provider_error',
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
