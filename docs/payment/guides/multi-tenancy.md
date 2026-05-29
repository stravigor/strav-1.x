# Multi-tenancy on payment webhooks

Webhooks arrive at one endpoint per provider for the whole app, even when the app serves many tenants. The framework needs to know which tenant a delivery belongs to before it can write to the tenanted ledger or hand the event to a per-tenant handler.

The answer is **provider metadata**: every create-call stamps `strav_tenant_id` in the resource's metadata, and the driver reads it back off the webhook payload.

```ts
import { tenantedMetadata } from '@strav/payment'

await payment.customers.create({
  email: user.email,
  // …whatever else…
  metadata: tenantedMetadata(user.tenant_id, { source: 'signup' }),
})
```

`tenantedMetadata(tenantId, extra?)` returns `{ ...extra, strav_tenant_id: tenantId }`. Use it on every create call that should produce tenant-scoped webhook events — `customers.create`, `charges.create`, `subscriptions.create`, `paymentMethods.attach`, `checkout.create`, `links.create`.

## The round-trip

1. App stamps `strav_tenant_id` on the call's metadata. The driver passes it to Stripe / Omise verbatim.
2. The provider stores the metadata against the resource (customer, subscription, charge, invoice).
3. Every webhook event the provider sends includes that resource's metadata.
4. `stripeNormalize` / `omiseNormalize` read `metadata.strav_tenant_id` off the event payload → `NormalizedWebhookEvent.tenantId`.
5. The webhook dispatcher checks for the tenant id. When set + `TenantManager` is wired, it calls `tenantManager.withTenant(event.tenantId, async (tx) => { … })`. The ledger upsert and the user handler run inside that scope; `current_setting('app.tenant_id')` resolves to the right tenant for RLS + the ledger's `tenant_id` column.

## Wiring

Three things have to be true for the routing to take effect:

1. **`TenantManager` bound to the container** — apps that already use `@strav/database`'s tenancy have this. `PaymentProvider` tries to resolve it; when missing, it logs nothing (multi-tenancy is opt-in).
2. **`config.payment.ledger.syncOnWebhook: true`** — default. Otherwise ledger writes are skipped (handler dispatch still fires).
3. **App stamps `strav_tenant_id`** on every create call.

When the third is missing, the dispatcher:

- **Skips the ledger write.** The `payment_customer` / `payment_subscription` / `payment_invoice` tables are tenanted (NOT NULL `tenant_id`); writing without scope would fail RLS or violate the constraint.
- **Still fires user handlers** (no tenant context), so apps can fall back to manual reconciliation — read the original create call's metadata off `ctx.event.raw` and write to the ledger themselves.

A one-shot reconciliation script that reads the provider metadata off historical events is a clean recovery path for apps that adopt the convention partway through their lifecycle.

## Forgetting the stamp

There's no easy compile-time check that every create call carries `tenantedMetadata`. Two pragmatic guards:

```ts
// 1. Wrap your repository / service layer.
async function createCustomer(input: CreateCustomerInput, tenantId: string) {
  return payment.customers.create({
    ...input,
    metadata: tenantedMetadata(tenantId, input.metadata),
  })
}

// 2. Lint or grep CI rule that flags any direct `payment.*.create(` without
// `tenantedMetadata(`. Cheap and effective.
```

## The webhook handler context

When the event carried a `tenantId`, the handler runs inside `withTenant` and can use any tenanted repository freely:

```ts
payment.onWebhookEvent('subscription.created', async (ctx) => {
  // ctx.tenantId is set; the current connection is scoped to it.
  await subscriptions.create({
    user_id: lookupUserBy(ctx.event.data.customerId),
    status: 'active',
  })  // tenant_id auto-fills via withTenant
})
```

If the event carried no `tenantId`, the handler still fires but **without** tenant context. Apps can branch on `ctx.tenantId` to short-circuit safely:

```ts
payment.onWebhookEvent('charge.succeeded', async (ctx) => {
  if (!ctx.tenantId) {
    logger.warn('charge.succeeded missing tenant metadata', { id: ctx.eventId })
    return
  }
  // safe to use tenant-scoped repos here
})
```

## Test fixtures

For unit tests, `tenantedMetadata` works as-is — the helper has no runtime dependency on a real provider. For e2e tests against real Postgres, the `m6-payment` suite at `tests/e2e/m6-payment/` shows the full setup: TenantManager bound, ledger sync on, stamped + unstamped event paths both exercised.
