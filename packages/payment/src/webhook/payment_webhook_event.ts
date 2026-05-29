/**
 * `PaymentWebhookEvent` — typed row of the dedup ledger.
 *
 * Apps rarely touch this directly. Operator dashboards use it to
 * list recent events, surface processing latencies, or flag
 * stuck deliveries (rows where `processed_at` is still NULL after
 * dispatch should have completed).
 */

import { Model } from '@strav/database'
import { paymentWebhookEventSchema } from './payment_webhook_event_schema.ts'

export class PaymentWebhookEvent extends Model {
  static override readonly schema = paymentWebhookEventSchema

  id!: string
  provider!: string
  provider_event_id!: string
  event_type!: string
  received_at!: Date
  processed_at!: Date | null
}
