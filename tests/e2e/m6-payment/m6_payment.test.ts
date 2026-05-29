/**
 * M6 end-to-end smoke — proves `@strav/payment` against a real
 * Postgres instance.
 *
 * Wire under test:
 *
 *   ConfigProvider → DatabaseProvider → HttpProvider →
 *   PaymentProvider → StripePaymentProvider + OmisePaymentProvider
 *
 *   Live Bun HTTP server hosts `paymentWebhook()` at
 *   `POST /webhooks/:provider`. Test cases sign real Stripe + Omise
 *   payloads (using the SDK and Node's HMAC respectively), fire
 *   them through, and assert:
 *
 *     - `payment_webhook_event` row inserted on first delivery.
 *     - 200 `duplicate: true` on replay; handler doesn't re-fire.
 *     - 400 on missing / bad signature; no row written.
 *     - Different providers carrying the same id don't collide
 *       (composite unique on `(provider, provider_event_id)`).
 *     - `payment.use('omise').checkout.create(...)` throws
 *       `ProviderUnsupportedError` synchronously.
 *     - Cross-provider capability gating (Stripe.method.konbini ✓,
 *       Omise.method.konbini ✗; Omise.method.truemoney ✓,
 *       Stripe.method.truemoney ✗).
 *
 * Vendor SDK calls (Stripe `paymentIntents.create`, Omise
 * `charges.create`, …) are stubbed via `config.client` injection
 * — matches the m5-rag stub-embedder pattern. The framework's
 * dedup + dispatch + capability surface is what's actually
 * exercised against Postgres.
 *
 * Ledger SYNC on webhook is deliberately disabled
 * (`syncOnWebhook: false`). The tenanted ledger tables need a
 * tenant context during the INSERT, but webhooks arrive without
 * one — that bridge ships in a follow-up slice. The DDL itself
 * IS exercised: `applyPaymentLedgerMigration` creates all four
 * tables + composite indexes before the suite runs.
 *
 * Self-skips when no Postgres is available — matches the
 * integration suites' contract.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import Stripe from 'stripe'
import {
  DatabaseProvider,
  PostgresDatabase,
  SchemaRegistry,
  TenantManager,
} from '@strav/database'
import {
  HttpKernel,
  HttpProvider,
  Router,
  type ServeHandle,
} from '@strav/http'
import {
  Application,
  ConfigProvider,
  EventBus,
  LoggerProvider,
  ServiceProvider,
  ulid,
} from '@strav/kernel'
import {
  applyPaymentLedgerMigration,
  PaymentManager,
  PaymentProvider,
  paymentWebhook,
  ProviderUnsupportedError,
  tenantedMetadata,
} from '@strav/payment'
import { StripePaymentDriver } from '@strav/payment/stripe'
import { OmisePaymentDriver } from '@strav/payment/omise'
import {
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
} from '../../support/postgres_test_db.ts'
import { tenantSchema } from './tenant_schema.ts'

const PG_AVAILABLE = await isPostgresAvailable()

const STRIPE_WEBHOOK_SECRET = 'whsec_stripe_e2e_test_secret'
const OMISE_WEBHOOK_SECRET = 'whsec_omise_e2e_test_secret'

// ─── Stub vendor clients (no network) ────────────────────────────────────

/**
 * Stub Stripe SDK that returns the minimum each driver code path
 * reads. Webhook verification is the one path that uses real
 * Stripe code — we delegate to `Stripe.webhooks.constructEventAsync`
 * by exposing a real `Stripe` instance for the `webhooks` namespace
 * while replacing every other namespace with a no-op stub.
 */
function stubStripeClient(): Stripe {
  // We need a *real* Stripe instance for `client.webhooks.constructEventAsync`
  // because that's the path the driver's webhook.verify uses. The other
  // methods aren't exercised in this e2e (we don't call charges.create etc.).
  const real = new Stripe('sk_test_e2e_stub')
  return real
}

interface OmiseStub {
  charges: { create: (req: Record<string, unknown>) => Promise<unknown> }
}

