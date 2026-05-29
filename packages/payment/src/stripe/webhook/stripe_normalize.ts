/**
 * `stripeNormalize(event)` — map a `Stripe.Event` onto the
 * framework's `NormalizedWebhookEvent` (or `null` for events
 * outside the closed union).
 *
 * The mapping table covers the events apps most often care
 * about. Extending it is additive — adding a new case never
 * breaks an existing handler, and unmapped events still flow
 * through the dedup ledger (with no user dispatch).
 *
 * `_fields` carries the parsed shape the `PaymentLedger`
 * consumes when ledger sync is on. Keys mirror the matching
 * DTO field names so the ledger can write directly.
 */

import type Stripe from 'stripe'
import type {
  NormalizedWebhookEvent,
  PaymentEventType,
} from '../../dto/index.ts'
import { readTenantId } from '../../tenant_metadata.ts'
import {
  toPaymentCustomer,
  toPaymentInvoice,
  toPaymentSubscription,
} from '../mappers/stripe_mappers.ts'

const TYPE_MAP: Record<string, PaymentEventType> = {
  'customer.created': 'customer.created',
  'customer.updated': 'customer.updated',
  'customer.deleted': 'customer.deleted',
  'customer.subscription.created': 'subscription.created',
  'customer.subscription.updated': 'subscription.updated',
  'customer.subscription.deleted': 'subscription.canceled',
  'customer.subscription.trial_will_end': 'subscription.trial_will_end',
  'charge.succeeded': 'charge.succeeded',
  'charge.failed': 'charge.failed',
  'charge.refunded': 'charge.refunded',
  'invoice.created': 'invoice.created',
  'invoice.paid': 'invoice.paid',
  'invoice.payment_failed': 'invoice.payment_failed',
  'invoice.voided': 'invoice.voided',
  'checkout.session.completed': 'checkout.completed',
  'checkout.session.expired': 'checkout.expired',
  'payment_method.attached': 'payment_method.attached',
  'payment_method.detached': 'payment_method.detached',
}

export function stripeNormalize(event: Stripe.Event): NormalizedWebhookEvent | null {
  const type = TYPE_MAP[event.type]
  if (!type) return null

  const data: NormalizedWebhookEvent['data'] = {}
  let fields: Record<string, unknown> | undefined

  switch (type) {
    case 'customer.created':
    case 'customer.updated': {
      const c = event.data.object as Stripe.Customer
      data.customerId = c.id
      const dto = toPaymentCustomer(c)
      fields = { ...dto }
      break
    }
    case 'customer.deleted': {
      const c = event.data.object as Stripe.Customer
      data.customerId = c.id
      break
    }
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.canceled':
    case 'subscription.trial_will_end': {
      const s = event.data.object as Stripe.Subscription
      const dto = toPaymentSubscription(s)
      data.subscriptionId = dto.id
      data.customerId = dto.customerId
      fields = { ...dto }
      break
    }
    case 'charge.succeeded':
    case 'charge.failed':
    case 'charge.refunded': {
      const c = event.data.object as Stripe.Charge
      data.chargeId = c.id
      if (typeof c.customer === 'string') data.customerId = c.customer
      break
    }
    case 'invoice.created':
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.voided': {
      const i = event.data.object as Stripe.Invoice
      const dto = toPaymentInvoice(i)
      data.invoiceId = dto.id
      data.customerId = dto.customerId
      if (dto.subscriptionId) data.subscriptionId = dto.subscriptionId
      fields = { ...dto }
      break
    }
    case 'checkout.completed':
    case 'checkout.expired': {
      const s = event.data.object as Stripe.Checkout.Session
      data.checkoutId = s.id
      if (typeof s.customer === 'string') data.customerId = s.customer
      if (typeof s.subscription === 'string') data.subscriptionId = s.subscription
      break
    }
    case 'payment_method.attached':
    case 'payment_method.detached': {
      const pm = event.data.object as Stripe.PaymentMethod
      data.paymentMethodId = pm.id
      if (typeof pm.customer === 'string') data.customerId = pm.customer
      break
    }
  }

  // Read the framework's tenant key off whatever resource the
  // event carries. Stripe echoes `metadata` on every resource
  // type, so the same lookup works across customer / subscription
  // / invoice / charge / checkout payloads.
  const resourceMeta =
    (event.data.object as { metadata?: Record<string, unknown> } | undefined)
      ?.metadata ?? null
  const tenantId = readTenantId(resourceMeta)

  const normalized: NormalizedWebhookEvent = {
    id: event.id,
    type,
    provider: 'stripe',
    raw: event,
    data,
    ...(tenantId ? { tenantId } : {}),
  }
  if (fields) {
    ;(normalized as { _fields?: unknown })._fields = fields
  }
  return normalized
}
