import { type DatabaseExecutor, emitCreateTable, type SchemaRegistry } from '@strav/database'
import { tenantedNotificationSchema } from './schemas/tenanted_notification_schema.ts'

export interface ApplyTenantedNotificationMigrationOptions {
  registry: SchemaRegistry
}

export async function applyTenantedNotificationMigration(
  db: DatabaseExecutor,
  options: ApplyTenantedNotificationMigrationOptions,
): Promise<void> {
  const { registry } = options
  await db.execute(emitCreateTable(tenantedNotificationSchema, { registry }).sql)
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_notification_notifiable_unread"
     ON "${tenantedNotificationSchema.name}" ("tenant_id", "notifiable_id", "created_at" DESC)
     WHERE "read_at" IS NULL`,
  )
}
