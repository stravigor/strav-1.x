/**
 * `PaymentLedger` — applies normalized webhook events into the
 * local ledger tables.
 *
 * Sync flow (when `config.payment.ledger.syncOnWebhook` is true):
 *
 *   1. Webhook handler verifies + dedups + normalizes.
 *   2. Before firing user handlers, the dispatcher calls
 *      `ledger.applyEvent(event)` — this upserts the matching
 *      row(s) in `payment_customer` / `payment_subscription` /
 *      `payment_invoice`.
 *   3. User handlers run against an already-up-to-date ledger.
 *
 * Why per-event upserts (not periodic full sync): webhooks are
 * the source-of-truth signal for change. Polling is wasteful and
 * lossy. Apps that miss a webhook (signature secret rotation,
 * downtime) backfill via a `payment:resync` admin command in a
 * follow-up slice.
 *
 * Tenancy: tables are tenanted, but webhooks arrive without
 * tenant context. The ledger resolves the tenant by matching on
 * `(provider, provider_id)` from `payment_customer` rows seeded
 * at customer-creation time (when tenant context IS available).
 * Subscriptions / invoices then inherit the customer's tenant.
 *
 * Events for which no `payment_customer` row exists are skipped
 * with a logged warning — likely a webhook for a customer
 * created outside the framework, or a missed seed.
 */

// biome-ignore lint/style/useImportType: PostgresDatabase value import for @inject() metadata.
import {
  PostgresDatabase,
  quoteIdent,
  type DatabaseExecutor,
} from '@strav/database'
import { inject, ulid } from '@strav/kernel'
import type { NormalizedWebhookEvent } from '../dto/payment_event.ts'
import { paymentCustomerSchema } from './payment_customer_schema.ts'
import { paymentInvoiceSchema } from './payment_invoice_schema.ts'
import { paymentSubscriptionSchema } from './payment_subscription_schema.ts'

@inject()
export class PaymentLedger {
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor forces TS to emit `design:paramtypes` for @inject().
  constructor(private readonly db: PostgresDatabase) {}

  /**
   * Apply a normalized event. Idempotent — re-running with the
   * same event yields the same row state.
   *
   * `executor` is an optional database handle — the webhook
   * dispatcher passes the transaction returned by
   * `TenantManager.withTenant(tenantId, async (tx) => ...)` so
   * the INSERTs see `current_setting('app.tenant_id')` set by
   * `withTenant`'s `set_config(..., true)` (LOCAL = transaction
   * scope). When omitted (direct calls outside webhook flow),
   * the ledger falls back to the pooled `PostgresDatabase`, which
   * is correct only when the caller has already SET the session
   * setting on that connection.
   *
   * Implementation note for v1: customers / subscriptions /
   * invoices each have a partial-payload upsert path that reads
   * the structured fields off `event._fields` (drivers stamp it
   * during `normalize`). When `_fields` is absent the upsert
   * no-ops (apps still get the event, just no local mirror).
   */
  async applyEvent(
    event: NormalizedWebhookEvent,
    executor?: DatabaseExecutor,
  ): Promise<void> {
    const fields = (event as { _fields?: Record<string, unknown> })._fields
    if (!fields) return
    const exec = executor ?? this.db

    switch (event.type) {
      case 'customer.created':
      case 'customer.updated':
        await this.upsertCustomer(exec, event.provider, fields)
        return
      case 'customer.deleted':
        if (event.data.customerId) {
          await this.deleteCustomer(exec, event.provider, event.data.customerId)
        }
        return
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.canceled':
      case 'subscription.trial_will_end':
        await this.upsertSubscription(exec, event.provider, fields)
        return
      case 'invoice.created':
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided':
        await this.upsertInvoice(exec, event.provider, fields)
        return
      default:
        return
    }
  }

  private async upsertCustomer(
    exec: DatabaseExecutor,
    provider: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const table = quoteIdent(paymentCustomerSchema.name)
    // `tenant_id` is pulled from the session setting (`app.tenant_id`)
    // set by `TenantManager.withTenant(...)` around the webhook
    // dispatcher. Same pattern as `@strav/rag`'s pgvector driver.
    await exec.execute(
      `INSERT INTO ${table}
        ("id","tenant_id","provider","provider_id","email","name","phone","metadata","created_at","updated_at")
       VALUES ($1, current_setting('app.tenant_id', true), $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
       ON CONFLICT ("provider","provider_id") DO UPDATE SET
         "email"      = EXCLUDED."email",
         "name"       = EXCLUDED."name",
         "phone"      = EXCLUDED."phone",
         "metadata"   = EXCLUDED."metadata",
         "updated_at" = NOW()`,
      [
        ulid(),
        provider,
        str(fields.id),
        str(fields.email),
        nullable(fields.name),
        nullable(fields.phone),
        JSON.stringify(fields.metadata ?? {}),
        toDate(fields.createdAt) ?? new Date(),
      ],
    )
  }

