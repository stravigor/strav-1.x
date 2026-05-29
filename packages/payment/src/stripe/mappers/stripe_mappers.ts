/**
 * Stripe ↔ normalized-DTO mappers. One function per resource;
 * each converts a `Stripe.<X>` SDK object into the framework's
 * `Payment<X>` DTO with the native object on `.raw`.
 *
 * Field name conventions:
 *   - Stripe timestamps are unix seconds; we multiply by 1000.
 *   - Stripe metadata is `Record<string, string>` directly.
 *   - Missing-from-Stripe-but-required-by-DTO falls back to
 *     sensible defaults (empty string, `{}`); never invent ids.
 */

import type Stripe from 'stripe'
import type {
  ChargeStatus,
  InvoiceStatus,
  PaymentCharge,
  PaymentCheckoutSession,
  PaymentCustomer,
  PaymentInvoice,
  PaymentMethod,
  PaymentPrice,
  PaymentProduct,
  PaymentSubscription,
  SubscriptionStatus,
} from '../../dto/index.ts'

const PROVIDER = 'stripe'

function toDate(unix: number | null | undefined): Date | null {
  if (unix === null || unix === undefined) return null
  return new Date(unix * 1000)
}

function metadata(m: Stripe.Metadata | null | undefined): Record<string, string> {
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) {
    if (v === null) continue
    out[k] = String(v)
  }
  return out
}

export function toPaymentCustomer(c: Stripe.Customer): PaymentCustomer {
  return {
    id: c.id,
    provider: PROVIDER,
    email: c.email ?? '',
    ...(c.name ? { name: c.name } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    metadata: metadata(c.metadata),
    createdAt: new Date(c.created * 1000),
    raw: c,
  }
}

export function toPaymentProduct(p: Stripe.Product): PaymentProduct {
  return {
    id: p.id,
    provider: PROVIDER,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    active: p.active,
    metadata: metadata(p.metadata),
    createdAt: new Date(p.created * 1000),
    raw: p,
  }
}

export function toPaymentPrice(p: Stripe.Price): PaymentPrice {
  return {
    id: p.id,
    provider: PROVIDER,
    productId: typeof p.product === 'string' ? p.product : (p.product as { id: string }).id,
    amount: p.unit_amount ?? 0,
    currency: p.currency,
    type: p.type === 'recurring' ? 'recurring' : 'one_time',
    ...(p.recurring?.interval
      ? { interval: p.recurring.interval as PaymentPrice['interval'] }
      : {}),
    ...(p.recurring?.interval_count
      ? { intervalCount: p.recurring.interval_count }
      : {}),
    active: p.active,
    metadata: metadata(p.metadata),
    createdAt: new Date(p.created * 1000),
    raw: p,
  }
}

const SUBSCRIPTION_STATUS_MAP: Record<Stripe.Subscription.Status, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'past_due',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  paused: 'paused',
}

export function toPaymentSubscription(s: Stripe.Subscription): PaymentSubscription {
  // Stripe sometimes nests the actual price on items.data[0].price.
  const firstItem = s.items.data[0]
  const priceId = firstItem
    ? typeof firstItem.price === 'string'
      ? firstItem.price
      : firstItem.price.id
    : ''
  // `current_period_start/end` moved to the item level in recent API
  // versions; fall back across both shapes.
  const sAny = s as unknown as { current_period_start?: number; current_period_end?: number }
  const itemAny = firstItem as unknown as
    | { current_period_start?: number; current_period_end?: number }
    | undefined
  const periodStart = sAny.current_period_start ?? itemAny?.current_period_start ?? s.start_date
  const periodEnd = sAny.current_period_end ?? itemAny?.current_period_end ?? s.start_date
  return {
    id: s.id,
    provider: PROVIDER,
    customerId: typeof s.customer === 'string' ? s.customer : (s.customer as { id: string }).id,
    priceId,
    status: SUBSCRIPTION_STATUS_MAP[s.status] ?? 'active',
    currentPeriodStart: new Date(periodStart * 1000),
    currentPeriodEnd: new Date(periodEnd * 1000),
    cancelAt: toDate(s.cancel_at),
    canceledAt: toDate(s.canceled_at),
    trialStart: toDate(s.trial_start),
    trialEnd: toDate(s.trial_end),
    metadata: metadata(s.metadata),
    createdAt: new Date(s.created * 1000),
    raw: s,
  }
}

function paymentMethodKind(kind: string): PaymentMethod['kind'] {
  switch (kind) {
    case 'card':
      return 'card'
    case 'us_bank_account':
    case 'bank_account':
      return 'bank_account'
    case 'sepa_debit':
      return 'sepa_debit'
    case 'paypal':
      return 'paypal'
    default:
      return 'other'
  }
}

export function toPaymentMethod(pm: Stripe.PaymentMethod): PaymentMethod {
  const card = pm.card
  return {
    id: pm.id,
    provider: PROVIDER,
    customerId:
      typeof pm.customer === 'string'
        ? pm.customer
        : pm.customer
          ? (pm.customer as { id: string }).id
          : null,
    kind: paymentMethodKind(pm.type),
    ...(card?.brand ? { brand: card.brand } : {}),
    ...(card?.last4 ? { last4: card.last4 } : {}),
    ...(card?.exp_month ? { expMonth: card.exp_month } : {}),
    ...(card?.exp_year ? { expYear: card.exp_year } : {}),
    metadata: metadata(pm.metadata),
    createdAt: new Date(pm.created * 1000),
    raw: pm,
  }
}

