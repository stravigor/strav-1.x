/**
 * `StripePaymentDriver` — the `PaymentDriver` for Stripe.
 *
 * Holds one configured `Stripe` SDK instance; resource ops
 * delegate into it and map every result through the
 * normalized-DTO mappers. The Stripe SDK is concurrent-safe +
 * HTTP/2-backed, so one shared instance per process is the
 * right shape. Tests inject a stub via `config.client`.
 *
 * Capability set: full for v1 — Stripe covers every method the
 * framework declares. `ProviderUnsupportedError` is reserved
 * for drivers that genuinely can't fulfil a method (Omise's
 * `subscriptions.changePlan`, etc.).
 *
 * Error mapping: Stripe SDK errors propagate verbatim through
 * `.cause`. Apps that want vendor-specific recovery
 * (`StripeRateLimitError`, declined cards) `instanceof`-check
 * `error.cause`.
 */

// biome-ignore lint/style/useImportType: Stripe is a value import — `new Stripe(...)`.
import Stripe from 'stripe'
import { extractCardToken, paymentMethodKind } from '../payment_method_helpers.ts'
import { ProviderUnsupportedError, WebhookSignatureError } from '../../payment_error.ts'
import type { PaymentCapability } from '../../payment_capabilities.ts'
import {
  buildStripeMethodWiring,
  STRIPE_SUPPORTED_METHOD_KINDS,
} from './mappers/stripe_method_spec.ts'
import { stripeNextAction } from './mappers/stripe_next_action_mapper.ts'
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
} from '../../payment_driver.ts'
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
  ListCustomersOptions,
  ListInvoicesOptions,
  ListPaymentLinksOptions,
  ListPaymentMethodsOptions,
  ListPricesOptions,
  ListProductsOptions,
  ListSubscriptionsOptions,
  NormalizedWebhookEvent,
  PaginatedCustomers,
  PaginatedInvoices,
  PaginatedPaymentLinks,
  PaginatedPaymentMethods,
  PaginatedPrices,
  PaginatedProducts,
  PaginatedSubscriptions,
  PaymentCharge,
  PaymentCheckoutSession,
  PaymentCustomer,
  PaymentInvoice,
  PaymentLink,
  PaymentMethod,
  PaymentPrice,
  PaymentProduct,
  PaymentRefund,
  PaymentSubscription,
  UpdateCustomerInput,
  UpdateSubscriptionInput,
} from '../../dto/index.ts'
import {
  toPaymentCharge,
  toPaymentCheckoutSession,
  toPaymentCustomer,
  toPaymentInvoice,
  toPaymentLink,
  toPaymentMethod,
  toPaymentPrice,
  toPaymentProduct,
  toPaymentSubscription,
} from './mappers/stripe_mappers.ts'
import type { StripeProviderConfig } from './stripe_config.ts'
import { stripeNormalize } from './webhook/stripe_normalize.ts'

const PROVIDER = 'stripe'

const ALL_CAPS: readonly PaymentCapability[] = [
  'customers.create', 'customers.update', 'customers.retrieve', 'customers.list', 'customers.delete',
  'products.create', 'products.update', 'products.list',
  'prices.create', 'prices.list',
  'subscriptions.create', 'subscriptions.retrieve', 'subscriptions.update',
  'subscriptions.cancel', 'subscriptions.changePlan', 'subscriptions.trials',
  'paymentMethods.attach', 'paymentMethods.detach', 'paymentMethods.list',
  'charges.create', 'charges.refund', 'charges.capture',
  // Async payment methods Stripe supports — wired in slice 7.2 via
  // PaymentIntent `payment_method_data.type`. The kinds we DON'T
  // declare (`truemoney`, `fps`, `rabbit_linepay`) are Omise/
  // regional specialties Stripe doesn't offer; calls throw
  // `ProviderUnsupportedError`.
  ...STRIPE_SUPPORTED_METHOD_KINDS.map(
    (k) => `charges.method.${k}` as PaymentCapability,
  ),
  // Next-action shapes the driver can emit, sourced from Stripe's
  // PaymentIntent.NextAction discriminator.
  'charges.nextAction.display_qr',
  'charges.nextAction.redirect',
  'charges.nextAction.authorize',
  'charges.nextAction.voucher',
  'charges.nextAction.wait',
  'invoices.list', 'invoices.retrieve', 'invoices.finalize', 'invoices.void',
  'checkout.create', 'checkout.retrieve',
  'links.create', 'links.deactivate',
  // Stripe natively supports the Idempotency-Key header on every
  // POST endpoint we use. Apps pass `idempotencyKey` on any
  // create-style input; the driver forwards via the SDK's
  // RequestOptions slot.
  'idempotency',
  'webhook.verify', 'webhook.normalize',
]

