/**
 * `NotificationRecord` — typed row of the `notification` ledger.
 * Apps subclass when they want a per-notifiable model (e.g. extend
 * with `notifiable_relation` helpers); the framework only needs the
 * generic shape.
 */

import { Model } from '@strav/database'
import { notificationSchema } from './schemas/notification_schema.ts'

export class NotificationRecord extends Model {
  static override readonly schema = notificationSchema

  id!: string
  notifiable_id!: string
  notifiable_type!: string
  type!: string
  data!: Record<string, unknown>
  read_at!: Date | null
  created_at!: Date
  updated_at!: Date
}
