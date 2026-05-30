/**
 * `paymentSubscriptionSchema` — local mirror of provider
 * subscriptions. Tenanted via RLS.
 *
 * Apps query this table for "active subscriptions for tenant X"
 * without paying a network round-trip to the provider on every
 * dashboard render. Mirror rows are upserted on webhook delivery
 * (when ledger sync is on).
 */

import { Archetype, defineSchema } from '@strav/database'

export const paymentSubscriptionSchema = defineSchema(
  'payment_subscription',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('provider').max(64).notNull()
    t.string('provider_id').max(255).notNull()
    t.string('customer_provider_id').max(255).notNull()
    t.string('price_provider_id').max(255).notNull()
    t.string('status').max(32).notNull()
    t.timestamp('current_period_start').notNull()
    t.timestamp('current_period_end').notNull()
    t.timestamp('cancel_at').nullable()
    t.timestamp('canceled_at').nullable()
    t.timestamp('trial_start').nullable()
    t.timestamp('trial_end').nullable()
    t.json('metadata').notNull().default({})
    t.timestamp('created_at').notNull()
    t.timestamp('updated_at').notNull()
  },
  { tenanted: true },
)
