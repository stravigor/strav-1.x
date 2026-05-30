/**
 * `PaymentWebhookEventRepository` — data access for the webhook
 * dedup ledger.
 *
 * Two custom helpers on top of the generic CRUD surface:
 *
 *   - `claim(provider, eventId, type)` — atomic INSERT ... ON
 *     CONFLICT DO NOTHING RETURNING id. Returns the row on win,
 *     `null` when another delivery already recorded the
 *     `(provider, provider_event_id)` pair.
 *
 *   - `markProcessed(provider, eventId)` — bumps `processed_at`
 *     to NOW(). Observability-only; not part of the dedup
 *     decision. Rows with `received_at` set but `processed_at`
 *     NULL surface stuck deliveries (handler threw / process
 *     crashed mid-dispatch).
 */

import { quoteIdent, Repository } from '@strav/database'
import { ulid } from '@strav/kernel'
import { PaymentWebhookEvent } from './payment_webhook_event.ts'
import { paymentWebhookEventSchema } from './payment_webhook_event_schema.ts'

export class PaymentWebhookEventRepository extends Repository<PaymentWebhookEvent> {
  static override readonly schema = paymentWebhookEventSchema
  static override readonly model = PaymentWebhookEvent

  /**
   * Atomically record receipt of an event. Returns the inserted
   * row when this call won the race, `null` when the
   * `(provider, provider_event_id)` pair was already recorded.
   */
  async claim(
    provider: string,
    providerEventId: string,
    eventType: string,
  ): Promise<PaymentWebhookEvent | null> {
    const table = quoteIdent(paymentWebhookEventSchema.name)
    const sql = `
      INSERT INTO ${table}
        ("id", "provider", "provider_event_id", "event_type", "received_at")
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT ("provider", "provider_event_id") DO NOTHING
      RETURNING *
    `
    const rows = await this.db.query<Record<string, unknown>>(sql, [
      ulid(),
      provider,
      providerEventId,
      eventType,
    ])
    if (rows.length === 0) return null
    return this.hydrate(rows[0]!)
  }

  /** Bump `processed_at` to NOW(). No-op when the row doesn't exist. */
  async markProcessed(provider: string, providerEventId: string): Promise<void> {
    const table = quoteIdent(paymentWebhookEventSchema.name)
    await this.db.execute(
      `UPDATE ${table} SET "processed_at" = NOW()
       WHERE "provider" = $1 AND "provider_event_id" = $2`,
      [provider, providerEventId],
    )
  }
}
