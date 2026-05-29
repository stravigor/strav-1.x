/**
 * `MockDriver` — in-memory driver used by unit tests and as the
 * reference implementation for the `PaymentDriver` contract.
 *
 * Round-trips every operation through plain Maps; webhooks are
 * "verified" by string comparison against a configured secret.
 * Apps that need a mock for tests register this via
 * `manager.extend('mock', () => new MockDriver({ instanceName }))`
 * — or use `manager.useDriver(name, mockDriver)` to bypass the
 * factory.
 *
 * Capability set: full. The mock declares every capability so
 * apps testing capability-gated UI see the "happy path" code.
 * Tests that exercise `ProviderUnsupportedError` should
 * instantiate with `capabilities: new Set(...)` overrides.
 */

import { ulid } from '@strav/kernel'
import { WebhookSignatureError } from '../payment_error.ts'
import type { PaymentCapability } from '../payment_capabilities.ts'
import { extractCardToken, paymentMethodKind } from './payment_method_helpers.ts'
import type {
  ChargeOps,
  CheckoutOps,
  CustomerOps,
  InvoiceOps,
  LinkOps,
  PaymentDriver,
  PaymentMethodOps,
  PriceOps,
  ProductOps,
  SubscriptionOps,
  WebhookOps,
} from '../payment_driver.ts'
import type {
  CancelSubscriptionOptions,
  CreateChargeInput,
  CreateCheckoutInput,
  CreateCustomerInput,
  CreatePaymentLinkInput,
  CreatePriceInput,
  CreateProductInput,
  CreateRefundInput,
  CreateSubscriptionInput,
  ListInvoicesOptions,
  ListPaymentLinksOptions,
  ListPaymentMethodsOptions,
  NormalizedWebhookEvent,
  PaymentCharge,
  PaymentCheckoutSession,
  PaymentCustomer,
  PaymentInvoice,
  PaymentLink,
  PaymentMethod,
  PaymentMethodSpec,
  PaymentNextAction,
  PaymentPrice,
  PaymentProduct,
  PaymentRefund,
  PaymentSubscription,
  UpdateCustomerInput,
  UpdateSubscriptionInput,
} from '../dto/index.ts'

const ALL_CAPS: readonly PaymentCapability[] = [
  'customers.create', 'customers.update', 'customers.retrieve', 'customers.list', 'customers.delete',
  'products.create', 'products.update', 'products.list',
  'prices.create', 'prices.list',
  'subscriptions.create', 'subscriptions.retrieve', 'subscriptions.update',
  'subscriptions.cancel', 'subscriptions.changePlan', 'subscriptions.trials',
  'paymentMethods.attach', 'paymentMethods.detach', 'paymentMethods.list',
  'charges.create', 'charges.refund', 'charges.capture',
  // mock supports every payment method spec so apps exercising
  // capability-gated UI see the happy path. Override via
  // `MockDriverOptions.capabilities` for tests that need a narrow
  // set.
  'charges.method.card', 'charges.method.promptpay', 'charges.method.paynow',
  'charges.method.fps', 'charges.method.truemoney', 'charges.method.alipay',
  'charges.method.wechat_pay', 'charges.method.grabpay', 'charges.method.kakaopay',
  'charges.method.rabbit_linepay', 'charges.method.konbini',
  'charges.nextAction.display_qr', 'charges.nextAction.redirect',
  'charges.nextAction.authorize', 'charges.nextAction.voucher',
  'charges.nextAction.wait',
  'invoices.list', 'invoices.retrieve', 'invoices.finalize', 'invoices.void',
  'checkout.create', 'checkout.retrieve',
  'links.create', 'links.deactivate',
  'idempotency',
  'webhook.verify', 'webhook.normalize',
]

export interface MockDriverOptions {
  instanceName?: string
  /** Override the capability set. Defaults to "all". */
  capabilities?: ReadonlySet<PaymentCapability>
  /** Webhook secret used for "verify" — header value must match. */
  webhookSecret?: string
}

