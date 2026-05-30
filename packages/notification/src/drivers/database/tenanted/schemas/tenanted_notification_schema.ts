/**
 * `tenantedNotificationSchema` — opt-in tenant-scoped variant of the
 * notification ledger. Same columns as the default schema, with
 * `tenanted: true` so `@strav/database` injects the `tenant_id` FK
 * + RLS policy.
 *
 * Apps register this schema instead of the default. The matching
 * `Model` + `Repository` + `applyTenantedNotificationMigration` ship
 * here too so the wiring stays consistent.
 */

import { Archetype, defineSchema } from '@strav/database'

export const tenantedNotificationSchema = defineSchema(
  'notification',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('notifiable_id').max(64).notNull()
    t.string('notifiable_type').max(128).notNull()
    t.string('type').max(128).notNull()
    t.json('data').notNull().default({})
    t.timestamp('read_at').nullable()
    t.timestamp('created_at').notNull()
    t.timestamp('updated_at').notNull()
  },
  { tenanted: true },
)
