/**
 * `RateLimitError` — 429, `rate-limited`.
 *
 * Carries an optional `retryAfter` (seconds) that an HTTP exception handler
 * surfaces as the `Retry-After` response header.
 *
 * @see docs/kernel/api.md
 */

import { type ErrorJSON, StravError, type StravErrorOptions } from './strav_error.ts'

export interface RateLimitErrorOptions extends StravErrorOptions {
  /** Seconds until the client may retry; surfaced as `Retry-After`. */
  retryAfter?: number
}

export interface RateLimitErrorJSON extends ErrorJSON {
  retryAfter?: number
}

export class RateLimitError extends StravError {
  readonly retryAfter: number | undefined

  constructor(message = 'Too many requests.', options: RateLimitErrorOptions = {}) {
    super(message, { code: 'rate-limited', status: 429 }, options)
    this.retryAfter = options.retryAfter
  }

  override toJSON(): RateLimitErrorJSON {
    const json: RateLimitErrorJSON = super.toJSON()
    if (this.retryAfter !== undefined) json.retryAfter = this.retryAfter
    return json
  }
}
