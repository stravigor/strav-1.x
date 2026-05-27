/**
 * `AuthError` — 401, `auth-error`.
 *
 * Use when the request is unauthenticated (no credentials, invalid token,
 * expired session). For "authenticated but not allowed", use
 * `AuthorizationError` (403) instead.
 *
 * @see docs/kernel/api.md
 */

import { StravError, type StravErrorOptions } from './strav_error.ts'

export class AuthError extends StravError {
  constructor(message = 'Authentication required.', options: StravErrorOptions = {}) {
    super(message, { code: 'auth-error', status: 401 }, options)
  }
}
