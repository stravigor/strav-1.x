# Switching providers + multi-provider apps

`@strav/payment` is built for apps that route payments across PSPs — by region, by currency, by experiment cohort. The routing primitive is `payment.use(name)`.

## Two providers, routed by region

```ts
// config/payment.ts
export default {
  default: 'stripe',
  providers: {
    stripe: { driver: 'stripe', secret: env('STRIPE_SECRET'), webhookSecret: env('STRIPE_WEBHOOK_SECRET') },
    asia:   { driver: 'omise',  publicKey: env('OMISE_PUBLIC_KEY'), secretKey: env('OMISE_SECRET_KEY'), webhookSecret: env('OMISE_WEBHOOK_SECRET') },
  },
}
```

```ts
const driverName = user.country === 'TH' ? 'asia' : 'stripe'
const charge = await payment.use(driverName).charges.create({
  amount,
  currency: user.country === 'TH' ? 'thb' : 'usd',
  customer: user.providerCustomerId,
  paymentMethod: paymentMethodId,
})
```

## Capability-aware routing

```ts
function pickProvider(): string {
  const omise = payment.use('asia')
  return omise.capabilities.has('subscriptions.create') ? 'asia' : 'stripe'
}
```

Omise doesn't support subscriptions in v1, so subscription flows skip it automatically.

## One webhook endpoint per provider

Mount the dispatcher once at `/webhooks/:provider`. Both `https://app.example.com/webhooks/stripe` and `https://app.example.com/webhooks/asia` work; the `:provider` param picks which driver verifies the signature.

```ts
router.post('/webhooks/:provider', paymentWebhook())
```

Stripe Dashboard → endpoint URL `…/webhooks/stripe`.
Omise Dashboard → endpoint URL `…/webhooks/asia`.

Filter handlers by provider when you need provider-specific logic:

```ts
payment.onWebhookEvent('charge.succeeded', { provider: 'stripe' }, stripeHandler)
payment.onWebhookEvent('charge.succeeded', { provider: 'asia' },   omiseHandler)
payment.onWebhookEvent('customer.created', anyProviderHandler)
```

## Why the abstraction (and what it can't hide)

It hides:

- API mechanics — verbs, error shapes, ID prefixes, pagination cursors.
- Webhook plumbing — signature verification, dedup, normalized event types.
- Local mirroring — ledger upsert flow is uniform.

It cannot hide:

- **Currency support** — `thb` works on Omise, `usd` works on both. Pick the right one.
- **Feature parity** — Omise has no subscriptions / invoices / hosted checkout; capability-gate flows that need them.
- **Token formats** — Stripe `pm_…`, Omise `tokn_…`. Tokens are issued client-side by each PSP's JS SDK; apps stamp the right one.
- **Compliance posture** — PCI/SCA/3DS flows are provider-specific. The framework surfaces `requires_action` charge states; apps drive the redirect.