export class MockDriver implements PaymentDriver {
  readonly name = 'mock'
  readonly instanceName: string
  readonly capabilities: ReadonlySet<PaymentCapability>

  private readonly webhookSecret: string
  private readonly customersById = new Map<string, PaymentCustomer>()
  private readonly productsById = new Map<string, PaymentProduct>()
  private readonly pricesById = new Map<string, PaymentPrice>()
  private readonly subscriptionsById = new Map<string, PaymentSubscription>()
  private readonly paymentMethodsById = new Map<string, PaymentMethod>()
  private readonly chargesById = new Map<string, PaymentCharge>()
  private readonly invoicesById = new Map<string, PaymentInvoice>()
  private readonly checkoutsById = new Map<string, PaymentCheckoutSession>()
  private readonly linksById = new Map<string, PaymentLink>()

  constructor(options: MockDriverOptions = {}) {
    this.instanceName = options.instanceName ?? 'mock'
    this.capabilities = options.capabilities ?? new Set(ALL_CAPS)
    this.webhookSecret = options.webhookSecret ?? 'whsec_mock'
  }

  readonly customers: CustomerOps = {
    create: async (input: CreateCustomerInput): Promise<PaymentCustomer> => {
      const customer: PaymentCustomer = {
        id: `cus_${ulid()}`,
        provider: this.name,
        email: input.email,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        metadata: input.metadata ?? {},
        createdAt: new Date(),
        raw: { ...input, mock: true },
      }
      this.customersById.set(customer.id, customer)
      return customer
    },
    retrieve: async (id: string): Promise<PaymentCustomer> => {
      const c = this.customersById.get(id)
      if (!c) throw new Error(`MockDriver: customer "${id}" not found`)
      return c
    },
    update: async (id: string, input: UpdateCustomerInput): Promise<PaymentCustomer> => {
      const c = await this.customers.retrieve(id)
      const next: PaymentCustomer = {
        ...c,
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        metadata: { ...c.metadata, ...(input.metadata ?? {}) },
      }
      this.customersById.set(id, next)
      return next
    },
    list: async () => ({ data: [...this.customersById.values()], nextCursor: null }),
    delete: async (id: string) => {
      this.customersById.delete(id)
    },
  }

  readonly products: ProductOps = {
    create: async (input: CreateProductInput): Promise<PaymentProduct> => {
      const p: PaymentProduct = {
        id: `prod_${ulid()}`,
        provider: this.name,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        active: input.active ?? true,
        metadata: input.metadata ?? {},
        createdAt: new Date(),
        raw: { ...input, mock: true },
      }
      this.productsById.set(p.id, p)
      return p
    },
    retrieve: async (id: string) => {
      const p = this.productsById.get(id)
      if (!p) throw new Error(`MockDriver: product "${id}" not found`)
      return p
    },
    update: async (id: string, input: Partial<CreateProductInput>) => {
      const p = await this.products.retrieve(id)
      const next: PaymentProduct = { ...p, ...input, metadata: { ...p.metadata, ...(input.metadata ?? {}) } }
      this.productsById.set(id, next)
      return next
    },
    list: async () => ({ data: [...this.productsById.values()], nextCursor: null }),
  }

  readonly prices: PriceOps = {
    create: async (input: CreatePriceInput): Promise<PaymentPrice> => {
      const p: PaymentPrice = {
        id: `price_${ulid()}`,
        provider: this.name,
        productId: input.product,
        amount: input.amount,
        currency: input.currency,
        type: input.type ?? 'one_time',
        ...(input.interval !== undefined ? { interval: input.interval } : {}),
        ...(input.intervalCount !== undefined ? { intervalCount: input.intervalCount } : {}),
        active: input.active ?? true,
        metadata: input.metadata ?? {},
        createdAt: new Date(),
        raw: { ...input, mock: true },
      }
      this.pricesById.set(p.id, p)
      return p
    },
    retrieve: async (id: string) => {
      const p = this.pricesById.get(id)
      if (!p) throw new Error(`MockDriver: price "${id}" not found`)
      return p
    },
    list: async () => ({ data: [...this.pricesById.values()], nextCursor: null }),
  }

