/**
 * `applyNotificationMigration` — emit DDL for the `notification`
 * table plus a `(notifiable_id, read_at)` lookup index used by
 * `NotificationRepository.unread(...)`.
 *
 * Non-tenanted by default (framework policy: multitenancy is opt-in).
 * Apps that need per-tenant scoping use
 * `applyTenantedNotificationMigration` from
 * `@strav/notification/tenanted` instead.
 *
 * ```ts
 * export const migration: Migration = {
 *   name: '20260601000000_create_notification',
 *   async up(db) {
 *     await applyNotificationMigration(db, { registry })
 *   },
 *   async down(db) {
 *     await db.execute(emitDropTable(notificationSchema.name).sql)
 *   },
 * }
 * ```
 */

import { type DatabaseExecutor, emitCreateTable, type SchemaRegistry } from '@strav/database'
import { notificationSchema } from './schemas/notification_schema.ts'

export interface ApplyNotificationMigrationOptions {
  registry: SchemaRegistry
}

export async function applyNotificationMigration(
  db: DatabaseExecutor,
  options: ApplyNotificationMigrationOptions,
): Promise<void> {
  const { registry } = options
  await db.execute(emitCreateTable(notificationSchema, { registry }).sql)
  // Badge / inbox lookup — "all unread for a recipient" is the
  // hottest read path. Partial index keeps it tight.
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_notification_notifiable_unread"
     ON "${notificationSchema.name}" ("notifiable_id", "created_at" DESC)
     WHERE "read_at" IS NULL`,
  )
}
