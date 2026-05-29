/**
 * Stripe-specific provider config. Apps put one of these inside
 * `config.payment.providers[name]` with `driver: 'stripe'`.
 */

import type { ProviderConfig } from '../types.ts'

export interface StripeProviderConfig extends ProviderConfig {
  driver: 'stripe'
  /** `sk_test_...` / `sk_live_...`. Required. */
  secret: string
  /** `whsec_...` from the Stripe Dashboard. Required for webhook routes. */
  webhookSecret?: string
  /** Pin the SDK to a specific API version. Defaults to SDK-bundled. */
  apiVersion?: string
  /** Optional: pass a pre-built `Stripe` instance (tests). */
  client?: unknown
}
