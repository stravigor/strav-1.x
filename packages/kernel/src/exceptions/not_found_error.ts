/**
 * `NotFoundError` — 404, `not-found`.
 *
 * Repositories throw this when a `findOrFail`-style lookup misses; HTTP
 * controllers throw it when a route's resource doesn't exist.
 *
 * @see docs/kernel/api.md
 */

import { StravError, type StravErrorOptions } from './strav_error.ts'

export class NotFoundError extends StravError {
  constructor(message = 'Resource not found.', options: StravErrorOptions = {}) {
    super(message, { code: 'not-found', status: 404 }, options)
  }
}
