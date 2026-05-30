/**
 * `NotificationRepository` — domain helpers on top of the generic
 * `Repository<NotificationRecord>` surface. The methods apps actually
 * reach for:
 *
 *   - `record({ id, notifiable, type, data })` — insert a fresh row.
 *     Called by `DatabaseNotificationDriver.send()`; apps usually
 *     don't invoke this directly.
 *
 *   - `unread(notifiable)` — every unread row for one recipient,
 *     newest first. Apps render a badge from `unread(...).length`.
 *
 *   - `markAsRead(id)` — flip `read_at` from null to now. Returns
 *     the updated row.
 */

import { quoteIdent, Repository } from '@strav/database'
import type { Notifiable } from '../../notifiable.ts'
import { NotificationRecord } from './notification_record.ts'
import { notificationSchema } from './schemas/notification_schema.ts'

export interface RecordInput {
  /** Notification ULID (matches `NotificationContext.id`). */
  id: string
  notifiable: Notifiable
  /** Notification class name (`notification.constructor.name`). */
  type: string
  /** jsonb payload from `notification.toDatabase(notifiable)`. */
  data: Record<string, unknown>
}

export class NotificationRepository extends Repository<NotificationRecord> {
  static override readonly schema = notificationSchema
  static override readonly model = NotificationRecord

  async record(input: RecordInput): Promise<NotificationRecord> {
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
    } as Partial<NotificationRecord>)
  }

  async unread(notifiable: Notifiable): Promise<NotificationRecord[]> {
    const table = quoteIdent(notificationSchema.name)
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${table}
       WHERE "notifiable_id" = $1 AND "read_at" IS NULL
       ORDER BY "created_at" DESC`,
      [String(notifiable.id)],
    )
    return rows.map((r) => this.hydrate(r))
  }

  async markAsRead(id: string): Promise<NotificationRecord | undefined> {
    const found = await this.findMany([id])
    const model = found[0]
    if (!model) return undefined
    return this.update(model, { read_at: new Date() } as Partial<NotificationRecord>)
  }
}