const CHARGE_STATUS_MAP: Record<Stripe.Charge.Status, ChargeStatus> = {
  succeeded: 'succeeded',
  pending: 'pending',
  failed: 'failed',
}

export function toPaymentCharge(c: Stripe.Charge): PaymentCharge {
  const status: ChargeStatus = c.refunded
    ? c.amount_refunded === c.amount
      ? 'refunded'
      : 'partial_refunded'
    : (CHARGE_STATUS_MAP[c.status] ?? 'pending')
  return {
    id: c.id,
    provider: PROVIDER,
    customerId: typeof c.customer === 'string' ? c.customer : (c.customer as { id: string } | null)?.id ?? null,
    amount: c.amount,
    currency: c.currency,
    status,
    paymentMethodId:
      typeof c.payment_method === 'string'
        ? c.payment_method
        : (c.payment_method as { id: string } | null)?.id ?? null,
    failureCode: c.failure_code,
    failureMessage: c.failure_message,
    // Settled charges don't carry a next-action. The intent-level
    // mapper used by `charges.create` populates `nextAction` from
    // `PaymentIntent.next_action` when the charge is still in
    // `requires_action`; that lands in slice 7.2.
    nextAction: null,
    metadata: metadata(c.metadata),
    createdAt: new Date(c.created * 1000),
    raw: c,
  }
}

const INVOICE_STATUS_MAP: Record<NonNullable<Stripe.Invoice.Status>, InvoiceStatus> = {
  draft: 'draft',
  open: 'open',
  paid: 'paid',
  uncollectible: 'uncollectible',
  void: 'void',
}

export function toPaymentInvoice(i: Stripe.Invoice): PaymentInvoice {
  // Stripe invoices carry the subscription reference on a nested
  // line-item property; fall back to a top-level field on older
  // shapes.
  const iAny = i as unknown as {
    subscription?: string | { id: string } | null
    customer?: string | { id: string } | null
    hosted_invoice_url?: string | null
    invoice_pdf?: string | null
  }
  const subId =
    typeof iAny.subscription === 'string'
      ? iAny.subscription
      : iAny.subscription
        ? (iAny.subscription as { id: string }).id
        : null
  return {
    id: i.id ?? '',
    provider: PROVIDER,
    customerId:
      typeof iAny.customer === 'string'
        ? iAny.customer
        : iAny.customer
          ? (iAny.customer as { id: string }).id
          : '',
    subscriptionId: subId,
    status: i.status ? (INVOICE_STATUS_MAP[i.status] ?? 'open') : 'draft',
    amount: i.amount_due,
    amountPaid: i.amount_paid,
    amountDue: i.amount_remaining ?? i.amount_due,
    currency: i.currency,
    hostedUrl: iAny.hosted_invoice_url ?? null,
    pdfUrl: iAny.invoice_pdf ?? null,
    dueAt: toDate(i.due_date),
    paidAt: i.status === 'paid' ? toDate(i.status_transitions?.paid_at) : null,
    metadata: metadata(i.metadata),
    createdAt: new Date(i.created * 1000),
    raw: i,
  }
}

export function toPaymentLink(l: Stripe.PaymentLink): import('../../dto/index.ts').PaymentLink {
  // Stripe Payment Links carry their amount/currency on the
  // attached line_items.data[0].price — when the SDK doesn't
  // expand it, those fields are `null` on our DTO and apps
  // resolve the price separately. The link itself doesn't
  // expose a top-level amount.
  return {
    id: l.id,
    provider: PROVIDER,
    url: l.url,
    amount: null,
    currency: null,
    active: l.active,
    reusable: true, // Stripe links are reusable by default; single-use is rare.
    metadata: metadata(l.metadata),
    createdAt: new Date(0), // PaymentLink.created not on Stripe.PaymentLink — apps that need it read from the dashboard.
    raw: l,
  }
}

export function toPaymentCheckoutSession(
  s: Stripe.Checkout.Session,
): PaymentCheckoutSession {
  return {
    id: s.id,
    provider: PROVIDER,
    mode: s.mode === 'subscription' ? 'subscription' : s.mode === 'setup' ? 'setup' : 'payment',
    status: s.status === 'complete' ? 'complete' : s.status === 'expired' ? 'expired' : 'open',
    url: s.url ?? '',
    customerId:
      typeof s.customer === 'string'
        ? s.customer
        : s.customer
          ? (s.customer as { id: string }).id
          : null,
    paymentIntentId:
      typeof s.payment_intent === 'string'
        ? s.payment_intent
        : s.payment_intent
          ? (s.payment_intent as { id: string }).id
          : null,
    subscriptionId:
      typeof s.subscription === 'string'
        ? s.subscription
        : s.subscription
          ? (s.subscription as { id: string }).id
          : null,
    expiresAt: toDate(s.expires_at),
    metadata: metadata(s.metadata),
    createdAt: new Date(s.created * 1000),
    raw: s,
  }
}
