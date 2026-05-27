/**
 * Coerce any throwable into a `StravError`. If `err` is already one, it's
 * returned unchanged. Otherwise it's wrapped in a `ServerError` with the
 * original preserved as `cause` so the stack chain stays intact.
 *
 * @see docs/kernel/api.md
 */

import { ServerError } from './server_error.ts'
import { StravError } from './strav_error.ts'

export function asStravError(err: unknown, fallbackMessage = 'Internal server error.'): StravError {
  if (err instanceof StravError) return err
  if (err instanceof Error) {
    return new ServerError(err.message || fallbackMessage, { cause: err })
  }
  return new ServerError(fallbackMessage, { cause: err })
}
