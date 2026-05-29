/**
 * `PaymentPrice` — normalized price (recurring or one-shot) record.
 * Money is represented in the provider's minor unit (cents,
 * satang, …) to avoid floating-point drift. Currencies use the
 * ISO 4217 three-letter code, lowercase to match Stripe.
 */

export interface PaymentPrice {
  id: string
  provider: string
  productId: string
  /** Amount in the provider's minor unit (e.g. cents). */
  amount: number
  currency: string
  /** `'one_time'` for single charges; recurring carries `interval`. */
  type: 'one_time' | 'recurring'
  interval?: 'day' | 'week' | 'month' | 'year'
  /** Number of `interval` units per billing period (default 1). */
  intervalCount?: number
  active: boolean
  metadata: Record<string, string>
  createdAt: Date
  raw: unknown
}

export interface CreatePriceInput {
  product: string
  amount: number
  currency: string
  type?: 'one_time' | 'recurring'
  interval?: 'day' | 'week' | 'month' | 'year'
  intervalCount?: number
  active?: boolean
  metadata?: Record<string, string>
}

export interface ListPricesOptions {
  product?: string
  cursor?: string
  limit?: number
  active?: boolean
}

export interface PaginatedPrices {
  data: PaymentPrice[]
  nextCursor: string | null
}