  readonly subscriptions: SubscriptionOps = {
    create: async (input: CreateSubscriptionInput): Promise<PaymentSubscription> => {
      const now = new Date()
      const trialMs = (input.trialDays ?? 0) * 86_400_000
      const periodStart = trialMs > 0 ? new Date(now.getTime() + trialMs) : now
      const periodEnd = new Date(periodStart.getTime() + 30 * 86_400_000)
      const sub: PaymentSubscription = {
        id: `sub_${ulid()}`,
        provider: this.name,
        customerId: input.customer,
        priceId: input.price,
        status: trialMs > 0 ? 'trialing' : 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAt: null,
        canceledAt: null,
        trialStart: trialMs > 0 ? now : null,
        trialEnd: trialMs > 0 ? periodStart : null,
        metadata: input.metadata ?? {},
        createdAt: now,
        raw: { ...input, mock: true },
      }
      this.subscriptionsById.set(sub.id, sub)
      return sub
    },
    retrieve: async (id: string) => {
      const s = this.subscriptionsById.get(id)
      if (!s) throw new Error(`MockDriver: subscription "${id}" not found`)
      return s
    },
    update: async (id: string, input: UpdateSubscriptionInput) => {
      const s = await this.subscriptions.retrieve(id)
      const next: PaymentSubscription = {
        ...s,
        ...(input.price !== undefined ? { priceId: input.price } : {}),
        metadata: { ...s.metadata, ...(input.metadata ?? {}) },
      }
      this.subscriptionsById.set(id, next)
      return next
    },
    cancel: async (id: string, options: CancelSubscriptionOptions = {}) => {
      const s = await this.subscriptions.retrieve(id)
      const at = options.at ?? 'period_end'
      const next: PaymentSubscription = at === 'now'
        ? { ...s, status: 'canceled', canceledAt: new Date(), cancelAt: new Date() }
        : { ...s, cancelAt: s.currentPeriodEnd }
      this.subscriptionsById.set(id, next)
      return next
    },
    list: async () => ({ data: [...this.subscriptionsById.values()], nextCursor: null }),
  }

  readonly paymentMethods: PaymentMethodOps = {
    attach: async (paymentMethodId: string, customerId: string) => {
      const existing = this.paymentMethodsById.get(paymentMethodId)
      const pm: PaymentMethod = existing
        ? { ...existing, customerId }
        : {
            id: paymentMethodId,
            provider: this.name,
            customerId,
            kind: 'card',
            brand: 'visa',
            last4: '4242',
            metadata: {},
            createdAt: new Date(),
            raw: { mock: true },
          }
      this.paymentMethodsById.set(paymentMethodId, pm)
      return pm
    },
    detach: async (paymentMethodId: string, _customerId?: string) => {
      const pm = this.paymentMethodsById.get(paymentMethodId)
      if (!pm) throw new Error(`MockDriver: payment method "${paymentMethodId}" not found`)
      const next: PaymentMethod = { ...pm, customerId: null }
      this.paymentMethodsById.set(paymentMethodId, next)
      return next
    },
    list: async (customerId: string, _options?: ListPaymentMethodsOptions) => {
      const data = [...this.paymentMethodsById.values()].filter((pm) => pm.customerId === customerId)
      return { data, nextCursor: null }
    },
  }

