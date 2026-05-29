# Idempotency

Network failures on SEA mobile rails are routine — payments time out before the server responds, retries fire from app or queue. Without idempotency keys, every retry risks a duplicate charge.

`@strav/payment` exposes a single capability flag (`idempotency`) and an `idempotencyKey?: string` field on every create-style call. The semantics are intentionally honest about provider gaps.

```ts
await payment.charges.create({
  amount: 39900,
  currency: 'thb',
  customer: 'cus_xxx',
  paymentMethod: { kind: 'promptpay' },
  idempotencyKey: `order-${order.id}-attempt-1`,
})
```

## Provider matrix

| Provider | `capabilities.has('idempotency')` | Behaviour |
|---|---|---|
| Stripe | ✓ | Forwards as `Idempotency-Key` header. Server-side dedup ~24h. |
| Omise | ✗ | **Silently dropped.** Omise's Node SDK exposes no per-request header hook, so the driver can't send it. Apps that need dedup on Omise build it app-side. |
| Mock | ✓ | In-memory dedup (per driver instance) — useful in tests. |

## Pattern for SEA apps using Omise

Because Omise doesn't enforce dedup, the safe pattern is to claim the key in your own database **before** calling `charges.create`. Strav apps already have transactional schemas; one tenanted `payment_idempotency` table covers it:

```ts
// Pseudo-code — pick your own schema shape.
await db.transaction(async (tx) => {
  const claimed = await tx.query(
    `INSERT INTO payment_idempotency (key, claimed_at)
     VALUES ($1, NOW())
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [idempotencyKey],
  )
  if (claimed.length === 0) {
    // Some prior attempt already claimed it — read the prior charge id
    // from your own ledger and return that instead of re-calling Omise.
    return getStoredChargeIdFor(idempotencyKey)
  }
})

const charge = await payment.use('asia').charges.create({
  amount, currency: 'thb', paymentMethod, idempotencyKey,
})
await rememberChargeIdFor(idempotencyKey, charge.id)
```

The pattern is identical for any driver that doesn't declare `idempotency` — the capability flag lets generic code branch automatically:

```ts
async function safeCharge(driver: PaymentDriver, input: CreateChargeInput) {
  if (!driver.capabilities.has('idempotency') && input.idempotencyKey) {
    await claimAppSide(input.idempotencyKey)  // throws on collision
  }
  return driver.charges.create(input)
}
```

## Which inputs accept `idempotencyKey`

Every create-style operation that touches money or persistent resources:

| Input | Used by |
|---|---|
| `CreateChargeInput` | `charges.create` |
| `CreateRefundInput` | `charges.refund` |
| `CreateSubscriptionInput` | `subscriptions.create` |
| `CreateCheckoutInput` | `checkout.create` |
| `CreatePaymentLinkInput` | `links.create` |
| `CreateCustomerInput` | `customers.create` |

Products and prices intentionally don't accept the key — they're admin-time configuration, not user-facing transactions, and Stripe's idempotency window doesn't help with the duplicate-catalog problem (which the schema solves anyway via `unique(name)` etc.).

## Naming the key

Keep keys deterministic from the business operation, not the wall clock. Recommended shape:

```
<operation>-<resource-id>-<attempt-counter>
```

Examples:

```
charge-order_01HQ-attempt-1
refund-charge_01HQ-attempt-1
sub-subscription_01HQ-attempt-1
```

The attempt counter only matters when the *operation* itself changes (different amount, different method) — not for naive retries of the same call. Stripe's 24h window means a stale attempt-1 key reused tomorrow returns yesterday's result. Apps that retry across days bump the counter.

## When NOT to pass `idempotencyKey`

- Operations the user can naturally retry by hitting a button (Stripe still dedups so it's safe, just unnecessary noise).
- Webhook handlers — the framework's `payment_webhook_event` table already provides exactly-once delivery semantics for events. Don't re-stamp inside the handler.