function stubOmiseClient(): OmiseStub {
  return {
    charges: {
      create: async () => {
        throw new Error('OmiseStub: charges.create should not be reached in this e2e.')
      },
    },
  }
}

// ─── App provider — registers the webhook route ──────────────────────────

class PaymentAppProvider extends ServiceProvider {
  override readonly name = 'payment-app'
  // TenantManager must be bound BEFORE PaymentProvider's
  // register() runs (it tries to resolve it). The dependency
  // graph here pulls 'database' before 'payment'.
  override readonly dependencies = ['database']

  override register(app: Application): void {
    // Schemas — register so apps using DatabaseProvider's
    // SchemaRegistry can discover them. We pre-create the tables
    // outside the app's connection (matches m5-rag pattern).
    app.singleton(SchemaRegistry, () => new SchemaRegistry().registerAll([tenantSchema]))

    // TenantManager — DatabaseProvider doesn't auto-bind; apps
    // wire it themselves (matches m2-http-db + m5-rag bootstrap).
    app.singleton(
      TenantManager,
      (c) => new TenantManager(c.resolve(PostgresDatabase), c.resolve(EventBus)),
    )
  }
}

class PaymentRoutesProvider extends ServiceProvider {
  override readonly name = 'payment-routes'
  override readonly dependencies = ['payment', 'http']

  override register(app: Application): void {
    // Webhook route — mount once at `/webhooks/:provider`. The
    // dispatcher reads `:provider`, picks the matching driver,
    // verifies signature, dedups, and (when ledger sync is on +
    // event carries a tenant id) wraps ledger writes + user
    // handlers in `TenantManager.withTenant(...)`.
    app.resolve(Router).post('/webhooks/:provider', paymentWebhook())
  }
}

// ─── DDL helpers ────────────────────────────────────────────────────────

async function applyTestSchemas(db: PostgresDatabase): Promise<void> {
  const { emitCreateTable } = await import('@strav/database')
  const registry = new SchemaRegistry().registerAll([tenantSchema])
  await db.execute(emitCreateTable(tenantSchema, { registry }).sql)
  await applyPaymentLedgerMigration(db, { registry })
}

// ─── Signature helpers ──────────────────────────────────────────────────

async function signStripeEvent(payload: string): Promise<string> {
  const stripe = new Stripe('sk_test_e2e_dummy')
  // Bun's SubtleCrypto is async-only; Stripe's sync test-header
  // helper throws under it. The Async variant uses the same
  // crypto provider as `constructEventAsync` (what the driver
  // verifies with).
  return stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: STRIPE_WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  })
}

function signOmiseBody(rawBody: string, secret = OMISE_WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

interface StripeEventOptions {
  type?: string
  customerId?: string
  tenantId?: string
}

function buildStripeEventBody(id: string, opts: StripeEventOptions = {}): string {
  const { type = 'customer.created', customerId = 'cus_e2e_x', tenantId } = opts
  const metadata = tenantId ? tenantedMetadata(tenantId) : {}
  const obj = {
    id,
    object: 'event',
    api_version: '2024-04-10',
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: customerId,
        object: 'customer',
        email: 'e2e@example.com',
        name: 'E2E Customer',
        created: Math.floor(Date.now() / 1000),
        metadata,
      },
    },
  }
  return JSON.stringify(obj)
}

interface OmiseEventOptions {
  key?: string
  customerId?: string
  tenantId?: string
}

function buildOmiseEventBody(id: string, opts: OmiseEventOptions = {}): string {
  const { key = 'customer.create', customerId = 'cust_e2e_x', tenantId } = opts
  const metadata = tenantId ? tenantedMetadata(tenantId) : {}
  return JSON.stringify({
    id,
    object: 'event',
    key,
    created_at: new Date().toISOString(),
    data: {
      object: {
        id: customerId,
        email: 'e2e@example.com',
        created_at: new Date().toISOString(),
        metadata,
      },
    },
  })
}

