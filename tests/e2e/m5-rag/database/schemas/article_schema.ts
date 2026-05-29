import { Archetype, defineSchema } from '@strav/database'

/**
 * Domain-side article table — the source rows whose content the
 * `retrievable()` mixin vectorizes. Tenanted so the e2e can
 * verify RLS isolates each tenant's vectors AND their source
 * rows uniformly.
 */
export const articleSchema = defineSchema(
  'article',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('title').max(255).notNull()
    t.text('body').notNull()
    t.timestamps()
  },
  { tenanted: true },
)
