/**
 * `PaymentLink` — normalized shareable payment URL.
 *
 * A payment link is a one-shot hosted page the customer opens to
 * pay. Distinct from `PaymentCheckoutSession` because links are
 * meant to be shared (email, SMS, QR code on a poster) and reused
 * across customers; checkout sessions are tied to a single
 * customer journey.
 *
 * Provider divergence the framework intentionally surfaces:
 *
 *   - **Stripe** requires a catalogue Price id (`items` input);
 *     ad-hoc amounts aren't supported. Apps create a Price first
 *     via `payment.prices.create({...})` then pass `items`.
 *   - **Omise** has no Prices catalogue. Apps pass `amount`,
 *     `currency`, `title`, `description` directly.
 *
 * Both inputs are optional on `CreatePaymentLinkInput`; drivers
 * validate which shape they need and throw a clear
 * `PaymentConfigError` when the wrong one is passed.
 *
 * Lifecycle:
 *
 *   - `active === true` — link accepts new payments.
 *   - `active === false` — link is deactivated; existing
 *     in-flight payments still settle.
 *   - `reusable === false` — single-use; the link becomes
 *     `used` after the first successful payment (Omise's default).
 *   - `reusable === true` — repeatable; Stripe's default.
 */

export interface PaymentLink {
  id: string
  provider: string
  /** Hosted-checkout URL the customer opens to pay. */
  url: string
  /** Ad-hoc amount in minor units. `null` when Stripe link references a Price. */
  amount: number | null
  /** ISO 4217 (lowercase). `null` when Stripe link is multi-price. */
  currency: string | null
  active: boolean
  /** True when the link can take multiple payments. */
  reusable: boolean
  title?: string
  description?: string
  metadata: Record<string, string>
  createdAt: Date
  raw: unknown
}

export interface CreatePaymentLinkInput {
  /** Stripe path: required. Omise: throw ProviderUnsupportedError if passed. */
  items?: ReadonlyArray<{ price: string; quantity?: number }>
  /** Omise path: amount + currency + title + description. Stripe: throw if used without `items`. */
  amount?: number
  currency?: string
  title?: string
  description?: string
  /**
   * Whether the link can take multiple payments. Stripe defaults
   * to `true`; Omise to `false`. Apps that need uniform behaviour
   * pass an explicit value.
   */
  reusable?: boolean
  metadata?: Record<string, string>
  /** Stripe: redirect URL after completion. Ignored by Omise (uses provider-default success page). */
  afterCompletionRedirect?: string
  /** See `CreateChargeInput.idempotencyKey`. */
  idempotencyKey?: string
}

export interface ListPaymentLinksOptions {
  cursor?: string
  limit?: number
  active?: boolean
}

export interface PaginatedPaymentLinks {
  data: PaymentLink[]
  nextCursor: string | null
}
