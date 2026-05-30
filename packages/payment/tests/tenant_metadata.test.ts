/**
 * Slice 7.6 — tenant-on-webhook routing.
 *
 *   - `tenantedMetadata(tenantId, extra?)` builds a metadata bag
 *     with the framework's tenant key.
 *   - `readTenantId(metadata)` extracts it on the way back in.
 *   - Stripe `stripeNormalize` reads `strav_tenant_id` from event
 *     resource metadata → `event.tenantId`.
 *   - Omise `omiseNormalize` does the same.
 *   - Round-trip case: stamp on create, read on webhook.
 */

import { describe, expect, test } from 'bun:test'
import type Stripe from 'stripe'
import {
  readTenantId,
  TENANT_METADATA_KEY,
  tenantedMetadata,
} from '../src/index.ts'
import { stripeNormalize } from '../src/drivers/stripe/index.ts'
import { omiseNormalize } from '../src/drivers/omise/index.ts'

describe('tenantedMetadata + readTenantId helpers', () => {
  test('builds + reads back the conventional key', () => {
    const meta = tenantedMetadata('tnt_acme', { source: 'signup' })
    expect(meta[TENANT_METADATA_KEY]).toBe('tnt_acme')
    expect(meta.source).toBe('signup')
    expect(readTenantId(meta)).toBe('tnt_acme')
  })

  test('readTenantId returns undefined for missing / empty / non-string', () => {
    expect(readTenantId(undefined)).toBeUndefined()
    expect(readTenantId(null)).toBeUndefined()
    expect(readTenantId({})).toBeUndefined()
    expect(readTenantId({ [TENANT_METADATA_KEY]: '' })).toBeUndefined()
    expect(readTenantId({ [TENANT_METADATA_KEY]: 42 })).toBeUndefined()
  })

  test('TENANT_METADATA_KEY is `strav_tenant_id`', () => {
    expect(TENANT_METADATA_KEY).toBe('strav_tenant_id')
  })
})

describe('stripeNormalize — populates event.tenantId from resource metadata', () => {
  function buildEvent<T>(type: string, object: T): Stripe.Event {
    return {
      id: 'evt_test_1',
      type,
      object: 'event',
      api_version: '2024-04-10',
      created: 1_700_000_000,
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      data: { object: object as unknown as Stripe.Event.Data.Object },
    } as Stripe.Event
  }

  test('customer.created with strav_tenant_id metadata → event.tenantId set', () => {
    const event = buildEvent('customer.created', {
      id: 'cus_x',
      object: 'customer',
      email: 'a@b.co',
      created: 1_700_000_000,
      metadata: tenantedMetadata('tnt_acme'),
    })
    expect(stripeNormalize(event)?.tenantId).toBe('tnt_acme')
  })

  test('subscription event with metadata → event.tenantId set', () => {
    const event = buildEvent('customer.subscription.created', {
      id: 'sub_x',
      object: 'subscription',
      customer: 'cus_y',
      status: 'active',
      start_date: 1_700_000_000,
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
      cancel_at: null,
      canceled_at: null,
      trial_start: null,
      trial_end: null,
      created: 1_700_000_000,
      items: {
        object: 'list',
        data: [{ id: 'si_1', price: 'price_a' }],
        has_more: false,
        url: '',
      },
      metadata: tenantedMetadata('tnt_globex'),
    })
    expect(stripeNormalize(event)?.tenantId).toBe('tnt_globex')
  })

  test('no metadata → no tenantId on the event', () => {
    const event = buildEvent('customer.created', {
      id: 'cus_x',
      object: 'customer',
      email: 'a@b.co',
      created: 1_700_000_000,
      metadata: {},
    })
    expect(stripeNormalize(event)?.tenantId).toBeUndefined()
  })
})

describe('omiseNormalize — populates event.tenantId from resource metadata', () => {
  test('customer.create with strav_tenant_id metadata', () => {
    const out = omiseNormalize({
      id: 'evnt_1',
      object: 'event',
      key: 'customer.create',
      data: {
        object: {
          id: 'cust_x',
          email: 'a@b.co',
          created_at: '2026-05-01T00:00:00Z',
          metadata: tenantedMetadata('tnt_acme'),
        },
      },
    })
    expect(out?.tenantId).toBe('tnt_acme')
  })

  test('charge.complete with metadata', () => {
    const out = omiseNormalize({
      id: 'evnt_2',
      object: 'event',
      key: 'charge.complete',
      data: {
        object: {
          id: 'chrg_x',
          amount: 1000,
          currency: 'THB',
          status: 'successful',
          customer: 'cust_y',
          metadata: tenantedMetadata('tnt_globex'),
        },
      },
    })
    expect(out?.tenantId).toBe('tnt_globex')
  })

  test('no metadata → no tenantId', () => {
    const out = omiseNormalize({
      id: 'evnt_3',
      object: 'event',
      key: 'customer.create',
      data: { object: { id: 'cust_x', email: 'a@b.co' } },
    })
    expect(out?.tenantId).toBeUndefined()
  })
})
