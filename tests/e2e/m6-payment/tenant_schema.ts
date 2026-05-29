import { Archetype, defineSchema } from '@strav/database'

/**
 * Tenant registry for the m6-payment e2e. `tenantRegistry: true`
 * marks this as the single registry the framework injects a
 * `tenant_id` FK against on every other tenanted schema
 * (`payment_customer` / `payment_subscription` /
 * `payment_invoice` in this milestone).
 */
export const tenantSchema = defineSchema(
  'tenant',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('name').max(120)
    t.timestamps()
  },
  { tenantRegistry: true },
)
