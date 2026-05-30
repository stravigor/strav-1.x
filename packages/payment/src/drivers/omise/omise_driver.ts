/**
 * `OmisePaymentDriver` — `PaymentDriver` for Omise (Opn Payments).
 *
 * Capability scope is intentionally narrower than Stripe:
 *
 *   - **customers**       full CRUD.
 *   - **charges**         create / retrieve / capture / refund.
 *                         No `update` (Omise charges are immutable
 *                         beyond capture + refund).
 *   - **paymentMethods**  list + detach (via cards on a customer).
 *                         attach uses card tokens; apps create
 *                         tokens client-side via Omise.js and
 *                         pass the token id here.
 *   - **subscriptions**   create / retrieve / cancel / list (via
 *                         customer). Backed by Omise's schedules
 *                         API. `update` throws — Omise schedules
 *                         are immutable. The framework `price`
 *                         field carries an `omise_spec:…` blob
 *                         built by `omisePriceSpec({...})`;
 *                         Omise has no separate price catalogue,
 *                         so the spec encodes amount + currency +
 *                         period inline.
 *
 *   - **products / prices / invoices / checkout** throw
 *     `ProviderUnsupportedError`. Omise has sources + payment
 *     links but they don't map cleanly onto the framework's
 *     Stripe-flavored union in v1.
 *
 * Apps that need product/price catalogs alongside Omise charges
 * use a separate Stripe provider entry just for the catalog and
 * route by `payment.use(name)`.
 *
 * Webhook signature: HMAC SHA-256 over the raw body, `X-Omise-
 * Signature` header. Implementation in `omise_webhook.ts`.
 */

// biome-ignore lint/style/useImportType: Omise is a CJS value import.
import Omise from 'omise'
import type { PaymentCapability } from '../../payment_capabilities.ts'
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
import { extractCardToken, paymentMethodKind } from '../payment_method_helpers.ts'
import { ProviderUnsupportedError } from '../../payment_error.ts'
import type {
  CancelSubscriptionOptions,
  CreateChargeInput,
  CreateCustomerInput,
  CreatePaymentLinkInput,
  CreateRefundInput,
  CreateSubscriptionInput,
  ListCustomersOptions,
  ListPaymentLinksOptions,
  ListPaymentMethodsOptions,
  ListSubscriptionsOptions,
  NormalizedWebhookEvent,
  PaginatedCustomers,
  PaginatedPaymentLinks,
  PaginatedPaymentMethods,
  PaginatedSubscriptions,
  PaymentCharge,
  PaymentCustomer,
  PaymentLink,
  PaymentMethod,
  PaymentRefund,
  PaymentSubscription,
  UpdateCustomerInput,
} from '../../dto/index.ts'
import {
  toPaymentCharge,
  toPaymentCustomer,
  toPaymentLink,
  toPaymentMethod,
  type OmiseCard,
  type OmiseCharge,
  type OmiseCustomer,
  type OmiseLink,
  type OmiseSource,
} from './omise_mappers.ts'
import {
  buildOmiseMethodSpec,
  OMISE_SUPPORTED_METHOD_KINDS,
} from './omise_method_spec.ts'
import type { OmiseProviderConfig } from './omise_config.ts'
import { parseOmisePriceSpec } from './omise_price_spec.ts'
import {
  toPaymentSubscription as toPaymentSubscriptionFromSchedule,
  type OmiseSchedule,
} from './omise_schedule_mapper.ts'
import { omiseNormalize, omiseVerify, type OmiseEvent } from './omise_webhook.ts'

const PROVIDER = 'omise'

