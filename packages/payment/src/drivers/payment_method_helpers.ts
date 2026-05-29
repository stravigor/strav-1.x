/**
 * Helpers for handling `CreateChargeInput.paymentMethod` —
 * `string | PaymentMethodSpec`.
 *
 * `extractCardToken` collapses both back-compat shapes (raw
 * tokenized id string, `{ kind: 'card', token }` spec) onto a
 * single token id. Specs of any other kind are not card flows;
 * the helper signals that with `null`. Drivers then decide
 * whether to route into their async-method pipeline (slices
 * 7.2 / 7.3) or throw `ProviderUnsupportedError`.
 *
 * Drivers that don't yet support async methods can:
 *   const token = extractCardToken(input.paymentMethod)
 *   if (input.paymentMethod && !token) throw new ProviderUnsupportedError(...)
 *   // …pass `token` as before
 */

import type { PaymentMethodSpec } from '../dto/payment_charge.ts'

export function extractCardToken(
  pm: string | PaymentMethodSpec | undefined,
): string | null {
  if (pm === undefined) return null
  if (typeof pm === 'string') return pm
  if (pm.kind === 'card') return pm.token
  return null
}

export function paymentMethodKind(
  pm: string | PaymentMethodSpec | undefined,
): PaymentMethodSpec['kind'] | 'unspecified' {
  if (pm === undefined) return 'unspecified'
  if (typeof pm === 'string') return 'card'
  return pm.kind
}
