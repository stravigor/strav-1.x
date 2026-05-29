/**
 * `unsupported(provider, operation)` — helper for drivers to
 * stub out *Ops methods they can't fulfil. Returns a function
 * that throws `ProviderUnsupportedError` synchronously when
 * called. Drivers attach the returned function to the relevant
 * `*Ops` key and omit the matching `PaymentCapability` from
 * `capabilities`.
 */

import { ProviderUnsupportedError } from '../payment_error.ts'

export function unsupported(
  provider: string,
  operation: string,
  reason?: string,
): (...args: unknown[]) => never {
  return () => {
    throw new ProviderUnsupportedError(provider, operation, reason ? { reason } : {})
  }
}
