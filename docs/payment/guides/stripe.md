# Stripe quickstart

## Configure

```ts
// config/payment.ts
import { env } from '@strav/kernel'

export default {
  default: 'stripe',
  providers: {
    stripe: {
      driver: 'stripe',
      secret: env('STRIPE_SECRET'),
      webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
      apiVersion: '2024-04-10',  // optional pin
    },
  },
}
```

```ts
// bootstrap/providers.ts
import { PaymentProvider } from '@strav/payment'
import { StripePaymentProvider } from '@strav/payment/stripe'

export default [
  ConfigProvider, LoggerProvider, DatabaseProvider,
  PaymentProvider,
  StripePaymentProvider,
  // ...
]
```

## Use

```ts
const payment = container.resolve(PaymentManager)

// One-shot charge
const charge = await payment.charges.create({
  amount: 4999,
  currency: 'usd',
  customer: 'cus_xxx',
  paymentMethod: 'pm_yyy',
})

// Subscription with trial
const sub = await payment.subscriptions.create({
  customer: 'cus_xxx',
  price: 'price_zzz',
  trialDays: 14,
})

// Hosted checkout
const session = await payment.checkout.create({
  mode: 'subscription',
  items: [{ price: 'price_zzz', quantity: 1 }],
  successUrl: 'https://app.example.com/success',
  cancelUrl: 'https://app.example.com/cancel',
})
return Response.redirect(session.url, 303)
```

## Capability matrix

| Capability | Supported |
|---|---|
| customers.* | ✓ |
| products.* | ✓ |
| prices.* | ✓ |
| subscriptions.* (incl. trials, change plan, cancel) | ✓ |
| paymentMethods.{attach,detach,list} | ✓ |
| charges.{create,refund,capture} | ✓ |
| invoices.{retrieve,list,finalize,void} | ✓ |
| checkout.{create,retrieve} | ✓ |
| webhook.{verify,normalize} | ✓ |

### Async payment methods

| `charges.method.<kind>` | Supported | Next action shape |
|---|---|---|
| `card` | ✓ | none (synchronous) — 3DS → `authorize` |
| `promptpay` | ✓ | `display_qr` |
| `paynow` | ✓ | `display_qr` |
| `wechat_pay` | ✓ | `display_qr` (web client) |
| `alipay` | ✓ | `redirect` |
| `grabpay` | ✓ | `redirect` |
| `kakaopay` | ✓ | `redirect` |
| `konbini` | ✓ | `voucher` (hosted invoice URL + confirmation number) |
| `truemoney` / `fps` / `rabbit_linepay` | ✗ — Omise only | n/a |

```ts
// PromptPay flow
const charge = await payment.charges.create({
  amount: 39900,
  currency: 'thb',
  customer: 'cus_xxx',
  paymentMethod: { kind: 'promptpay' },
  returnUrl: 'https://app.example.com/billing/complete',
})

if (charge.status === 'requires_action' && charge.nextAction?.kind === 'display_qr') {
  return view.render('show_qr', {
    qrImage: charge.nextAction.qrImageUrl,  // Stripe-hosted PNG
    qrData: charge.nextAction.qrData,       // raw EMV / SGQR string
  })
}

// …on `charge.succeeded` webhook, mark the order paid.
```

`returnUrl` is **required** for any non-card spec — even QR-based methods, because Stripe redirects the customer back after polling. Set `config.payment.returnUrl` as a global default (config slot lands with slice 7.5) or pass it per call.

## Raw SDK access

```ts
const driver = payment.use('stripe') as StripePaymentDriver
const sigma = await driver.client.sigma.scheduledQueryRuns.list()
```

Use this for surfaces the framework doesn't wrap (Sigma, Issuing, Terminal, etc.).

## Webhook events handled by `stripeNormalize`

| Stripe event | Normalized type |
|---|---|
| `customer.created` / `customer.updated` / `customer.deleted` | `customer.*` |
| `customer.subscription.created` / `updated` / `deleted` / `trial_will_end` | `subscription.*` |
| `charge.succeeded` / `charge.failed` / `charge.refunded` | `charge.*` |
| `invoice.created` / `invoice.paid` / `invoice.payment_failed` / `invoice.voided` | `invoice.*` |
| `checkout.session.completed` / `checkout.session.expired` | `checkout.*` |
| `payment_method.attached` / `payment_method.detached` | `payment_method.*` |

Events outside this set still get a `payment_webhook_event` dedup row but no user-handler dispatch.
