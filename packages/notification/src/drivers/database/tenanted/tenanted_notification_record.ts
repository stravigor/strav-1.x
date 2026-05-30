import { Model } from '@strav/database'
import { tenantedNotificationSchema } from './schemas/tenanted_notification_schema.ts'

export class TenantedNotificationRecord extends Model {
  static override readonly schema = tenantedNotificationSchema

  id!: string
  notifiable_id!: string
  notifiable_type!: string
  type!: string
  data!: Record<string, unknown>
  read_at!: Date | null
  created_at!: Date
  updated_at!: Date
}