/** Build a Stripe SDK RequestOptions object when an idempotency key is set. */
function idem(key: string | undefined): Stripe.RequestOptions | undefined {
  return key ? { idempotencyKey: key } : undefined
}

export interface StripeDriverOptions {
  instanceName: string
  config: StripeProviderConfig
}

export class StripePaymentDriver implements PaymentDriver {
  readonly name = PROVIDER
  readonly instanceName: string
  readonly capabilities: ReadonlySet<PaymentCapability> = new Set(ALL_CAPS)

  /** The raw `Stripe` SDK instance — apps reach this for behaviour the framework doesn't wrap. */
  readonly client: Stripe
  private readonly config: StripeProviderConfig

  constructor(options: StripeDriverOptions) {
    this.instanceName = options.instanceName
    this.config = options.config
    this.client =
      (options.config.client as Stripe | undefined) ??
      new Stripe(options.config.secret, {
        ...(options.config.apiVersion !== undefined
          ? { apiVersion: options.config.apiVersion as Stripe.LatestApiVersion }
          : {}),
      })
  }

  readonly customers: CustomerOps = {
    create: async (input: CreateCustomerInput): Promise<PaymentCustomer> => {
      const c = await this.client.customers.create(
        {
          email: input.email,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        idem(input.idempotencyKey),
      )
      return toPaymentCustomer(c)
    },
    retrieve: async (id: string): Promise<PaymentCustomer> => {
      const c = await this.client.customers.retrieve(id)
      if ((c as Stripe.DeletedCustomer).deleted) {
        throw new Error(`Stripe customer "${id}" is deleted.`)
      }
      return toPaymentCustomer(c as Stripe.Customer)
    },
    update: async (id: string, input: UpdateCustomerInput): Promise<PaymentCustomer> => {
      const c = await this.client.customers.update(id, {
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      return toPaymentCustomer(c)
    },
    list: async (options: ListCustomersOptions = {}): Promise<PaginatedCustomers> => {
      const page = await this.client.customers.list({
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor ? { starting_after: options.cursor } : {}),
        ...(options.email ? { email: options.email } : {}),
      })
      return {
        data: page.data.map(toPaymentCustomer),
        nextCursor: page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null,
      }
    },
    delete: async (id: string): Promise<void> => {
      await this.client.customers.del(id)
    },
  }

  readonly products: ProductOps = {
    create: async (input: CreateProductInput): Promise<PaymentProduct> => {
      const p = await this.client.products.create({
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      return toPaymentProduct(p)
    },
    retrieve: async (id: string): Promise<PaymentProduct> => {
      return toPaymentProduct(await this.client.products.retrieve(id))
    },
    update: async (
      id: string,
      input: Partial<CreateProductInput>,
    ): Promise<PaymentProduct> => {
      const p = await this.client.products.update(id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      return toPaymentProduct(p)
    },
    list: async (options: ListProductsOptions = {}): Promise<PaginatedProducts> => {
      const page = await this.client.products.list({
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor ? { starting_after: options.cursor } : {}),
        ...(options.active !== undefined ? { active: options.active } : {}),
      })
      return {
        data: page.data.map(toPaymentProduct),
        nextCursor: page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null,
      }
    },
  }

  readonly prices: PriceOps = {
    create: async (input: CreatePriceInput): Promise<PaymentPrice> => {
      const params: Stripe.PriceCreateParams = {
        product: input.product,
        unit_amount: input.amount,
        currency: input.currency,
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }
      if ((input.type ?? 'one_time') === 'recurring') {
        params.recurring = {
          interval: (input.interval ?? 'month') as Stripe.PriceCreateParams.Recurring.Interval,
          ...(input.intervalCount ? { interval_count: input.intervalCount } : {}),
        }
      }
      return toPaymentPrice(await this.client.prices.create(params))
    },
    retrieve: async (id: string): Promise<PaymentPrice> => {
      return toPaymentPrice(await this.client.prices.retrieve(id))
    },
    list: async (options: ListPricesOptions = {}): Promise<PaginatedPrices> => {
      const page = await this.client.prices.list({
        ...(options.product ? { product: options.product } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor ? { starting_after: options.cursor } : {}),
        ...(options.active !== undefined ? { active: options.active } : {}),
      })
      return {
        data: page.data.map(toPaymentPrice),
        nextCursor: page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null,
      }
    },
  }

  readonly subscriptions: SubscriptionOps = {
    create: async (input: CreateSubscriptionInput): Promise<PaymentSubscription> => {
      const s = await this.client.subscriptions.create(
        {
          customer: input.customer,
          items: [{ price: input.price }],
          ...(input.trialDays ? { trial_period_days: input.trialDays } : {}),
          ...(input.paymentMethod ? { default_payment_method: input.paymentMethod } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        idem(input.idempotencyKey),
      )
      return toPaymentSubscription(s)
    },
    retrieve: async (id: string): Promise<PaymentSubscription> => {
      return toPaymentSubscription(await this.client.subscriptions.retrieve(id))
    },
    update: async (
      id: string,
      input: UpdateSubscriptionInput,
    ): Promise<PaymentSubscription> => {
      const current = await this.client.subscriptions.retrieve(id)
      const params: Stripe.SubscriptionUpdateParams = {
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.paymentMethod ? { default_payment_method: input.paymentMethod } : {}),
      }
      if (input.price) {
        const itemId = current.items.data[0]?.id
        if (!itemId) {
          throw new Error(`Stripe subscription "${id}" has no items; can't change price.`)
        }
        params.items = [{ id: itemId, price: input.price }]
      }
      const s = await this.client.subscriptions.update(id, params)
      return toPaymentSubscription(s)
    },
    cancel: async (
      id: string,
      options: CancelSubscriptionOptions = {},
    ): Promise<PaymentSubscription> => {
      const at = options.at ?? 'period_end'
      if (at === 'now') {
        return toPaymentSubscription(await this.client.subscriptions.cancel(id))
      }
      return toPaymentSubscription(
        await this.client.subscriptions.update(id, { cancel_at_period_end: true }),
      )
    },
    list: async (
      options: ListSubscriptionsOptions = {},
    ): Promise<PaginatedSubscriptions> => {
      const page = await this.client.subscriptions.list({
        ...(options.customer ? { customer: options.customer } : {}),
        ...(options.status
          ? { status: options.status as Stripe.SubscriptionListParams.Status }
          : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor ? { starting_after: options.cursor } : {}),
      })
      return {
        data: page.data.map(toPaymentSubscription),
        nextCursor: page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null,
      }
    },
  }

  readonly paymentMethods: PaymentMethodOps = {
    attach: async (paymentMethodId: string, customerId: string): Promise<PaymentMethod> => {
      const pm = await this.client.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      })
      return toPaymentMethod(pm)
    },
    detach: async (paymentMethodId: string, _customerId?: string): Promise<PaymentMethod> => {
      // Stripe resolves the owning customer from the payment-method id;
      // `customerId` is part of the framework contract for Omise's benefit.
      const pm = await this.client.paymentMethods.detach(paymentMethodId)
      return toPaymentMethod(pm)
    },
    list: async (
      customerId: string,
      options: ListPaymentMethodsOptions = {},
    ): Promise<PaginatedPaymentMethods> => {
      const page = await this.client.paymentMethods.list({
        customer: customerId,
        ...(options.kind === 'card' ? { type: 'card' } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor ? { starting_after: options.cursor } : {}),
      })
      return {
        data: page.data.map(toPaymentMethod),
        nextCursor: page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null,
      }
    },
  }

  readonly charges: ChargeOps = {
    create: async (input: CreateChargeInput): Promise<PaymentCharge> => {
      // Stripe steers new integrations to PaymentIntents; the
      // legacy `charges.create` flow doesn't support most payment
      // methods. We use PaymentIntent + auto-confirm and return
      // either the settled charge (cards, instant) or a synthetic
      // pending charge with `nextAction` populated.
      const kind = paymentMethodKind(input.paymentMethod)
      const cardToken = extractCardToken(input.paymentMethod)

      // Build per-kind PaymentIntent params.
      let methodParams: Partial<Stripe.PaymentIntentCreateParams> = {}
      if (input.paymentMethod && typeof input.paymentMethod !== 'string' && input.paymentMethod.kind !== 'card') {
        const result = buildStripeMethodWiring(input.paymentMethod)
        if (result.kind !== 'wired') {
          throw new ProviderUnsupportedError(
            PROVIDER,
            `charges.method.${kind}`,
            {
              reason: `Stripe does not support payment-method kind "${kind}". Use a provider with the matching capability (e.g. Omise for truemoney / fps / rabbit_linepay), or call \`driver.client.*\` for vendor-specific flows.`,
            },
          )
        }
        methodParams = {
          payment_method_data: result.wiring.payment_method_data,
          ...(result.wiring.payment_method_options
            ? { payment_method_options: result.wiring.payment_method_options }
            : {}),
        }
      } else if (cardToken) {
        methodParams = { payment_method: cardToken }
      }

      // Redirect / authorize next-actions require a return_url.
      // We pass it whenever the caller supplied one; Stripe
      // ignores it for QR / voucher / sync card flows.
      const needsReturnUrl =
        input.paymentMethod !== undefined &&
        typeof input.paymentMethod !== 'string' &&
        input.paymentMethod.kind !== 'card'
      if (needsReturnUrl && !input.returnUrl) {
        throw new ProviderUnsupportedError(
          PROVIDER,
          `charges.method.${kind}`,
          {
            reason: `Stripe requires a \`returnUrl\` for async payment methods (where it sends the customer back after redirect / authorise). Set \`config.payment.returnUrl\` or pass \`returnUrl\` on the call.`,
          },
        )
      }

      const intent = await this.client.paymentIntents.create(
        {
          amount: input.amount,
          currency: input.currency,
          ...(input.customer ? { customer: input.customer } : {}),
          ...methodParams,
          ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          confirm: input.capture !== false,
          capture_method: input.capture === false ? 'manual' : 'automatic',
        },
        idem(input.idempotencyKey),
      )

      // Settled in-line — return the canonical charge DTO.
      const chargeId =
        typeof intent.latest_charge === 'string'
          ? intent.latest_charge
          : intent.latest_charge?.id
      if (chargeId && intent.status === 'succeeded') {
        return toPaymentCharge(await this.client.charges.retrieve(chargeId))
      }

      // Pending (requires_action / processing / requires_confirmation)
      // — build a synthetic charge from the intent + map next_action.
      const status: PaymentCharge['status'] =
        intent.status === 'requires_action' || intent.status === 'requires_confirmation'
          ? 'requires_action'
          : 'pending'
      return {
        id: intent.id,
        provider: PROVIDER,
        customerId:
          typeof intent.customer === 'string'
            ? intent.customer
            : intent.customer
              ? (intent.customer as { id: string }).id
              : null,
        amount: intent.amount,
        currency: intent.currency,
        status,
        paymentMethodId:
          typeof intent.payment_method === 'string'
            ? intent.payment_method
            : intent.payment_method
              ? (intent.payment_method as { id: string }).id
              : null,
        failureCode: null,
        failureMessage: null,
        nextAction: stripeNextAction(intent.next_action),
        metadata: Object.fromEntries(
          Object.entries(intent.metadata ?? {}).filter(([, v]) => v !== null) as [string, string][],
        ),
        createdAt: new Date(intent.created * 1000),
        raw: intent,
      }
    },
    retrieve: async (id: string): Promise<PaymentCharge> => {
      return toPaymentCharge(await this.client.charges.retrieve(id))
    },
    capture: async (
      id: string,
      options: { amount?: number } = {},
    ): Promise<PaymentCharge> => {
      const charge = await this.client.charges.capture(id, {
        ...(options.amount !== undefined ? { amount: options.amount } : {}),
      })
      return toPaymentCharge(charge)
    },
    refund: async (input: CreateRefundInput): Promise<PaymentRefund> => {
      const r = await this.client.refunds.create(
        {
          charge: input.charge,
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.reason ? { reason: input.reason as Stripe.RefundCreateParams.Reason } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        idem(input.idempotencyKey),
      )
      return {
        id: r.id,
        provider: PROVIDER,
        chargeId: typeof r.charge === 'string' ? r.charge : (r.charge as { id: string } | null)?.id ?? input.charge,
        amount: r.amount,
        currency: r.currency,
        status: (r.status as 'succeeded' | 'pending' | 'failed' | null) ?? 'pending',
        reason: r.reason,
        createdAt: new Date(r.created * 1000),
        raw: r,
      }
    },
  }

  readonly invoices: InvoiceOps = {
    retrieve: async (id: string): Promise<PaymentInvoice> => {
      return toPaymentInvoice(await this.client.invoices.retrieve(id))
    },
    list: async (options: ListInvoicesOptions = {}): Promise<PaginatedInvoices> => {
      const page = await this.client.invoices.list({
        ...(options.customer ? { customer: options.customer } : {}),
        ...(options.subscription ? { subscription: options.subscription } : {}),
        ...(options.status ? { status: options.status as Stripe.InvoiceListParams.Status } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor ? { starting_after: options.cursor } : {}),
      })
      return {
        data: page.data.map(toPaymentInvoice),
        nextCursor: page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null,
      }
    },
    finalize: async (id: string): Promise<PaymentInvoice> => {
      return toPaymentInvoice(await this.client.invoices.finalizeInvoice(id))
    },
    void: async (id: string): Promise<PaymentInvoice> => {
      return toPaymentInvoice(await this.client.invoices.voidInvoice(id))
    },
  }

  readonly checkout: CheckoutOps = {
    create: async (input: CreateCheckoutInput): Promise<PaymentCheckoutSession> => {
      const params: Stripe.Checkout.SessionCreateParams = {
        mode: input.mode,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        line_items: input.items.map((i) => ({
          price: i.price,
          quantity: i.quantity ?? 1,
        })),
        ...(input.customer ? { customer: input.customer } : {}),
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }
      if (input.mode === 'subscription' && input.trialDays) {
        params.subscription_data = { trial_period_days: input.trialDays }
      }
      return toPaymentCheckoutSession(
        await this.client.checkout.sessions.create(params, idem(input.idempotencyKey)),
      )
    },
    retrieve: async (id: string): Promise<PaymentCheckoutSession> => {
      return toPaymentCheckoutSession(await this.client.checkout.sessions.retrieve(id))
    },
  }

  readonly links: LinkOps = {
    create: async (input: CreatePaymentLinkInput): Promise<PaymentLink> => {
      // Stripe Payment Links require `line_items` with Price ids
      // — ad-hoc amount+currency aren't supported. Apps that want
      // a one-off link create a Price first, then pass it here.
      if (!input.items || input.items.length === 0) {
        throw new ProviderUnsupportedError(
          PROVIDER,
          'links.create',
          {
            reason: 'Stripe Payment Links require `items` (catalogue Price ids); ad-hoc `amount`/`currency` is not supported. Call `payment.prices.create({...})` first, then pass the resulting price id via `items: [{ price: "price_xxx" }]`.',
          },
        )
      }
      const params: Stripe.PaymentLinkCreateParams = {
        line_items: input.items.map((i) => ({
          price: i.price,
          quantity: i.quantity ?? 1,
        })),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }
      if (input.afterCompletionRedirect) {
        params.after_completion = {
          type: 'redirect',
          redirect: { url: input.afterCompletionRedirect },
        }
      }
      return toPaymentLink(
        await this.client.paymentLinks.create(params, idem(input.idempotencyKey)),
      )
    },
    retrieve: async (id: string): Promise<PaymentLink> => {
      return toPaymentLink(await this.client.paymentLinks.retrieve(id))
    },
    list: async (
      options: ListPaymentLinksOptions = {},
    ): Promise<PaginatedPaymentLinks> => {
      const page = await this.client.paymentLinks.list({
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor ? { starting_after: options.cursor } : {}),
        ...(options.active !== undefined ? { active: options.active } : {}),
      })
      return {
        data: page.data.map(toPaymentLink),
        nextCursor: page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null,
      }
    },
    deactivate: async (id: string): Promise<PaymentLink> => {
      // Stripe doesn't have a dedicated "delete" — flipping
      // `active: false` stops the link from accepting new
      // payments. In-flight checkout sessions still settle.
      return toPaymentLink(await this.client.paymentLinks.update(id, { active: false }))
    },
  }

  readonly webhook: WebhookOps = {
    verify: async (rawBody: string, signature: string): Promise<unknown> => {
      if (!this.config.webhookSecret) {
        throw new WebhookSignatureError(
          'StripePaymentDriver.webhook.verify: `webhookSecret` is not set on the provider config.',
        )
      }
      try {
        return await this.client.webhooks.constructEventAsync(
          rawBody,
          signature,
          this.config.webhookSecret,
        )
      } catch (cause) {
        throw new WebhookSignatureError(
          `StripePaymentDriver.webhook.verify: signature verification failed.`,
          { cause },
        )
      }
    },
    normalize: (event: unknown): NormalizedWebhookEvent | null => {
      return stripeNormalize(event as Stripe.Event)
    },
  }
}
