# Omise quickstart

## Configure

```ts
// config/payment.ts
export default {
  default: 'omise',
  providers: {
    omise: {
      driver: 'omise',
      publicKey: env('OMISE_PUBLIC_KEY'),    // pkey_test_… / pkey_live_…
      secretKey: env('OMISE_SECRET_KEY'),    // skey_test_… / skey_live_…
      webhookSecret: env('OMISE_WEBHOOK_SECRET'),
    },
  },
}
```

```ts
import { PaymentProvider } from '@strav/payment'
import { OmisePaymentProvider } from '@strav/payment/omise'

export default [
  ConfigProvider, LoggerProvider, DatabaseProvider,
  PaymentProvider,
  OmisePaymentProvider,
]
```

## Use

```ts
const customer = await payment.customers.create({
  email: 'a@b.co',
  name: 'Customer Name',
})

const charge = await payment.charges.create({
  amount: 100_00,   // 100 THB in satang
  currency: 'thb',
  customer: customer.id,
  paymentMethod: 'tokn_yyy',  // tokenize client-side via Omise.js
})

// Refund (full or partial)
await payment.charges.refund({ charge: charge.id })
await payment.charges.refund({ charge: charge.id, amount: 50_00 })
```

## Async payment methods (via Omise Sources)

Omise's async flow is two-step: framework creates a `source` (carries the method type + amount), then a `charge` referencing that source. The driver runs both calls; apps see one `payment.charges.create(...)`.

| `charges.method.<kind>` | Supported | Next action |
|---|---|---|
| `card` | ✓ | none (synchronous) |
| `promptpay` | ✓ | `display_qr` (PNG URL) |
| `truemoney` | ✓ — needs `phoneNumber` | `redirect` |
| `alipay` | ✓ | `redirect` |
| `wechat_pay` | ✓ | `redirect` (or QR depending on Omise account) |
| `grabpay` | ✓ | `redirect` |
| `rabbit_linepay` | ✓ | `redirect` |
| `paynow` / `kakaopay` / `konbini` / `fps` | ✗ — Stripe only | n/a |

```ts
// PromptPay — QR (no returnUrl needed; settlement is async)
const charge = await payment.use('asia').charges.create({
  amount: 39900,
  currency: 'thb',
  paymentMethod: { kind: 'promptpay' },
})
if (charge.nextAction?.kind === 'display_qr') {
  return view.render('show_qr', { src: charge.nextAction.qrImageUrl })
}

// TrueMoney — redirect (returnUrl required)
const charge = await payment.use('asia').charges.create({
  amount: 5000,
  currency: 'thb',
  paymentMethod: { kind: 'truemoney', phoneNumber: '+66812345678' },
  returnUrl: 'https://app.example.com/billing/complete',
})
if (charge.nextAction?.kind === 'redirect') {
  return Response.redirect(charge.nextAction.url, 303)
}
```

Settlement arrives on a `charge.succeeded` webhook (Omise's `charge.complete` event, normalized).

> **QR data caveat**: Omise exposes the rendered PNG via `source.scannable_code.image.download_uri`, not a raw EMV string. The framework mirrors the same URL into both `qrData` and `qrImageUrl` so apps using either field work — display it as an `<img src>`.

## Capability matrix

| Capability | Supported |
|---|---|
| customers.* | ✓ |
| paymentMethods.attach | ✓ (passes card token; joins to customer) |
| paymentMethods.list | ✓ (lists cards on the customer) |
| paymentMethods.detach | ✓ — requires the owning customer id: `payment.paymentMethods.detach(cardId, customerId)`. Omitting `customerId` throws `ProviderUnsupportedError`. Stripe ignores the second arg (it can resolve the customer from the card id alone). |
| charges.{create,retrieve,capture,refund} | ✓ |
| subscriptions.{create,retrieve,cancel} | ✓ via Omise schedules. `price` is an `omise_spec:…` blob built with `omisePriceSpec({...})`. |
| subscriptions.list | ✓ but requires `customer` — Omise lists schedules per-customer only. |
| subscriptions.update | ✗ Omise schedules are immutable. Cancel + recreate. |
| subscriptions.changePlan / trials | ✗ Not supported by the schedules model. |
| products / prices | ✗ Omise has no catalog. Pass `amount` + `currency` directly to `charges.create`. |
| invoices | ✗ Omise has no invoices. |
| checkout | ✗ Omise has Payment Links, not multi-mode checkout. Use `driver.client.links.*` directly. |
| webhook.{verify,normalize} | ✓ |

Unsupported methods throw `ProviderUnsupportedError` synchronously — no network round-trip.

## Subscriptions via Omise schedules

Omise has no "subscription" object; recurring billing runs through the **schedules** API (create a schedule that fires a charge every N periods). The framework bridges this onto `SubscriptionOps` with one wrinkle: the framework `price` field is a string, and Omise has no price catalogue. Build a portable inline spec with `omisePriceSpec`:

```ts
import { omisePriceSpec } from '@strav/payment/omise'

const sub = await payment.use('asia').subscriptions.create({
  customer: 'cust_xxx',
  price: omisePriceSpec({
    amount: 39900,           // satang
    currency: 'thb',
    period: 'month',
    every: 1,                // every 1 month — defaults to 1
    description: 'Pro plan',
  }),
})

await payment.use('asia').subscriptions.cancel(sub.id) // immediate stop
const sub2 = await payment.use('asia').subscriptions.retrieve(sub.id)

// List is per-customer only
const page = await payment.use('asia').subscriptions.list({ customer: 'cust_xxx' })
```

What you don't get vs Stripe:
- **No trial days** — trials throw `ProviderUnsupportedError`.
- **No plan changes mid-cycle** — schedules are immutable; cancel and recreate.
- **No "cancel at period end"** — `cancel()` stops immediately regardless of `options.at`.
- **End date** defaults to one year out. Apps that need a different horizon call `driver.client.schedules.create({...})` directly.

The schedule id is what `PaymentSubscription.id` carries; `priceId` is the same `omise_spec:…` string round-tripped from the schedule's charge config (so re-creating with the same spec is a one-liner).

## Webhook events handled by `omiseNormalize`

| Omise event `key` | Normalized type |
|---|---|
| `customer.create` / `customer.update` / `customer.destroy` | `customer.*` |
| `charge.create` / `charge.complete` / `charge.update` / `charge.capture` | `charge.succeeded` |
| `charge.expire` | `charge.failed` |
| `refund.create` | `charge.refunded` |
| `schedule.create` / `schedule.update` / `schedule.destroy` | `subscription.created` / `subscription.updated` / `subscription.canceled` |

Omise webhook signature uses HMAC SHA-256 over the raw body with the secret from the Dashboard, sent in `X-Omise-Signature`. Verified by `omiseVerify` (also called transparently by the `paymentWebhook()` route).

## Raw SDK access

```ts
const driver = payment.use('omise') as OmisePaymentDriver
const schedule = await driver.client.schedules.create({...})
```

## Why so much "not supported"?

Omise's data model is genuinely different from Stripe's. Rather than half-implement features with surprising edge cases, the v1 driver maps cleanly onto the subset that fits (customers + ad-hoc charges + cards) and exposes the rest via `driver.client.*`. Apps that want a unified billing-catalog experience use Stripe for the catalog + Omise as a regional charge provider, routed by `payment.use(name)`.
