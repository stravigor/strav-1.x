# @strav/payment — API reference

Public API of `@strav/payment` and its subpaths.

## Top-level surface (`@strav/payment`)

### `PaymentManager`

```ts
class PaymentManager {
  readonly config: PaymentConfig
  readonly webhookRegistry: PaymentWebhookRegistry
  readonly ledger: PaymentLedger | undefined

  use(name?: string): PaymentDriver
  extend(driverName: string, factory: PaymentDriverFactory): void
  useDriver(instanceName: string, driver: PaymentDriver): void

  // Resource namespaces — route to the default driver.
  readonly customers: CustomerOps
  readonly products: ProductOps
  readonly prices: PriceOps
  readonly subscriptions: SubscriptionOps
  readonly paymentMethods: PaymentMethodOps
  readonly charges: ChargeOps
  readonly invoices: InvoiceOps
  readonly checkout: CheckoutOps
  readonly webhook: WebhookOps

  onWebhookEvent(type: PaymentEventType, handler: WebhookHandler): void
  onWebhookEvent(type: PaymentEventType, filter: WebhookHandlerFilter, handler: WebhookHandler): void
  clearWebhookHandlers(): void
}
```

### `PaymentProvider`

`ServiceProvider`. Wires `PaymentManager`, `PaymentWebhookEventRepository`, and (when `ledger.enabled`) `PaymentLedger`. Depends on `config` + `database`.

### `paymentWebhook(options?)`

Returns an `@strav/http` route handler. Mount at `/webhooks/:provider`. Verifies signature, dedups via `payment_webhook_event`, normalizes, syncs ledger, dispatches handlers.

### Configuration

```ts
interface PaymentConfig {
  default: string
  providers: Record<string, ProviderConfig>
  ledger?: { enabled?: boolean; syncOnWebhook?: boolean }
}

interface ProviderConfig {
  driver: string
  [key: string]: unknown
}
```

### `PaymentDriver` (driver contract)

```ts
interface PaymentDriver {
  readonly name: string
  readonly instanceName: string
  readonly capabilities: ReadonlySet<PaymentCapability>

  readonly customers: CustomerOps
  readonly products: ProductOps
  readonly prices: PriceOps
  readonly subscriptions: SubscriptionOps
  readonly paymentMethods: PaymentMethodOps
  readonly charges: ChargeOps
  readonly invoices: InvoiceOps
  readonly checkout: CheckoutOps
  readonly webhook: WebhookOps
}
```

The `*Ops` interfaces declare the full surface every driver implements. Methods a driver can't fulfil throw `ProviderUnsupportedError`.

### `PaymentCapability`

String-literal union covering every method drivers declare support for — e.g. `'customers.create'`, `'subscriptions.trials'`, `'checkout.create'`, `'webhook.verify'`. See `payment_capabilities.ts` for the full list.

### Normalized DTOs

Every resource has a `Payment<X>` shape: `PaymentCustomer`, `PaymentProduct`, `PaymentPrice`, `PaymentSubscription`, `PaymentMethod`, `PaymentCharge`, `PaymentRefund`, `PaymentInvoice`, `PaymentCheckoutSession`. Each carries the native provider object on `.raw`.

### Ledger

| Export | Purpose |
|---|---|
| `applyPaymentLedgerMigration(db, { registry, ledgerEnabled? })` | Emit DDL for every framework-owned table. |
| `paymentCustomerSchema`, `paymentSubscriptionSchema`, `paymentInvoiceSchema` | Tenanted mirror schemas. |
| `paymentWebhookEventSchema` | System-wide dedup schema. |
| `PaymentLedger.applyEvent(event)` | Upsert local mirror from a normalized event. Invoked by `paymentWebhook()` when `syncOnWebhook` is true. |
| `PaymentCustomerRow`, `PaymentSubscriptionRow`, `PaymentInvoiceRow` | Typed row models for app-side queries. |

### Errors

```
PaymentError (extends StravError)
├── PaymentConfigError         (500 — boot)
├── UnknownProviderError       (400 — config.payment.providers lookup miss)
├── ProviderUnsupportedError   (400 — driver doesn't implement op)
├── WebhookSignatureError      (400 — signature mismatch / missing secret)
├── WebhookIdempotencyError    (400 — malformed dedup payload)
└── PaymentProviderError       (502 — wraps vendor exceptions; preserves .cause)
```

### Webhook dispatch

```ts
type PaymentEventType =
  | 'customer.created' | 'customer.updated' | 'customer.deleted'
  | 'subscription.created' | 'subscription.updated' | 'subscription.canceled'
  | 'subscription.trial_will_end'
  | 'charge.succeeded' | 'charge.failed' | 'charge.refunded'
  | 'invoice.created' | 'invoice.paid' | 'invoice.payment_failed' | 'invoice.voided'
  | 'checkout.completed' | 'checkout.expired'
  | 'payment_method.attached' | 'payment_method.detached'

interface NormalizedWebhookEvent {
  id: string
  type: PaymentEventType
  provider: string
  raw: unknown
  data: { customerId?: string; subscriptionId?: string; invoiceId?: string; chargeId?: string; checkoutId?: string; paymentMethodId?: string }
}
```

### Mock driver

`MockDriver` — in-memory reference implementation. `unsupported(provider, op, reason?)` — helper drivers use to stub out methods they don't support.

## `@strav/payment/stripe`

| Export | Notes |
|---|---|
| `StripePaymentProvider` | ServiceProvider — registers `driver: 'stripe'`. |
| `StripePaymentDriver` | Direct driver instance (for tests + `useDriver()`). |
| `StripeProviderConfig` | `{ driver: 'stripe', secret, webhookSecret?, apiVersion?, client? }`. |
| `stripeNormalize(event)` | Standalone Stripe `Event` → `NormalizedWebhookEvent` mapper. |
| `toPaymentCustomer`, `toPaymentSubscription`, … | Per-resource mappers (advanced). |

Full capability set — Stripe covers every framework-declared method.

## `@strav/payment/omise`

| Export | Notes |
|---|---|
| `OmisePaymentProvider` | ServiceProvider — registers `driver: 'omise'`. |
| `OmisePaymentDriver` | Direct driver instance. |
| `OmiseProviderConfig` | `{ driver: 'omise', publicKey, secretKey, webhookSecret?, omiseVersion?, client? }`. |
| `omiseVerify(rawBody, signature, secret)` | HMAC SHA-256 signature verifier. |
| `omiseNormalize(event)` | Omise event → `NormalizedWebhookEvent` mapper. |

Capability set: `customers.*`, `charges.{create,retrieve,capture,refund}`, `paymentMethods.{attach,detach,list}` (detach requires the owning `customerId`), `subscriptions.{create,retrieve,cancel,list}` via Omise schedules (`update`, `changePlan`, `trials` not supported), `webhook.{verify,normalize}`. Everything else throws `ProviderUnsupportedError`.
