import { Archetype, defineSchema } from '@strav/database'

/**
 * Tenant registry for the m7-social e2e — only needed when
 * exercising the opt-in tenanted variant of social_account.
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
