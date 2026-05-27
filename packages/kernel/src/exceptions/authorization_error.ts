/**
 * `AuthorizationError` — 403, `authorization-error`.
 *
 * Use when the caller is authenticated but lacks permission for the operation.
 * For "no credentials at all", use `AuthError` (401) instead.
 *
 * @see docs/kernel/api.md
 */

import { StravError, type StravErrorOptions } from './strav_error.ts'

export class AuthorizationError extends StravError {
  constructor(
    message = 'You are not authorized to perform this action.',
    options: StravErrorOptions = {},
  ) {
    super(message, { code: 'authorization-error', status: 403 }, options)
  }
}