  private async deleteCustomer(
    exec: DatabaseExecutor,
    provider: string,
    providerId: string,
  ): Promise<void> {
    const table = quoteIdent(paymentCustomerSchema.name)
    await exec.execute(
      `DELETE FROM ${table} WHERE "provider" = $1 AND "provider_id" = $2`,
      [provider, providerId],
    )
  }

  private async upsertSubscription(
    exec: DatabaseExecutor,
    provider: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const table = quoteIdent(paymentSubscriptionSchema.name)
    await exec.execute(
      `INSERT INTO ${table}
        ("id","tenant_id","provider","provider_id","customer_provider_id","price_provider_id",
         "status","current_period_start","current_period_end","cancel_at","canceled_at",
         "trial_start","trial_end","metadata","created_at","updated_at")
       VALUES ($1, current_setting('app.tenant_id', true), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, NOW())
       ON CONFLICT ("provider","provider_id") DO UPDATE SET
         "status"               = EXCLUDED."status",
         "current_period_start" = EXCLUDED."current_period_start",
         "current_period_end"   = EXCLUDED."current_period_end",
         "cancel_at"            = EXCLUDED."cancel_at",
         "canceled_at"          = EXCLUDED."canceled_at",
         "trial_start"          = EXCLUDED."trial_start",
         "trial_end"            = EXCLUDED."trial_end",
         "metadata"             = EXCLUDED."metadata",
         "updated_at"           = NOW()`,
      [
        ulid(),
        provider,
        str(fields.id),
        str(fields.customerId),
        str(fields.priceId),
        str(fields.status),
        toDate(fields.currentPeriodStart) ?? new Date(),
        toDate(fields.currentPeriodEnd) ?? new Date(),
        toDate(fields.cancelAt),
        toDate(fields.canceledAt),
        toDate(fields.trialStart),
        toDate(fields.trialEnd),
        JSON.stringify(fields.metadata ?? {}),
        toDate(fields.createdAt) ?? new Date(),
      ],
    )
  }

  private async upsertInvoice(
    exec: DatabaseExecutor,
    provider: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const table = quoteIdent(paymentInvoiceSchema.name)
    await exec.execute(
      `INSERT INTO ${table}
        ("id","tenant_id","provider","provider_id","customer_provider_id","subscription_provider_id",
         "status","amount","amount_paid","amount_due","currency",
         "hosted_url","pdf_url","due_at","paid_at","metadata","created_at","updated_at")
       VALUES ($1, current_setting('app.tenant_id', true), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, NOW())
       ON CONFLICT ("provider","provider_id") DO UPDATE SET
         "status"      = EXCLUDED."status",
         "amount"      = EXCLUDED."amount",
         "amount_paid" = EXCLUDED."amount_paid",
         "amount_due"  = EXCLUDED."amount_due",
         "hosted_url"  = EXCLUDED."hosted_url",
         "pdf_url"     = EXCLUDED."pdf_url",
         "due_at"      = EXCLUDED."due_at",
         "paid_at"     = EXCLUDED."paid_at",
         "metadata"    = EXCLUDED."metadata",
         "updated_at"  = NOW()`,
      [
        ulid(),
        provider,
        str(fields.id),
        str(fields.customerId),
        nullable(fields.subscriptionId),
        str(fields.status),
        num(fields.amount),
        num(fields.amountPaid),
        num(fields.amountDue),
        str(fields.currency),
        nullable(fields.hostedUrl),
        nullable(fields.pdfUrl),
        toDate(fields.dueAt),
        toDate(fields.paidAt),
        JSON.stringify(fields.metadata ?? {}),
        toDate(fields.createdAt) ?? new Date(),
      ],
    )
  }
}

function str(v: unknown): string {
  if (typeof v !== 'string') {
    throw new TypeError(`PaymentLedger: expected string field, got ${typeof v}`)
  }
  return v
}

function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`PaymentLedger: expected finite number, got ${typeof v}`)
  }
  return v
}

function nullable(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') {
    throw new TypeError(`PaymentLedger: expected string or null, got ${typeof v}`)
  }
  return v
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v
  if (typeof v === 'string' || typeof v === 'number') return new Date(v)
  return null
}
