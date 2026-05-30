/**
 * `paymentInvoiceSchema` — local mirror of provider invoices.
 * Tenanted via RLS.
 *
 * Apps query this for "last 12 invoices for this tenant" without
 * paginating the provider's invoice listing on every render.
 */

import { Archetype, defineSchema } from '@strav/database'

export const paymentInvoiceSchema = defineSchema(
  'payment_invoice',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('provider').max(64).notNull()
    t.string('provider_id').max(255).notNull()
    t.string('customer_provider_id').max(255).notNull()
    t.string('subscription_provider_id').max(255).nullable()
    t.string('status').max(32).notNull()
    // Amounts are in the provider's minor unit (cents/satang).
    // `integer` is int32 — caps each line at ~$21M USD which is
    // well above the per-invoice ceiling for normal apps. Apps
    // that bill nation-state contracts swap this for a decimal
    // column in a follow-up migration.
    t.integer('amount').notNull()
    t.integer('amount_paid').notNull()
    t.integer('amount_due').notNull()
    t.string('currency').max(8).notNull()
    t.string('hosted_url').max(1024).nullable()
    t.string('pdf_url').max(1024).nullable()
    t.timestamp('due_at').nullable()
    t.timestamp('paid_at').nullable()
    t.json('metadata').notNull().default({})
    t.timestamp('created_at').notNull()
    t.timestamp('updated_at').notNull()
  },
  { tenanted: true },
)
