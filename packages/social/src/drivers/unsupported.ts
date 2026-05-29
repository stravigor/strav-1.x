/**
 * `unsupported(provider, operation, reason?)` — drivers stub
 * out methods they can't fulfil. Returns a function that
 * throws `ProviderUnsupportedError` synchronously.
 */

import { ProviderUnsupportedError } from '../social_error.ts'

export function unsupported(
  provider: string,
  operation: string,
  reason?: string,
): (...args: unknown[]) => never {
  return () => {
    throw new ProviderUnsupportedError(provider, operation, reason ? { reason } : {})
  }
}
