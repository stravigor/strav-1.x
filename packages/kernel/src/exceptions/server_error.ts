/**
 * `ServerError` — 500, `server-error`.
 *
 * Generic "something we didn't anticipate" error. `asStravError` wraps
 * non-Strav throwables with this class, preserving the original as `cause`.
 *
 * @see docs/kernel/api.md
 */

import { StravError, type StravErrorOptions } from './strav_error.ts'

export class ServerError extends StravError {
  constructor(message = 'Internal server error.', options: StravErrorOptions = {}) {
    super(message, { code: 'server-error', status: 500 }, options)
  }
}
