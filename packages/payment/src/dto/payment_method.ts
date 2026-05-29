/**
 * `PaymentMethod` — normalized payment-instrument record. The
 * actual card number / bank account isn't exposed — only the
 * presentational fields apps render in receipts and account
 * pages.
 */

export type PaymentMethodKind =
  | 'card'
  | 'bank_account'
  | 'sepa_debit'
  | 'promptpay'
  | 'truemoney'
  | 'paypal'
  | 'other'

export interface PaymentMethod {
  id: string
  provider: string
  customerId: string | null
  kind: PaymentMethodKind
  /** Card brand / bank name / wallet provider. Always present. */
  brand?: string
  /** Last 4 digits / account suffix. */
  last4?: string
  expMonth?: number
  expYear?: number
  metadata: Record<string, string>
  createdAt: Date
  raw: unknown
}

export interface ListPaymentMethodsOptions {
  /** Filter to one kind. */
  kind?: PaymentMethodKind
  cursor?: string
  limit?: number
}

export interface PaginatedPaymentMethods {
  data: PaymentMethod[]
  nextCursor: string | null
}