const CAPS: readonly PaymentCapability[] = [
  'customers.create', 'customers.update', 'customers.retrieve', 'customers.list', 'customers.delete',
  'paymentMethods.attach', 'paymentMethods.detach', 'paymentMethods.list',
  'charges.create', 'charges.refund', 'charges.capture',
  // Async payment methods backed by Omise Sources. PromptPay is
  // the only QR-based one in this list; the rest are redirect
  // flows. Stripe-only kinds (`paynow`, `kakaopay`, `konbini`,
  // `fps`) throw — Omise's regional fit is TH / SEA wallets.
  ...OMISE_SUPPORTED_METHOD_KINDS.map(
    (k) => `charges.method.${k}` as PaymentCapability,
  ),
  'charges.nextAction.display_qr',
  'charges.nextAction.redirect',
  'charges.nextAction.wait',
  // Omise schedules: subscriptions.create / retrieve / cancel / list-by-customer.
  // `update` and `changePlan` aren't supported — Omise schedules are immutable.
  // `trials` aren't supported — schedules have no trial concept.
  'subscriptions.create', 'subscriptions.retrieve', 'subscriptions.cancel',
  // Payment Links — Omise supports create / retrieve / list. No
  // deactivate endpoint, so `links.deactivate` throws.
  'links.create',
  'webhook.verify', 'webhook.normalize',
]

export interface OmiseDriverOptions {
  instanceName: string
  config: OmiseProviderConfig
}

interface OmiseClient {
  customers: {
    create(req: Record<string, unknown>): Promise<OmiseCustomer>
    retrieve(id: string): Promise<OmiseCustomer>
    update(id: string, req: Record<string, unknown>): Promise<OmiseCustomer>
    destroy(id: string): Promise<{ deleted: boolean }>
    list(params?: { limit?: number; offset?: number }): Promise<{ data: OmiseCustomer[]; total: number }>
    listCards(
      customerID: string,
      params?: { limit?: number; offset?: number },
    ): Promise<{ data: OmiseCard[] }>
    destroyCard(customerID: string, cardID: string): Promise<OmiseCard>
    schedules(
      customerID: string,
      params?: { limit?: number; offset?: number },
    ): Promise<{ data: OmiseSchedule[] }>
  }
  charges: {
    create(req: Record<string, unknown>): Promise<OmiseCharge>
    retrieve(id: string): Promise<OmiseCharge>
    capture(id: string): Promise<OmiseCharge>
    createRefund(id: string, req: Record<string, unknown>): Promise<{
      id: string
      amount: number
      currency: string
      charge: string
      created?: string
      created_at?: string
      voided?: boolean
    }>
  }
  schedules: {
    create(req: Record<string, unknown>): Promise<OmiseSchedule>
    retrieve(id: string): Promise<OmiseSchedule>
    destroy(id: string): Promise<{ deleted: boolean } | OmiseSchedule>
  }
  sources: {
    create(req: Record<string, unknown>): Promise<OmiseSource>
    retrieve(id: string): Promise<OmiseSource>
  }
  links: {
    create(req: Record<string, unknown>): Promise<OmiseLink>
    retrieve(id: string): Promise<OmiseLink>
    list(params?: { limit?: number; offset?: number }): Promise<{ data: OmiseLink[] }>
  }
}

function uns(op: string, reason: string): (...args: unknown[]) => never {
  return () => {
    throw new ProviderUnsupportedError(PROVIDER, op, { reason })
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function oneYearFromIso(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number]
  // Roll forward one year. JS handles month/day correctly; leap-year
  // Feb 29 wraps to Feb 28, which is fine for a schedule end-date.
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10)
}

export class OmisePaymentDriver implements PaymentDriver {
  readonly name = PROVIDER
  readonly instanceName: string
  readonly capabilities: ReadonlySet<PaymentCapability> = new Set(CAPS)

  readonly client: OmiseClient
  private readonly config: OmiseProviderConfig

  constructor(options: OmiseDriverOptions) {
    this.instanceName = options.instanceName
    this.config = options.config
    this.client =
      (options.config.client as OmiseClient | undefined) ??
      (Omise({
        publicKey: options.config.publicKey,
        secretKey: options.config.secretKey,
        ...(options.config.omiseVersion ? { omiseVersion: options.config.omiseVersion } : {}),
      }) as unknown as OmiseClient)
  }

