/**
 * Ledger model classes — typed row shapes the ledger repositories
 * hydrate into. Apps query these for "show me this tenant's
 * billing state" UIs.
 */

import { Model } from '@strav/database'
import { paymentCustomerSchema } from './schemas/payment_customer_schema.ts'
import { paymentInvoiceSchema } from './schemas/payment_invoice_schema.ts'
import { paymentSubscriptionSchema } from './schemas/payment_subscription_schema.ts'

export class PaymentCustomerRow extends Model {
  static override readonly schema = paymentCustomerSchema

  id!: string
  provider!: string
  provider_id!: string
  email!: string
  name!: string | null
  phone!: string | null
  metadata!: Record<string, string>
  created_at!: Date
  updated_at!: Date
}

export class PaymentSubscriptionRow extends Model {
  static override readonly schema = paymentSubscriptionSchema

  id!: string
  provider!: string
  provider_id!: string
  customer_provider_id!: string
  price_provider_id!: string
  status!: string
  current_period_start!: Date
  current_period_end!: Date
  cancel_at!: Date | null
  canceled_at!: Date | null
  trial_start!: Date | null
  trial_end!: Date | null
  metadata!: Record<string, string>
  created_at!: Date
  updated_at!: Date
}

export class PaymentInvoiceRow extends Model {
  static override readonly schema = paymentInvoiceSchema

  id!: string
  provider!: string
  provider_id!: string
  customer_provider_id!: string
  subscription_provider_id!: string | null
  status!: string
  amount!: number
  amount_paid!: number
  amount_due!: number
  currency!: string
  hosted_url!: string | null
  pdf_url!: string | null
  due_at!: Date | null
  paid_at!: Date | null
  metadata!: Record<string, string>
  created_at!: Date
  updated_at!: Date
}