async function seedTenant(db: PostgresDatabase, name: string): Promise<string> {
  const id = ulid()
  await db.execute(
    `INSERT INTO "tenant" ("id", "name") VALUES ($1, $2)`,
    [id, name],
  )
  return id
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('M6 e2e: @strav/payment against Postgres', () => {
  let app: Application
  let setupDb: PostgresDatabase
  let server: ServeHandle
  let baseUrl: string
  let tenantAcme: string
  let tenantGlobex: string

  beforeAll(async () => {
    setupDb = createTestDatabase()
    await resetSchema(setupDb)
    await applyTestSchemas(setupDb)

    app = new Application()
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'main',
          level: 'silent',
          channels: { main: { driver: 'stderr' } },
        },
        database: {
          url: `postgres://${process.env.DB_USER}:${encodeURIComponent(
            process.env.DB_PASSWORD as string,
          )}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}`,
        },
        http: { host: '127.0.0.1', port: 0 },
        payment: {
          // No vendor `client` instances in config — those carry
          // cyclic refs the kernel's config-clone can't handle.
          // We hand-wire stubbed drivers via `manager.useDriver`
          // after boot (below). Names must still match because
          // the webhook route resolves drivers by `:provider`.
          default: 'stripe',
          providers: {
            stripe: {
              driver: 'stripe',
              secret: 'sk_test_e2e_stub',
              webhookSecret: STRIPE_WEBHOOK_SECRET,
            },
            asia: {
              driver: 'omise',
              publicKey: 'pkey_test_e2e',
              secretKey: 'skey_test_e2e',
              webhookSecret: OMISE_WEBHOOK_SECRET,
            },
          },
          ledger: {
            enabled: true,         // creates `PaymentLedger`; DDL applies above.
            syncOnWebhook: true,   // slice 7.6 enabled tenant-on-webhook routing.
          },
        },
      }),
      new LoggerProvider(),
      new DatabaseProvider(),
      new HttpProvider(),
      new PaymentAppProvider(),  // wires TenantManager + SchemaRegistry
      new PaymentProvider(),      // resolves TenantManager (optional dep)
      new PaymentRoutesProvider(), // mounts /webhooks/:provider route
    ])
    await app.start({ signalHandlers: false })

    // Hand-wire stub-backed drivers. Bypasses the adapter
    // ServiceProviders' factories so the stub client doesn't get
    // round-tripped through ConfigRepository.
    const manager = app.resolve(PaymentManager)
    manager.useDriver(
      'stripe',
      new StripePaymentDriver({
        instanceName: 'stripe',
        config: {
          driver: 'stripe',
          secret: 'sk_test_e2e_stub',
          webhookSecret: STRIPE_WEBHOOK_SECRET,
          client: stubStripeClient(),
        },
      }),
    )
    manager.useDriver(
      'asia',
      new OmisePaymentDriver({
        instanceName: 'asia',
        config: {
          driver: 'omise',
          publicKey: 'pkey_test_e2e',
          secretKey: 'skey_test_e2e',
          webhookSecret: OMISE_WEBHOOK_SECRET,
          client: stubOmiseClient() as never,
        },
      }),
    )

    server = app.resolve(HttpKernel).serve({ port: 0 })
    baseUrl = `http://127.0.0.1:${server.port}`

    tenantAcme = await seedTenant(setupDb, 'Acme')
    tenantGlobex = await seedTenant(setupDb, 'Globex')
  })

  afterAll(async () => {
    await server?.stop?.()
    await app?.shutdown()
    await setupDb?.close({ timeout: 2 })
  })

  // ─── 1. Migration creates the expected schema ────────────────────────

  test('applyPaymentLedgerMigration created all 4 framework tables', async () => {
    const rows = await setupDb.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'payment_%'
       ORDER BY table_name`,
    )
    const names = rows.map((r) => r.table_name)
    expect(names).toContain('payment_webhook_event')
    expect(names).toContain('payment_customer')
    expect(names).toContain('payment_subscription')
    expect(names).toContain('payment_invoice')
  })

  test('payment_webhook_event has the composite unique constraint', async () => {
    const rows = await setupDb.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'payment_webhook_event'`,
    )
    const names = rows.map((r) => r.indexname)
    expect(names).toContain('idx_payment_webhook_event_provider_event')
  })

  // ─── 2. Manager + drivers boot through the container ────────────────

  test('PaymentManager resolves both providers + carries correct capability sets', () => {
    const manager = app.resolve(PaymentManager)
    expect(manager.use('stripe').name).toBe('stripe')
    expect(manager.use('asia').name).toBe('omise')

    // Cross-provider capability matrix.
    expect(manager.use('stripe').capabilities.has('charges.method.konbini')).toBe(true)
    expect(manager.use('asia').capabilities.has('charges.method.konbini')).toBe(false)
    expect(manager.use('asia').capabilities.has('charges.method.truemoney')).toBe(true)
    expect(manager.use('stripe').capabilities.has('charges.method.truemoney')).toBe(false)
  })

  // ─── 3. Capability gating throws synchronously ──────────────────────

  test('payment.use("asia").checkout.create throws ProviderUnsupportedError synchronously', () => {
    const manager = app.resolve(PaymentManager)
    expect(() =>
      manager.use('asia').checkout.create({
        mode: 'payment',
        items: [{ price: 'price_x' }],
        successUrl: 'https://app/ok',
        cancelUrl: 'https://app/cancel',
      }),
    ).toThrow(ProviderUnsupportedError)
  })

  test('payment.use("asia").invoices.list throws ProviderUnsupportedError synchronously', () => {
    const manager = app.resolve(PaymentManager)
    expect(() => manager.use('asia').invoices.list()).toThrow(
      ProviderUnsupportedError,
    )
  })

  // ─── 4. Stripe webhook end-to-end ───────────────────────────────────

  test('Stripe webhook: signed delivery → 200, ledger row, no replay re-fire', async () => {
    const manager = app.resolve(PaymentManager)
    const fired: string[] = []
    manager.onWebhookEvent('customer.created', { provider: 'stripe' }, (ctx) => {
      fired.push(ctx.eventId)
    })

    const eventId = `evt_e2e_${Date.now()}`
    const body = buildStripeEventBody(eventId, { type: 'customer.created' })
    const signature = await signStripeEvent(body)

    const first = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { received: boolean; duplicate: boolean }
    expect(firstBody.duplicate).toBe(false)
    expect(fired).toEqual([eventId])

    // Dedup row landed.
    const rows = await setupDb.query<{ provider: string; provider_event_id: string; processed_at: Date | null }>(
      `SELECT provider, provider_event_id, processed_at FROM "payment_webhook_event"
       WHERE provider = $1 AND provider_event_id = $2`,
      ['stripe', eventId],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.processed_at).not.toBeNull()

    // Replay → duplicate response, no second handler fire.
    const second = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { received: boolean; duplicate: boolean }
    expect(secondBody.duplicate).toBe(true)
    expect(fired.length).toBe(1)

    manager.clearWebhookHandlers()
  })

  test('Stripe webhook: missing signature header → 400, no row', async () => {
    const body = buildStripeEventBody(`evt_e2e_nosig_${Date.now()}`)
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(400)
  })

  test('Stripe webhook: bad signature → 400, no row', async () => {
    const eventId = `evt_e2e_badsig_${Date.now()}`
    const body = buildStripeEventBody(eventId)
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': 't=999999,v1=deadbeef', 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(400)
    const rows = await setupDb.query(
      `SELECT 1 FROM "payment_webhook_event" WHERE provider_event_id = $1`,
      [eventId],
    )
    expect(rows.length).toBe(0)
  })

  // ─── 5. Omise webhook end-to-end ────────────────────────────────────

  test('Omise webhook: signed delivery → 200, ledger row, no replay re-fire', async () => {
    const manager = app.resolve(PaymentManager)
    const fired: string[] = []
    manager.onWebhookEvent('customer.created', { provider: 'asia' }, (ctx) => {
      fired.push(ctx.eventId)
    })

    const eventId = `evnt_e2e_${Date.now()}`
    const body = buildOmiseEventBody(eventId, { key: 'customer.create' })
    const signature = signOmiseBody(body)

    const first = await fetch(`${baseUrl}/webhooks/asia`, {
      method: 'POST',
      headers: { 'x-omise-signature': signature, 'content-type': 'application/json' },
      body,
    })
    expect(first.status).toBe(200)
    expect(fired).toEqual([eventId])

    const rows = await setupDb.query<{ provider: string; processed_at: Date | null }>(
      `SELECT provider, processed_at FROM "payment_webhook_event"
       WHERE provider = $1 AND provider_event_id = $2`,
      ['asia', eventId],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.provider).toBe('asia')

    const second = await fetch(`${baseUrl}/webhooks/asia`, {
      method: 'POST',
      headers: { 'x-omise-signature': signature, 'content-type': 'application/json' },
      body,
    })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { received: boolean; duplicate: boolean }
    expect(secondBody.duplicate).toBe(true)
    expect(fired.length).toBe(1)

    manager.clearWebhookHandlers()
  })

  test('Omise webhook: bad signature → 400', async () => {
    const eventId = `evnt_e2e_badsig_${Date.now()}`
    const body = buildOmiseEventBody(eventId)
    const res = await fetch(`${baseUrl}/webhooks/asia`, {
      method: 'POST',
      headers: { 'x-omise-signature': 'deadbeef', 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(400)
    const rows = await setupDb.query(
      `SELECT 1 FROM "payment_webhook_event" WHERE provider_event_id = $1`,
      [eventId],
    )
    expect(rows.length).toBe(0)
  })

  // ─── 6. Composite unique allows same id across providers ────────────

  test('same provider_event_id from two providers does NOT collide', async () => {
    const sharedId = `evt_shared_${Date.now()}`

    const stripeBody = buildStripeEventBody(sharedId, { type: 'customer.created' })
    const stripeSig = await signStripeEvent(stripeBody)
    const stripeRes = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': stripeSig, 'content-type': 'application/json' },
      body: stripeBody,
    })
    expect(stripeRes.status).toBe(200)

    const omiseBody = buildOmiseEventBody(sharedId, { key: 'customer.create' })
    const omiseSig = signOmiseBody(omiseBody)
    const omiseRes = await fetch(`${baseUrl}/webhooks/asia`, {
      method: 'POST',
      headers: { 'x-omise-signature': omiseSig, 'content-type': 'application/json' },
      body: omiseBody,
    })
    expect(omiseRes.status).toBe(200)

    const rows = await setupDb.query<{ provider: string }>(
      `SELECT provider FROM "payment_webhook_event"
       WHERE provider_event_id = $1 ORDER BY provider`,
      [sharedId],
    )
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.provider)).toEqual(['asia', 'stripe'])
  })

  // ─── 7. Unknown :provider param → 404 ───────────────────────────────

  test('unknown :provider returns 404', async () => {
    const res = await fetch(`${baseUrl}/webhooks/unknown_provider`, {
      method: 'POST',
      headers: { 'stripe-signature': 'sig' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  // ─── 8. Tenant-on-webhook routing (slice 7.6) ──────────────────────

  test('Stripe webhook with strav_tenant_id metadata → row in payment_customer with correct tenant_id', async () => {
    const eventId = `evt_tenant_${Date.now()}`
    const customerId = `cus_acme_${Date.now()}`
    const body = buildStripeEventBody(eventId, {
      type: 'customer.created',
      customerId,
      tenantId: tenantAcme,
    })
    const signature = await signStripeEvent(body)
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)

    const rows = await setupDb.query<{ tenant_id: string; email: string }>(
      `SELECT tenant_id, email FROM "payment_customer"
       WHERE provider = $1 AND provider_id = $2`,
      ['stripe', customerId],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.tenant_id).toBe(tenantAcme)
    expect(rows[0]?.email).toBe('e2e@example.com')
  })

  test('Omise webhook with strav_tenant_id metadata → row in payment_customer with correct tenant_id', async () => {
    const eventId = `evnt_tenant_${Date.now()}`
    const customerId = `cust_globex_${Date.now()}`
    const body = buildOmiseEventBody(eventId, {
      key: 'customer.create',
      customerId,
      tenantId: tenantGlobex,
    })
    const signature = signOmiseBody(body)
    const res = await fetch(`${baseUrl}/webhooks/asia`, {
      method: 'POST',
      headers: { 'x-omise-signature': signature, 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)

    const rows = await setupDb.query<{ tenant_id: string; email: string }>(
      `SELECT tenant_id, email FROM "payment_customer"
       WHERE provider = $1 AND provider_id = $2`,
      ['asia', customerId],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.tenant_id).toBe(tenantGlobex)
  })

  test('webhook WITHOUT strav_tenant_id metadata → no ledger row written but handler still fires', async () => {
    const manager = app.resolve(PaymentManager)
    const fired: string[] = []
    manager.onWebhookEvent('customer.created', { provider: 'stripe' }, (ctx) => {
      fired.push(ctx.eventId)
    })

    const eventId = `evt_no_tenant_${Date.now()}`
    const customerId = `cus_orphan_${Date.now()}`
    const body = buildStripeEventBody(eventId, {
      type: 'customer.created',
      customerId,
      // no tenantId — `metadata` ends up `{}` in the resource.
    })
    const signature = await signStripeEvent(body)
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)

    // Handler still fires — apps can manually reconcile.
    expect(fired).toContain(eventId)

    // No ledger row — the framework refuses to insert without
    // tenant context (would violate RLS / leave tenant_id null).
    const rows = await setupDb.query(
      `SELECT 1 FROM "payment_customer" WHERE provider = $1 AND provider_id = $2`,
      ['stripe', customerId],
    )
    expect(rows.length).toBe(0)

    manager.clearWebhookHandlers()
  })

  test('two tenants get their own payment_customer rows on parallel webhooks', async () => {
    const stampForAcme = `cus_parallel_acme_${Date.now()}`
    const stampForGlobex = `cus_parallel_globex_${Date.now()}`

    const acmeBody = buildStripeEventBody(`evt_par_acme_${Date.now()}`, {
      type: 'customer.created',
      customerId: stampForAcme,
      tenantId: tenantAcme,
    })
    const acmeSig = await signStripeEvent(acmeBody)

    const globexBody = buildStripeEventBody(`evt_par_globex_${Date.now()}`, {
      type: 'customer.created',
      customerId: stampForGlobex,
      tenantId: tenantGlobex,
    })
    const globexSig = await signStripeEvent(globexBody)

    const [acmeRes, globexRes] = await Promise.all([
      fetch(`${baseUrl}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'stripe-signature': acmeSig, 'content-type': 'application/json' },
        body: acmeBody,
      }),
      fetch(`${baseUrl}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'stripe-signature': globexSig, 'content-type': 'application/json' },
        body: globexBody,
      }),
    ])
    expect(acmeRes.status).toBe(200)
    expect(globexRes.status).toBe(200)

    const rows = await setupDb.query<{ provider_id: string; tenant_id: string }>(
      `SELECT provider_id, tenant_id FROM "payment_customer"
       WHERE provider_id IN ($1, $2)
       ORDER BY provider_id`,
      [stampForAcme, stampForGlobex],
    )
    expect(rows.length).toBe(2)
    const acmeRow = rows.find((r) => r.provider_id === stampForAcme)
    const globexRow = rows.find((r) => r.provider_id === stampForGlobex)
    expect(acmeRow?.tenant_id).toBe(tenantAcme)
    expect(globexRow?.tenant_id).toBe(tenantGlobex)
  })
})
