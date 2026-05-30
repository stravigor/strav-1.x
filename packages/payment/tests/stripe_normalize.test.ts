/**
 * `stripeNormalize` unit tests — verifies the closed-union
 * mapping for the events the framework cares about. No SDK or
 * network involved; events are built as plain objects with the
 * minimum field shape each branch reads.
 */

import { describe, expect, test } from 'bun:test'
import type Stripe from 'stripe'
import { stripeNormalize } from '../src/drivers/stripe/index.ts'

function buildEvent<T>(type: string, object: T, id = 'evt_test_1'): Stripe.Event {
  return {
    id,
    type,
    object: 'event',
    api_version: '2024-04-10',
    created: 1700000000,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: object as unknown as Stripe.Event.Data.Object },
  } as Stripe.Event
}

describe('stripeNormalize', () => {
  test('maps customer.created', () => {
    const event = buildEvent('customer.created', {
      id: 'cus_x',
      object: 'customer',
      email: 'a@b.co',
      name: 'Alice',
      created: 1700000000,
      metadata: { app_id: '7' },
    })
    const out = stripeNormalize(event)
    expect(out).not.toBeNull()
    expect(out?.type).toBe('customer.created')
    expect(out?.provider).toBe('stripe')
    expect(out?.data.customerId).toBe('cus_x')
    expect((out as { _fields?: { email?: string } } | null)?._fields?.email).toBe('a@b.co')
  })

  test('maps customer.subscription.created → subscription.created', () => {
    const event = buildEvent('customer.subscription.created', {
      id: 'sub_x',
      object: 'subscription',
      customer: 'cus_y',
      status: 'trialing',
      start_date: 1700000000,
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      cancel_at: null,
      canceled_at: null,
      trial_start: 1700000000,
      trial_end: 1701209600,
      created: 1700000000,
      items: {
        object: 'list',
        data: [{ id: 'si_1', price: { id: 'price_a' } }],
        has_more: false,
        url: '',
      },
      metadata: {},
    })
    const out = stripeNormalize(event)
    expect(out?.type).toBe('subscription.created')
    expect(out?.data.subscriptionId).toBe('sub_x')
    expect(out?.data.customerId).toBe('cus_y')
    const fields = (out as { _fields?: Record<string, unknown> } | null)?._fields
    expect(fields?.status).toBe('trialing')
    expect(fields?.trialEnd).toBeInstanceOf(Date)
  })

  test('maps customer.subscription.deleted → subscription.canceled', () => {
    const event = buildEvent('customer.subscription.deleted', {
      id: 'sub_x',
      object: 'subscription',
      customer: 'cus_y',
      status: 'canceled',
      start_date: 1700000000,
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      cancel_at: null,
      canceled_at: 1700500000,
      trial_start: null,
      trial_end: null,
      created: 1700000000,
      items: { object: 'list', data: [{ id: 'si_1', price: 'price_a' }], has_more: false, url: '' },
      metadata: {},
    })
    expect(stripeNormalize(event)?.type).toBe('subscription.canceled')
  })

  test('maps invoice.paid', () => {
    const event = buildEvent('invoice.paid', {
      id: 'in_x',
      object: 'invoice',
      customer: 'cus_y',
      subscription: 'sub_z',
      status: 'paid',
      amount_due: 2000,
      amount_paid: 2000,
      amount_remaining: 0,
      currency: 'usd',
      created: 1700000000,
      due_date: null,
      status_transitions: { paid_at: 1700100000 },
      metadata: {},
      hosted_invoice_url: 'https://invoice.stripe.com/x',
      invoice_pdf: 'https://invoice.stripe.com/x.pdf',
    })
    const out = stripeNormalize(event)
    expect(out?.type).toBe('invoice.paid')
    expect(out?.data.invoiceId).toBe('in_x')
    expect(out?.data.subscriptionId).toBe('sub_z')
    const fields = (out as { _fields?: Record<string, unknown> } | null)?._fields
    expect(fields?.amount).toBe(2000)
    expect(fields?.status).toBe('paid')
  })

  test('maps checkout.session.completed', () => {
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_x',
      object: 'checkout.session',
      mode: 'payment',
      status: 'complete',
      customer: 'cus_y',
      subscription: null,
      payment_intent: 'pi_z',
      url: 'https://checkout.stripe.com/x',
      created: 1700000000,
      expires_at: 1700100000,
      metadata: {},
    })
    const out = stripeNormalize(event)
    expect(out?.type).toBe('checkout.completed')
    expect(out?.data.checkoutId).toBe('cs_x')
    expect(out?.data.customerId).toBe('cus_y')
  })

  test('returns null for unmapped event types', () => {
    const event = buildEvent('mandate.updated', { id: 'mandate_x' })
    expect(stripeNormalize(event)).toBeNull()
  })
})
