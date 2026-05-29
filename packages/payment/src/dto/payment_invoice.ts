/**
 * `PaymentInvoice` — normalized invoice record (whether issued
 * by a subscription cycle or manually drafted).
 */

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void'

export interface PaymentInvoice {
  id: string
  provider: string
  customerId: string
  subscriptionId: string | null
  status: InvoiceStatus
  amount: number
  amountPaid: number
  amountDue: number
  currency: string
  /** Provider-hosted invoice URL — null when not hosted (e.g., draft state). */
  hostedUrl: string | null
  pdfUrl: string | null
  dueAt: Date | null
  paidAt: Date | null
  metadata: Record<string, string>
  createdAt: Date
  raw: unknown
}

export interface ListInvoicesOptions {
  customer?: string
  subscription?: string
  status?: InvoiceStatus
  cursor?: string
  limit?: number
}

export interface PaginatedInvoices {
  data: PaymentInvoice[]
  nextCursor: string | null
}
