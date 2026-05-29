/**
 * `paymentWebhookEventSchema` — system-wide dedup ledger for
 * incoming webhooks from every configured provider.
 *
 * On every delivery (after signature verification), the framework
 * does:
 *
 *   INSERT INTO payment_webhook_event (...) ON CONFLICT DO NOTHING
 *
 * The first delivery wins the INSERT and fires user handlers;
 * subsequent deliveries (provider retries, concurrent webhook
 * workers) see the conflict and return 200 without re-firing.
 *
 * Why NOT tenanted: webhooks arrive without tenant context. The
 * endpoint can't know which tenant a payload belongs to until
 * after signature verification + payload inspection — too late
 * for the framework-level dedup INSERT.
 *
 * Why a composite unique key `(provider, provider_event_id)`:
 * different providers may emit colliding event id formats; the
 * pair is the actual uniqueness contract.
 */

import { Archetype, defineSchema } from '@strav/database'

export const paymentWebhookEventSchema = defineSchema(
  'payment_webhook_event',
  Archetype.Event,
  (t) => {
    t.id()
    t.string('provider').max(64).notNull()
    t.string('provider_event_id').max(255).notNull()
    t.string('event_type').max(128).notNull()
    t.timestamp('received_at').notNull()
    t.timestamp('processed_at').nullable()
    // Composite (provider, provider_event_id) unique constraint
    // is added by `applyPaymentLedgerMigration` — the schema
    // builder only exposes per-column `.unique()`.
  },
)
