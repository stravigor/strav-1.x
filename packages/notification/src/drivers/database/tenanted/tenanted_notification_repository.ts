/**
 * `TenantedNotificationRepository` — same surface as the
 * non-tenanted `NotificationRepository`, scoped to the tenanted
 * schema. Callers MUST be inside a `TenantManager.withTenant(...)`
 * scope; the INSERT relies on the session's `app.tenant_id` setting
 * (RLS).
 *
 * The implementation deliberately mirrors the non-tenanted Repository
 * line-for-line — minor duplication keeps both variants narrowly
 * scoped and avoids runtime branching on a tenancy flag (matches the
 * `@strav/social/tenanted` pattern).
 */

import { quoteIdent, Repository } from '@strav/database'
import type { Notifiable } from '../../../notifiable.ts'
import { tenantedNotificationSchema } from './schemas/tenanted_notification_schema.ts'
import { TenantedNotificationRecord } from './tenanted_notification_record.ts'

export interface RecordInput {
  id: string
  notifiable: Notifiable
  type: string
  data: Record<string, unknown>
}

export class TenantedNotificationRepository extends Repository<TenantedNotificationRecord> {
  static override readonly schema = tenantedNotificationSchema
  static override readonly model = TenantedNotificationRecord

  async record(input: RecordInput): Promise<TenantedNotificationRecord> {
    const now = new Date()
    return this.create({
      id: input.id,
      notifiable_id: String(input.notifiable.id),
      notifiable_type: input.notifiable.notifiableType ?? 'Notifiable',
      type: input.type,
      data: input.data,
      read_at: null,
      created_at: now,
      updated_at: now,
    } as Partial<TenantedNotificationRecord>)
  }

  async unread(notifiable: Notifiable): Promise<TenantedNotificationRecord[]> {
    const table = quoteIdent(tenantedNotificationSchema.name)
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${table}
       WHERE "notifiable_id" = $1 AND "read_at" IS NULL
       ORDER BY "created_at" DESC`,
      [String(notifiable.id)],
    )
    return rows.map((r) => this.hydrate(r))
  }

  async markAsRead(id: string): Promise<TenantedNotificationRecord | undefined> {
    const found = await this.findMany([id])
    const model = found[0]
    if (!model) return undefined
    return this.update(model, {
      read_at: new Date(),
    } as Partial<TenantedNotificationRecord>)
  }
}
