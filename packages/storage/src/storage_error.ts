/**
 * Typed error hierarchy. Same shape as `@strav/cache` /
 * `@strav/broadcast` — base `StorageError` extending `StravError`,
 * narrower subclasses with stable `code`s apps branch on.
 */

import { StravError } from '@strav/kernel'

interface StorageErrorOptions {
  code?: string
  status?: number
  context?: Record<string, unknown>
  cause?: unknown
}

export class StorageError extends StravError {
  constructor(message: string, options: StorageErrorOptions = {}) {
    super(
      message,
      { code: options.code ?? 'storage.error', status: options.status ?? 500 },
      {
        ...(options.context ? { context: options.context } : {}),
        ...(options.cause !== undefined ? { cause: options.cause } : {}),
      },
    )
  }
}

/** Provider boot — missing config, unreachable backend at construction. */
export class StorageConfigError extends StorageError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'storage.config',
      status: 500,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

/** Driver-side I/O failure (network, disk, signed-URL refused, etc.). */
export class StorageDriverError extends StorageError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'storage.driver',
      status: 502,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

/** `get` / `stat` / `copy` / `move` on a missing key. `delete` returns `false` instead. */
export class StorageNotFoundError extends StorageError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'storage.not_found',
      status: 404,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}

/** Path normalization rejection — `../` traversal, absolute path, illegal chars. */
export class StoragePathError extends StorageError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'storage.path',
      status: 400,
      ...(options.context ? { context: options.context } : {}),
    })
  }
}
