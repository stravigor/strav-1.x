import { Archetype, defineSchema } from '@strav/database'

/**
 * Tenant registry for the m5-rag e2e. `tenantRegistry: true`
 * marks this as the single registry the framework injects a
 * `tenant_id` FK against on every other tenanted schema.
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
