/**
 * `PaymentCustomer` — normalized view of a customer record
 * across providers. Provider-specific shape lives in `.raw`.
 */

export interface PaymentCustomer {
  /** Provider-native id (`cus_xxx` for Stripe, `ctm_xxx` for Stripe, etc.). */
  id: string
  /** Driver name — `'stripe'`, `'paddle'`, `'omise'`, … */
  provider: string
  email: string
  name?: string
  phone?: string
  metadata: Record<string, string>
  createdAt: Date
  /** Native provider object. Use only when you need a field the normalized DTO doesn't expose. */
  raw: unknown
}

export interface CreateCustomerInput {
  email: string
  name?: string
  phone?: string
  metadata?: Record<string, string>
  /**
   * Provider-side idempotency key. Drivers with the `idempotency`
   * capability dedup retried calls with the same key for ~24h
   * (Stripe). Drivers without the capability silently ignore.
   */
  idempotencyKey?: string
}

export interface UpdateCustomerInput {
  email?: string
  name?: string
  phone?: string
  metadata?: Record<string, string>
}

export interface ListCustomersOptions {
  /** Driver-defined cursor — passed through verbatim to the next page call. */
  cursor?: string
  limit?: number
  /** Email filter — exact match. Drivers that don't support filtering ignore this and apps filter client-side. */
  email?: string
}

export interface PaginatedCustomers {
  data: PaymentCustomer[]
  /** Opaque cursor for the next page. `null` when the listing is exhausted. */
  nextCursor: string | null
}
