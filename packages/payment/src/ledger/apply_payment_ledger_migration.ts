/**
 * `applyPaymentLedgerMigration` — emit DDL for every framework-
 * owned payment table in one call. Apps drop one statement into
 * their migration:
 *
 * ```ts
 * export const migration: Migration = {
 *   name: '20260601000000_create_payment_ledger',
 *   async up(db) {
 *     await applyPaymentLedgerMigration(db, { registry })
 *   },
 *   async down(db) {
 *     await db.execute(emitDropTable(paymentInvoiceSchema.name).sql)
 *     await db.execute(emitDropTable(paymentSubscriptionSchema.name).sql)
 *     await db.execute(emitDropTable(paymentCustomerSchema.name).sql)
 *     await db.execute(emitDropTable(paymentWebhookEventSchema.name).sql)
 *   },
 * }
 * ```
 *
 * The helper attaches composite unique constraints + secondary
 * indexes on top of the framework-emitted table DDL. Composite
 * constraints aren't expressible through the schema builder yet
 * — handled here.
 */

import {
  emitCreateTable,
  type DatabaseExecutor,
  type SchemaRegistry,
} from '@strav/database'
import { paymentCustomerSchema } from './payment_customer_schema.ts'
import { paymentInvoiceSchema } from './payment_invoice_schema.ts'
import { paymentSubscriptionSchema } from './payment_subscription_schema.ts'
import { paymentWebhookEventSchema } from '../webhook/payment_webhook_event_schema.ts'

export interface ApplyPaymentLedgerMigrationOptions {
  /** Required for emitCreateTable to resolve tenant FK refs. */
  registry: SchemaRegistry
  /**
   * Skip ledger tables (customers / subscriptions / invoices).
   * When false (default), the full ledger lands. When true, only
   * the dedup table is created — for apps that opt out of local
   * mirroring via `config.payment.ledger.enabled = false`.
   */
  ledgerEnabled?: boolean
}

export async function applyPaymentLedgerMigration(
  db: DatabaseExecutor,
  options: ApplyPaymentLedgerMigrationOptions,
): Promise<void> {
  const { registry, ledgerEnabled = true } = options

  // Dedup ledger — always created, the webhook route depends on it.
  await db.execute(emitCreateTable(paymentWebhookEventSchema, { registry }).sql)
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_payment_webhook_event_provider_event"
     ON "${paymentWebhookEventSchema.name}" ("provider", "provider_event_id")`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_payment_webhook_event_type"
     ON "${paymentWebhookEventSchema.name}" ("event_type")`,
  )

  if (!ledgerEnabled) return

  await db.execute(emitCreateTable(paymentCustomerSchema, { registry }).sql)
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_payment_customer_provider_id"
     ON "${paymentCustomerSchema.name}" ("provider", "provider_id")`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_payment_customer_email"
     ON "${paymentCustomerSchema.name}" ("email")`,
  )

  await db.execute(emitCreateTable(paymentSubscriptionSchema, { registry }).sql)
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_payment_subscription_provider_id"
     ON "${paymentSubscriptionSchema.name}" ("provider", "provider_id")`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_payment_subscription_customer"
     ON "${paymentSubscriptionSchema.name}" ("provider", "customer_provider_id")`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_payment_subscription_status"
     ON "${paymentSubscriptionSchema.name}" ("status")`,
  )

  await db.execute(emitCreateTable(paymentInvoiceSchema, { registry }).sql)
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_payment_invoice_provider_id"
     ON "${paymentInvoiceSchema.name}" ("provider", "provider_id")`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_payment_invoice_customer"
     ON "${paymentInvoiceSchema.name}" ("provider", "customer_provider_id")`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_payment_invoice_subscription"
     ON "${paymentInvoiceSchema.name}" ("provider", "subscription_provider_id")
     WHERE "subscription_provider_id" IS NOT NULL`,
  )
}