  readonly charges: ChargeOps = {
    create: async (input: CreateChargeInput): Promise<PaymentCharge> => {
      // Idempotency: if the caller supplied a key and an earlier
      // call wrote a charge stamped with it, return that one.
      // Persists per-driver-instance only — production drivers
      // (Stripe) get real server-side dedup; this is just enough
      // for tests to exercise the contract.
      if (input.idempotencyKey) {
        const prior = [...this.chargesById.values()].find(
          (c) => c.metadata.__idempotencyKey === input.idempotencyKey,
        )
        if (prior) return prior
      }
      const kind = paymentMethodKind(input.paymentMethod)
      const cardToken = extractCardToken(input.paymentMethod)
      const nextAction = mockNextActionFor(input.paymentMethod, input.returnUrl)
      let status: PaymentCharge['status']
      if (kind === 'card' || kind === 'unspecified') {
        status = input.capture === false ? 'requires_action' : 'succeeded'
      } else {
        // Async methods always start in `requires_action` so the
        // caller drives the next step.
        status = 'requires_action'
      }
      const metadataWithKey = input.idempotencyKey
        ? { ...(input.metadata ?? {}), __idempotencyKey: input.idempotencyKey }
        : input.metadata ?? {}
      const charge: PaymentCharge = {
        id: `ch_${ulid()}`,
        provider: this.name,
        customerId: input.customer ?? null,
        amount: input.amount,
        currency: input.currency,
        status,
        paymentMethodId: cardToken,
        failureCode: null,
        failureMessage: null,
        nextAction,
        metadata: metadataWithKey,
        createdAt: new Date(),
        raw: { ...input, mock: true },
      }
      this.chargesById.set(charge.id, charge)
      return charge
    },
    retrieve: async (id: string) => {
      const c = this.chargesById.get(id)
      if (!c) throw new Error(`MockDriver: charge "${id}" not found`)
      return c
    },
    capture: async (id: string) => {
      const c = await this.charges.retrieve(id)
      const next: PaymentCharge = { ...c, status: 'succeeded', nextAction: null }
      this.chargesById.set(id, next)
      return next
    },
    refund: async (input: CreateRefundInput): Promise<PaymentRefund> => {
      const charge = await this.charges.retrieve(input.charge)
      const refundAmount = input.amount ?? charge.amount
      const isFull = refundAmount >= charge.amount
      const next: PaymentCharge = {
        ...charge,
        status: isFull ? 'refunded' : 'partial_refunded',
      }
      this.chargesById.set(charge.id, next)
      return {
        id: `re_${ulid()}`,
        provider: this.name,
        chargeId: charge.id,
        amount: refundAmount,
        currency: charge.currency,
        status: 'succeeded',
        reason: input.reason ?? null,
        createdAt: new Date(),
        raw: { mock: true },
      }
    },
  }

  readonly invoices: InvoiceOps = {
    retrieve: async (id: string) => {
      const inv = this.invoicesById.get(id)
      if (!inv) throw new Error(`MockDriver: invoice "${id}" not found`)
      return inv
    },
    list: async (_options?: ListInvoicesOptions) => ({
      data: [...this.invoicesById.values()],
      nextCursor: null,
    }),
    finalize: async (id: string) => {
      const inv = await this.invoices.retrieve(id)
      const next: PaymentInvoice = { ...inv, status: 'open' }
      this.invoicesById.set(id, next)
      return next
    },
    void: async (id: string) => {
      const inv = await this.invoices.retrieve(id)
      const next: PaymentInvoice = { ...inv, status: 'void' }
      this.invoicesById.set(id, next)
      return next
    },
  }

  readonly checkout: CheckoutOps = {
    create: async (input: CreateCheckoutInput): Promise<PaymentCheckoutSession> => {
      const session: PaymentCheckoutSession = {
        id: `cs_${ulid()}`,
        provider: this.name,
        mode: input.mode,
        status: 'open',
        url: `https://mock.checkout/${ulid()}`,
        customerId: input.customer ?? null,
        paymentIntentId: null,
        subscriptionId: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        metadata: input.metadata ?? {},
        createdAt: new Date(),
        raw: { ...input, mock: true },
      }
      this.checkoutsById.set(session.id, session)
      return session
    },
    retrieve: async (id: string) => {
      const s = this.checkoutsById.get(id)
      if (!s) throw new Error(`MockDriver: checkout "${id}" not found`)
      return s
    },
  }

