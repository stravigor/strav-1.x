/**
 * Typed error hierarchy. Same shape as `@strav/broadcast` /
 * `@strav/notification` — base `CacheError` extending `StravError`,
 * narrower subclasses with stable `code`s apps can branch on.
 */

import { StravError } from '@strav/kernel'

interface CacheErrorOptions {
  code?: string
  status?: number
  context?: Record<string, unknown>
  cause?: unknown
}

export class CacheError extends StravError {
  constructor(message: string, options: CacheErrorOptions = {}) {
    super(
      message,
      { code: options.code ?? 'cache.error', status: options.status ?? 500 },
      {
        ...(options.context ? { context: options.context } : {}),
        ...(options.cause !== undefined ? { cause: options.cause } : {}),
      },
    )
  }
}

/** Driver constructed with bad config (empty connection url, etc.). */
export class CacheConfigError extends CacheError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'cache.config',
      status: 500,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

/** A driver primitive rejected at I/O time (network, query failed, etc.). */
export class CacheDriverError extends CacheError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'cache.driver',
      status: 502,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

/** `CacheLock.block(timeoutMs, fn)` exhausted its window. */
export class CacheLockTimeoutError extends CacheError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'cache.lock_timeout',
      status: 503,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

/** `cache.put(key, value, ttl)` got a TTL string it couldn't parse. */
export class CacheTtlParseError extends CacheError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'cache.ttl_parse',
      status: 400,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}