  readonly customers: CustomerOps = {
    create: async (input: CreateCustomerInput): Promise<PaymentCustomer> => {
      const c = await this.client.customers.create({
        email: input.email,
        ...(input.name !== undefined ? { description: input.name } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      return toPaymentCustomer(c)
    },
    retrieve: async (id: string): Promise<PaymentCustomer> => {
      return toPaymentCustomer(await this.client.customers.retrieve(id))
    },
    update: async (id: string, input: UpdateCustomerInput): Promise<PaymentCustomer> => {
      const c = await this.client.customers.update(id, {
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.name !== undefined ? { description: input.name } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      return toPaymentCustomer(c)
    },
    list: async (options: ListCustomersOptions = {}): Promise<PaginatedCustomers> => {
      const page = await this.client.customers.list({
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      })
      // Omise pagination is offset-based — apps that need next-page
      // fetch carry an offset in their own state; we don't surface
      // a cursor for v1.
      const filtered = options.email
        ? page.data.filter((c: OmiseCustomer) => c.email === options.email)
        : page.data
      return {
        data: filtered.map(toPaymentCustomer),
        nextCursor: null,
      }
    },
    delete: async (id: string): Promise<void> => {
      await this.client.customers.destroy(id)
    },
  }

  // ─── Catalog-style ops: not supported by Omise's flat-charge model ────

  readonly products: ProductOps = {
    create: uns('products.create', 'Omise has no Products catalog; pass amount + currency directly to charges.create.'),
    retrieve: uns('products.retrieve', 'Omise has no Products catalog.'),
    update: uns('products.update', 'Omise has no Products catalog.'),
    list: uns('products.list', 'Omise has no Products catalog.'),
  }

  readonly prices: PriceOps = {
    create: uns('prices.create', 'Omise has no Prices catalog; pass amount + currency directly to charges.create.'),
    retrieve: uns('prices.retrieve', 'Omise has no Prices catalog.'),
    list: uns('prices.list', 'Omise has no Prices catalog.'),
  }

  readonly subscriptions: SubscriptionOps = {
    create: async (input: CreateSubscriptionInput): Promise<PaymentSubscription> => {
      if (input.trialDays !== undefined) {
        throw new ProviderUnsupportedError(
          PROVIDER,
          'subscriptions.trials',
          { reason: 'Omise schedules have no trial concept. Drop `trialDays` or use a one-off charge before the schedule starts.' },
        )
      }
      const spec = parseOmisePriceSpec(input.price)
      if (!spec) {
        throw new ProviderUnsupportedError(
          PROVIDER,
          'subscriptions.create',
          { reason: 'Omise has no `price` catalog. Build the price inline with `omisePriceSpec({ amount, currency, period, every? })` and pass the result as `price`.' },
        )
      }
      const startDate = todayIso()
      const endDate = oneYearFromIso(startDate)
      const charge: Record<string, unknown> = {
        customer: input.customer,
        amount: spec.amount,
        currency: spec.currency,
        ...(spec.description ? { description: spec.description } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }
      const cardId = input.paymentMethod ?? spec.card
      if (cardId) charge.card = cardId
      const schedule = await this.client.schedules.create({
        every: spec.every ?? 1,
        period: spec.period,
        start_date: startDate,
        end_date: endDate,
        charge,
      })
      return toPaymentSubscriptionFromSchedule(schedule)
    },
    retrieve: async (id: string): Promise<PaymentSubscription> => {
      return toPaymentSubscriptionFromSchedule(await this.client.schedules.retrieve(id))
    },
    update: uns(
      'subscriptions.update',
      'Omise schedules are immutable. Cancel the current schedule and create a new one with the updated terms.',
    ),
    cancel: async (
      id: string,
      _options: CancelSubscriptionOptions = {},
    ): Promise<PaymentSubscription> => {
      // Omise has no "cancel at period end" — destroy stops the
      // schedule immediately. The `_options.at` argument is
      // accepted for API uniformity but cannot change Omise's
      // behaviour.
      const result = await this.client.schedules.destroy(id)
      if (result && typeof result === 'object' && 'id' in result) {
        return toPaymentSubscriptionFromSchedule(result as OmiseSchedule)
      }
      // SDK returned `{ deleted: true }` — rehydrate via retrieve so
      // we have the post-destroy state to return.
      return toPaymentSubscriptionFromSchedule(await this.client.schedules.retrieve(id))
    },
    list: async (
      options: ListSubscriptionsOptions = {},
    ): Promise<PaginatedSubscriptions> => {
      if (!options.customer) {
        throw new ProviderUnsupportedError(
          PROVIDER,
          'subscriptions.list',
          { reason: 'Omise only lists schedules per-customer. Pass `customer` to scope the listing.' },
        )
      }
      const page = await this.client.customers.schedules(options.customer, {
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      })
      const data = page.data.map(toPaymentSubscriptionFromSchedule)
      const filtered = options.status
        ? data.filter((s) => s.status === options.status)
        : data
      return { data: filtered, nextCursor: null }
    },
  }

  readonly invoices: InvoiceOps = {
    retrieve: uns('invoices.retrieve', 'Omise has no invoices.'),
    list: uns('invoices.list', 'Omise has no invoices.'),
    finalize: uns('invoices.finalize', 'Omise has no invoices.'),
    void: uns('invoices.void', 'Omise has no invoices.'),
  }

  readonly checkout: CheckoutOps = {
    create: uns('checkout.create', 'Omise uses Payment Links instead of multi-mode hosted checkout; not bridged in v1.'),
    retrieve: uns('checkout.retrieve', 'Omise hosted checkout not supported.'),
  }

  // ─── Payment methods (Omise cards-on-customer) ────────────────────────

  readonly paymentMethods: PaymentMethodOps = {
    attach: async (paymentMethodId: string, customerId: string): Promise<PaymentMethod> => {
      // Omise: pass the token id via `card`; the card joins the customer.
      const updated = await this.client.customers.update(customerId, {
        card: paymentMethodId,
      })
      const cards = (updated as { cards?: { data?: OmiseCard[] } }).cards
      const card = cards?.data?.find((c) => c.id === paymentMethodId) ?? cards?.data?.[0]
      if (!card) {
        throw new ProviderUnsupportedError(
          PROVIDER,
          'paymentMethods.attach',
          { reason: 'Omise did not return the attached card on the customer payload.' },
        )
      }
      return toPaymentMethod(card)
    },
    detach: async (paymentMethodId: string, customerId?: string): Promise<PaymentMethod> => {
      if (!customerId) {
        throw new ProviderUnsupportedError(
          PROVIDER,
          'paymentMethods.detach',
          { reason: 'Omise needs the owning customer id to detach a card. Call `paymentMethods.detach(cardId, customerId)`.' },
        )
      }
      const card = await this.client.customers.destroyCard(customerId, paymentMethodId)
      return toPaymentMethod(card)
    },
    list: async (
      customerId: string,
      options: ListPaymentMethodsOptions = {},
    ): Promise<PaginatedPaymentMethods> => {
      const page = await this.client.customers.listCards(customerId, {
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      })
      return {
        data: page.data.map(toPaymentMethod),
        nextCursor: null,
      }
    },
  }

  // ─── Charges ──────────────────────────────────────────────────────────

  readonly charges: ChargeOps = {
    create: async (input: CreateChargeInput): Promise<PaymentCharge> => {
      const kind = paymentMethodKind(input.paymentMethod)
      const cardToken = extractCardToken(input.paymentMethod)
      const spec =
        input.paymentMethod && typeof input.paymentMethod !== 'string'
          ? input.paymentMethod
          : null

      // Async two-step: build the source, then create the charge.
      if (spec && spec.kind !== 'card') {
        const build = buildOmiseMethodSpec(spec, input.amount, input.currency)
        if (build.kind !== 'source') {
          throw new ProviderUnsupportedError(
            PROVIDER,
            `charges.method.${kind}`,
            {
              reason: `Omise does not support payment-method kind "${kind}". Use the Stripe provider for paynow / kakaopay / konbini / fps, or call \`driver.client.sources.create\` directly for source types the framework hasn't bridged.`,
            },
          )
        }
        // Redirect-flow sources need a return_uri — Omise sends
        // the customer back here after the wallet/redirect step.
        const needsReturnUri = kind !== 'promptpay'
        if (needsReturnUri && !input.returnUrl) {
          throw new ProviderUnsupportedError(
            PROVIDER,
            `charges.method.${kind}`,
            {
              reason: `Omise requires a \`returnUrl\` for redirect-based payment methods (${kind}). Set \`config.payment.returnUrl\` or pass \`returnUrl\` on the call.`,
            },
          )
        }
        const source = await this.client.sources.create({
          ...build.request,
          amount: input.amount,
          currency: input.currency,
        })
        const c = await this.client.charges.create({
          amount: input.amount,
          currency: input.currency,
          source: source.id,
          ...(input.customer ? { customer: input.customer } : {}),
          ...(input.returnUrl ? { return_uri: input.returnUrl } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        })
        // Re-attach the source we just created in case the charge
        // payload didn't echo it back — the next-action mapper
        // reads `scannable_code` off the source.
        if (!c.source) c.source = source
        return toPaymentCharge(c)
      }

      // Single-step card path (today's behaviour).
      const c = await this.client.charges.create({
        amount: input.amount,
        currency: input.currency,
        ...(input.customer ? { customer: input.customer } : {}),
        ...(cardToken ? { card: cardToken } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.capture !== undefined ? { capture: input.capture } : {}),
      })
      return toPaymentCharge(c)
    },
    retrieve: async (id: string): Promise<PaymentCharge> => {
      return toPaymentCharge(await this.client.charges.retrieve(id))
    },
    capture: async (id: string): Promise<PaymentCharge> => {
      return toPaymentCharge(await this.client.charges.capture(id))
    },
    refund: async (input: CreateRefundInput): Promise<PaymentRefund> => {
      const refund = await this.client.charges.createRefund(input.charge, {
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      return {
        id: refund.id,
        provider: PROVIDER,
        chargeId: refund.charge ?? input.charge,
        amount: refund.amount,
        currency: refund.currency.toLowerCase(),
        status: refund.voided ? 'failed' : 'succeeded',
        reason: input.reason ?? null,
        createdAt: refund.created_at
          ? new Date(refund.created_at)
          : refund.created
            ? new Date(refund.created)
            : new Date(),
        raw: refund,
      }
    },
  }

  readonly links: LinkOps = {
    create: async (input: CreatePaymentLinkInput): Promise<PaymentLink> => {
      if (input.items && input.items.length > 0) {
        throw new ProviderUnsupportedError(
          PROVIDER,
          'links.create',
          {
            reason: 'Omise has no Prices catalogue. Pass `amount`, `currency`, `title`, and `description` directly instead of `items`.',
          },
        )
      }
      if (
        input.amount === undefined ||
        !input.currency ||
        !input.title ||
        !input.description
      ) {
        throw new ProviderUnsupportedError(
          PROVIDER,
          'links.create',
          {
            reason: 'Omise links require `amount`, `currency`, `title`, and `description`. All four are mandatory.',
          },
        )
      }
      const link = await this.client.links.create({
        amount: input.amount,
        currency: input.currency,
        title: input.title,
        description: input.description,
        ...(input.reusable !== undefined ? { multiple: input.reusable } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      return toPaymentLink(link)
    },
    retrieve: async (id: string): Promise<PaymentLink> => {
      return toPaymentLink(await this.client.links.retrieve(id))
    },
    list: async (
      options: ListPaymentLinksOptions = {},
    ): Promise<PaginatedPaymentLinks> => {
      const page = await this.client.links.list({
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      })
      const data = page.data.map(toPaymentLink)
      const filtered =
        options.active !== undefined
          ? data.filter((l) => l.active === options.active)
          : data
      return { data: filtered, nextCursor: null }
    },
    deactivate: async (_id: string): Promise<PaymentLink> => {
      throw new ProviderUnsupportedError(
        PROVIDER,
        'links.deactivate',
        {
          reason: 'Omise has no link-deactivation endpoint. Single-use links (`reusable: false`) auto-expire after first payment; multi-use links remain active until manually deleted from the Omise Dashboard.',
        },
      )
    },
  }

  readonly webhook: WebhookOps = {
    verify: async (rawBody: string, signature: string): Promise<unknown> => {
      return omiseVerify(rawBody, signature, this.config.webhookSecret)
    },
    normalize: (event: unknown): NormalizedWebhookEvent | null => {
      return omiseNormalize(event as OmiseEvent)
    },
  }
}
