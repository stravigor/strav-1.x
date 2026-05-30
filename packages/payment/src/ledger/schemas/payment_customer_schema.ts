/**
 * `paymentCustomerSchema` — local mirror of provider customers.
 *
 * Tenanted via RLS — apps that wrap calls in
 * `tenants.withTenant(...)` get per-tenant isolation. The
 * framework upserts into this table from webhook deliveries when
 * `config.payment.ledger.syncOnWebhook` is true; apps read from
 * it instead of round-tripping to the provider for the common
 * "show me this user's billing info" UI.
 *
 * `provider` + `provider_id` together are the natural key; the
 * composite unique constraint is added by
 * `applyPaymentLedgerMigration` (the schema builder only exposes
 * per-column `.unique()`).
 */

import { Archetype, defineSchema } from '@strav/database'

export const paymentCustomerSchema = defineSchema(
  'payment_customer',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('provider').max(64).notNull()
    t.string('provider_id').max(255).notNull()
    t.string('email').max(320).notNull()
    t.string('name').max(255).nullable()
    t.string('phone').max(64).nullable()
    t.json('metadata').notNull().default({})
    t.timestamp('created_at').notNull()
    t.timestamp('updated_at').notNull()
  },
  { tenanted: true },
)
