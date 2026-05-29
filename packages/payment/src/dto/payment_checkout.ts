/**
 * `PaymentCheckoutSession` — normalized hosted-checkout session.
 * Apps redirect the customer to `url`; the provider walks them
 * through payment and posts back a `checkout.completed` webhook
 * when done.
 */

export type CheckoutMode = 'payment' | 'subscription' | 'setup'

export type CheckoutStatus = 'open' | 'complete' | 'expired'

export interface CheckoutLineItem {
  price: string
  quantity?: number
}

export interface PaymentCheckoutSession {
  id: string
  provider: string
  mode: CheckoutMode
  status: CheckoutStatus
  /** Hosted-checkout URL. Apps redirect the user here. */
  url: string
  customerId: string | null
  /** Once `complete`, the resulting subscription / payment id (driver-specific shape). */
  paymentIntentId: string | null
  subscriptionId: string | null
  expiresAt: Date | null
  metadata: Record<string, string>
  createdAt: Date
  raw: unknown
}

export interface CreateCheckoutInput {
  mode: CheckoutMode
  items: readonly CheckoutLineItem[]
  successUrl: string
  cancelUrl: string
  customer?: string
  customerEmail?: string
  /** Trial days when `mode === 'subscription'`. */
  trialDays?: number
  metadata?: Record<string, string>
  /** See `CreateChargeInput.idempotencyKey`. */
  idempotencyKey?: string
}