  readonly links: LinkOps = {
    create: async (input: CreatePaymentLinkInput): Promise<PaymentLink> => {
      const link: PaymentLink = {
        id: `plink_${ulid()}`,
        provider: this.name,
        url: `https://mock.payment/link/${ulid()}`,
        amount: input.amount ?? null,
        currency: input.currency ? input.currency.toLowerCase() : null,
        active: true,
        reusable: input.reusable ?? true,
        ...(input.title ? { title: input.title } : {}),
        ...(input.description ? { description: input.description } : {}),
        metadata: input.metadata ?? {},
        createdAt: new Date(),
        raw: { ...input, mock: true },
      }
      this.linksById.set(link.id, link)
      return link
    },
    retrieve: async (id: string): Promise<PaymentLink> => {
      const link = this.linksById.get(id)
      if (!link) throw new Error(`MockDriver: payment link "${id}" not found`)
      return link
    },
    list: async (_options?: ListPaymentLinksOptions) => ({
      data: [...this.linksById.values()],
      nextCursor: null,
    }),
    deactivate: async (id: string): Promise<PaymentLink> => {
      const link = await this.links.retrieve(id)
      const next: PaymentLink = { ...link, active: false }
      this.linksById.set(id, next)
      return next
    },
  }

  readonly webhook: WebhookOps = {
    verify: async (rawBody: string, signature: string): Promise<unknown> => {
      if (signature !== this.webhookSecret) {
        throw new WebhookSignatureError(
          `MockDriver.webhook.verify: signature mismatch.`,
        )
      }
      try {
        return JSON.parse(rawBody)
      } catch (cause) {
        throw new WebhookSignatureError(
          `MockDriver.webhook.verify: body is not valid JSON.`,
          { cause },
        )
      }
    },
    normalize: (event: unknown): NormalizedWebhookEvent | null => {
      return mockNormalize(event, this.name)
    },
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function mockNextActionFor(
  pm: string | PaymentMethodSpec | undefined,
  returnUrl: string | undefined,
): PaymentNextAction | null {
  if (pm === undefined || typeof pm === 'string' || pm.kind === 'card') {
    return null
  }
  const url = returnUrl ?? 'https://mock.payment/return'
  switch (pm.kind) {
    case 'promptpay':
    case 'paynow':
    case 'fps':
      return {
        kind: 'display_qr',
        qrData: `mock-qr:${pm.kind}:${ulid()}`,
        qrImageUrl: `https://mock.payment/qr/${ulid()}.png`,
      }
    case 'konbini':
      return { kind: 'voucher', reference: `KON-${ulid().slice(-8)}` }
    case 'truemoney':
    case 'alipay':
    case 'wechat_pay':
    case 'grabpay':
    case 'kakaopay':
    case 'rabbit_linepay':
      return { kind: 'redirect', url }
    default:
      return { kind: 'wait' }
  }
}

function mockNormalize(event: unknown, provider: string): NormalizedWebhookEvent | null {
  if (!event || typeof event !== 'object') return null
  const obj = event as { id?: unknown; type?: unknown; data?: unknown; _fields?: unknown }
  if (typeof obj.id !== 'string' || typeof obj.type !== 'string') return null
  const normalized: NormalizedWebhookEvent = {
    id: obj.id,
    type: obj.type as NormalizedWebhookEvent['type'],
    provider,
    raw: event,
    data: (obj.data as NormalizedWebhookEvent['data']) ?? {},
  }
  if (obj._fields && typeof obj._fields === 'object') {
    ;(normalized as { _fields?: unknown })._fields = obj._fields
  }
  return normalized
}
