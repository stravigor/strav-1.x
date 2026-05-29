# Payment links

Shareable hosted URLs the customer opens to pay. Distinct from **checkout** (multi-step session tied to a single customer journey) — links are meant to be shared (email, SMS, QR poster) and used many times.

```ts
const link = await payment.links.create({...})
// → link.url = 'https://buy.stripe.com/test_x' or 'https://pay.omise.co/link_x'
```

## Provider divergence

The two adapters take different inputs because their data models differ:

| | Stripe | Omise |
|---|---|---|
| Input shape | `items: [{ price, quantity? }]` (catalogue Price ids only) | `amount` + `currency` + `title` + `description` (ad-hoc only) |
| Reusable by default | yes | no (`reusable: true` to enable) |
| `deactivate` supported | ✓ (`active: false`) | ✗ — throws `ProviderUnsupportedError` |
| Post-payment redirect | `afterCompletionRedirect` → `after_completion.redirect.url` | not supported (provider-default success page) |

```ts
// Stripe — needs a Price first
const price = await payment.use('stripe').prices.create({
  product: 'prod_xxx',
  amount: 4900,
  currency: 'usd',
})
const link = await payment.use('stripe').links.create({
  items: [{ price: price.id, quantity: 1 }],
  afterCompletionRedirect: 'https://app.example.com/thanks',
})

// Omise — ad-hoc
const link = await payment.use('asia').links.create({
  amount: 39900,
  currency: 'thb',
  title: 'Pro plan',
  description: 'Monthly billing',
  reusable: true,
})
```

Apps that route across both providers branch on capability:

```ts
const driver = payment.use(provider)
if (driver.capabilities.has('links.create')) {
  // Each driver enforces its own input shape — the call site
  // adapts.
}
```

## Lifecycle

- `active: true` — the link accepts new payments.
- `active: false` — deactivated. Existing in-flight checkout sessions still settle.
- `reusable: false` — single-use; the link auto-deactivates after the first successful payment (Omise default).
- `reusable: true` — multi-use; remains active until `deactivate` (Stripe) or manual removal from the dashboard (Omise).

Settlement arrives via the standard `charge.succeeded` webhook (Stripe pairs the charge with the link via `payment_link` metadata; Omise pairs via the `link` field on the charge).

## Capability matrix

| Capability | Stripe | Omise |
|---|---|---|
| `links.create` | ✓ | ✓ |
| `links.deactivate` | ✓ | ✗ |

## When to use a link vs checkout vs a charge

- **`payment.charges.create({ paymentMethod: {...} })`** — you already have the customer in your app and know what they're paying with (card token, PromptPay QR request, etc.).
- **`payment.checkout.create({...})`** — you want the provider to collect customer details (email, shipping address, payment method) inside one customer journey. Single use, customer-specific.
- **`payment.links.create({...})`** — you want a stable URL to share (invoice email, retail counter QR, Slack message) and don't care about per-customer state.
