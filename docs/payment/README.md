# @strav/payment

Provider-agnostic payment abstraction. One fluent surface (`payment.customers.*`, `payment.subscriptions.*`, …) that routes into Stripe, Omise, or a future adapter. Apps that want to switch PSPs change one config entry, not their codebase.

```ts
import { PaymentManager } from '@strav/payment'

const payment = container.resolve(PaymentManager)

// Resource-method API, default provider
const customer = await payment.customers.create({ email: 'a@b.co' })
const sub = await payment.subscriptions.create({
  customer: customer.id,
  price: 'price_xxx',
  trialDays: 14,
})

// Route to a named provider
const local = await payment.use('asia').charges.create({
  amount: 4900,
  currency: 'thb',
  customer: customer.id,
  paymentMethod: 'card_xxx',
})
```

## What ships in v1

| Surface | Where |
|---|---|
| Core abstraction: manager, normalized DTOs, errors, capabilities, ledger schema, webhook dispatcher | `@strav/payment` |
| Stripe driver — full coverage (customers, products, prices, subscriptions, payment methods, charges, invoices, checkout, webhooks) | `@strav/payment/stripe` |
| Omise driver — customers, charges, refunds, card payment methods, webhooks. Products / prices / subscriptions / invoices / checkout throw `ProviderUnsupportedError` (Omise has no Stripe-equivalent model). | `@strav/payment/omise` |
| `Billable` / `billable()` — Cashier-style mixin on domain models: `user.charge(payments, ...)`, `user.subscriptions(ledger, 'stripe')`, `user.subscribedToPrice(ledger, 'price_pro', 'stripe')` | `@strav/payment` |
| Paddle driver | **deferred** — lands in a later release. |

## Install

```bash
bun add @strav/payment
```

The Stripe and Omise drivers live as subpath imports under the same package — no separate install. Vendor SDKs (`stripe`, `omise`) are direct deps of `@strav/payment`.

## Configure

```ts
// config/payment.ts
export default {
  default: 'stripe',
  providers: {
    stripe: {
      driver: 'stripe',
      secret: env('STRIPE_SECRET'),
      webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    },
    asia: {
      driver: 'omise',
      publicKey: env('OMISE_PUBLIC_KEY'),
      secretKey: env('OMISE_SECRET_KEY'),
      webhookSecret: env('OMISE_WEBHOOK_SECRET'),
    },
  },
  ledger: {
    enabled: true,        // local mirror tables (customers/subscriptions/invoices). default true.
    syncOnWebhook: true,  // upsert into ledger on every webhook delivery.
  },
}
```

```ts
// bootstrap/providers.ts
import { PaymentProvider } from '@strav/payment'
import { StripePaymentProvider } from '@strav/payment/stripe'
import { OmisePaymentProvider } from '@strav/payment/omise'

export default [
  ConfigProvider,
  LoggerProvider,
  DatabaseProvider,
  PaymentProvider,
  StripePaymentProvider,  // registers `driver: 'stripe'` factory
  OmisePaymentProvider,   // registers `driver: 'omise'` factory
  // ...
]
```

## Database migration

```ts
import { applyPaymentLedgerMigration } from '@strav/payment'

export const migration: Migration = {
  name: '20260601000000_create_payment_ledger',
  async up(db) {
    await applyPaymentLedgerMigration(db, { registry })
  },
}
```

Creates four tables:
- `payment_webhook_event` — system-wide dedup ledger (`(provider, provider_event_id)` unique).
- `payment_customer`, `payment_subscription`, `payment_invoice` — tenanted local mirrors.

Apps that opt out of the mirror tables pass `{ ledgerEnabled: false }` — only the dedup ledger is created.

## Webhooks

```ts
import { paymentWebhook } from '@strav/payment'

router.post('/webhooks/:provider', paymentWebhook())

payment.onWebhookEvent('subscription.created', async (ctx) => {
  const sub = (ctx.event as { _fields?: { id: string; customerId: string } })._fields
  // Local ledger is already up-to-date when this fires (if `syncOnWebhook` is on).
  await mail.send(new SubscriptionWelcomeEmail(sub))
})

payment.onWebhookEvent('charge.succeeded', { provider: 'stripe' }, ...)
```

Flow per delivery:

1. Resolve driver from `:provider`.
2. Read raw body + a known signature header (`stripe-signature`, `paddle-signature`, `x-omise-signature`, `webhook-signature`).
3. `driver.webhook.verify(rawBody, signature)` — 400 on failure.
4. Dedup claim against `payment_webhook_event` — duplicates return 200 without dispatch.
5. `driver.webhook.normalize(event)` — closed union of framework event types.
6. Ledger upsert (when enabled) + handler dispatch.
7. Mark `processed_at`.

## Capabilities + `ProviderUnsupportedError`

```ts
if (payment.use('asia').capabilities.has('checkout.create')) {
  // …
} else {
  // Use a different provider, or build a custom flow.
}
```

Drivers declare the methods they implement. Calling an unsupported method throws `ProviderUnsupportedError` synchronously — no network round-trip wasted.

## Navigation

- [api.md](./api.md) — complete public API reference.
- [guides/stripe.md](./guides/stripe.md) — Stripe quickstart + capability matrix.
- [guides/omise.md](./guides/omise.md) — Omise quickstart + what's supported.
- [guides/switching-providers.md](./guides/switching-providers.md) — how multi-provider apps route by region / currency.
- [guides/payment-links.md](./guides/payment-links.md) — shareable hosted pay URLs (`payment.links.*`).
- [guides/idempotency.md](./guides/idempotency.md) — `idempotencyKey` on create-style calls, capability gating, and the app-side dedup pattern for providers without native support.
- [guides/multi-tenancy.md](./guides/multi-tenancy.md) — `tenantedMetadata` convention, the round-trip, and how the dispatcher routes webhook events into the right tenant scope.
