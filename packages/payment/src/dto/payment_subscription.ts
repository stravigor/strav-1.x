/**
 * `PaymentSubscription` — normalized subscription state.
 *
 * `status` is the framework union — drivers translate from their
 * native status (`'incomplete_expired'` etc.) onto this set. Apps
 * that need the precise provider value read `raw`.
 */

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'paused'
  | 'incomplete'

export interface PaymentSubscription {
  id: string
  provider: string
  customerId: string
  priceId: string
  status: SubscriptionStatus
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAt: Date | null
  canceledAt: Date | null
  trialStart: Date | null
  trialEnd: Date | null
  metadata: Record<string, string>
  createdAt: Date
  raw: unknown
}

export interface CreateSubscriptionInput {
  customer: string
  price: string
  /** Days of free trial. Drivers without trial support throw `ProviderUnsupportedError`. */
  trialDays?: number
  metadata?: Record<string, string>
  /** Optional payment-method id to charge for renewals. */
  paymentMethod?: string
  /** See `CreateChargeInput.idempotencyKey`. */
  idempotencyKey?: string
}

export interface UpdateSubscriptionInput {
  price?: string
  metadata?: Record<string, string>
  paymentMethod?: string
}

export interface CancelSubscriptionOptions {
  /**
   * `'now'` — cancel immediately, refund/credit per provider rules.
   * `'period_end'` — let the current period finish, then stop renewals.
   * Default: `'period_end'`.
   */
  at?: 'now' | 'period_end'
}

export interface ListSubscriptionsOptions {
  customer?: string
  status?: SubscriptionStatus
  cursor?: string
  limit?: number
}

export interface PaginatedSubscriptions {
  data: PaymentSubscription[]
  nextCursor: string | null
}
