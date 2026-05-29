/**
 * Tests for the Omise schedules bridge: price-spec encode/decode,
 * schedule → PaymentSubscription mapping, end-to-end driver flow
 * against a stubbed Omise client.
 */

import { describe, expect, test } from 'bun:test'
import {
  OmisePaymentDriver,
  omiseNormalize,
  omisePriceSpec,
  parseOmisePriceSpec,
  toPaymentSubscriptionFromSchedule,
  type OmiseSchedule,
} from '../src/omise/index.ts'

describe('omisePriceSpec', () => {
  test('round-trips a full spec', () => {
    const spec = { amount: 39900, currency: 'thb', period: 'month' as const, every: 1, description: 'Pro monthly' }
    const encoded = omisePriceSpec(spec)
    expect(encoded.startsWith('omise_spec:')).toBe(true)
    const decoded = parseOmisePriceSpec(encoded)
    expect(decoded).toEqual(spec)
  })

  test('round-trips minimal spec', () => {
    const encoded = omisePriceSpec({ amount: 1000, currency: 'THB', period: 'week' })
    const decoded = parseOmisePriceSpec(encoded)
    expect(decoded?.amount).toBe(1000)
    expect(decoded?.currency).toBe('thb')
    expect(decoded?.period).toBe('week')
    expect(decoded?.every).toBeUndefined()
  })

  test('rejects malformed prefixed values gracefully', () => {
    expect(parseOmisePriceSpec('omise_spec:not-base64!')).toBeNull()
    expect(parseOmisePriceSpec('price_xxx')).toBeNull()
  })

  test('throws on zero or negative amounts', () => {
    expect(() => omisePriceSpec({ amount: 0, currency: 'thb', period: 'month' })).toThrow(TypeError)
    expect(() => omisePriceSpec({ amount: -100, currency: 'thb', period: 'month' })).toThrow(TypeError)
  })
})

describe('toPaymentSubscriptionFromSchedule', () => {
  test('maps an active charge schedule into a subscription DTO', () => {
    const schedule: OmiseSchedule = {
      id: 'schd_x',
      status: 'running',
      active: true,
      every: 1,
      period: 'month',
      start_date: '2026-01-01',
      end_date: '2027-01-01',
      next_occurrence_dates: ['2026-06-01', '2026-07-01'],
      created_at: '2025-12-15T00:00:00Z',
      charge: {
        amount: 39900,
        currency: 'thb',
        customer: 'cust_x',
        card: 'card_y',
        description: 'Pro monthly',
      },
    }
    const sub = toPaymentSubscriptionFromSchedule(schedule)
    expect(sub.id).toBe('schd_x')
    expect(sub.provider).toBe('omise')
    expect(sub.customerId).toBe('cust_x')
    expect(sub.status).toBe('active')
    // priceId round-trips into a parsable spec
    const spec = parseOmisePriceSpec(sub.priceId)
    expect(spec?.amount).toBe(39900)
    expect(spec?.currency).toBe('thb')
    expect(spec?.period).toBe('month')
    expect(spec?.card).toBe('card_y')
  })

  test('maps a suspended schedule to status=paused', () => {
    const schedule: OmiseSchedule = {
      id: 'schd_y',
      status: 'suspended',
      every: 1,
      period: 'month',
      charge: { amount: 1000, currency: 'thb', customer: 'cust_z' },
    }
    expect(toPaymentSubscriptionFromSchedule(schedule).status).toBe('paused')
  })

  test('maps an expired schedule to status=canceled', () => {
    const schedule: OmiseSchedule = {
      id: 'schd_z',
      status: 'expired',
      active: false,
      every: 1,
      period: 'month',
      ended_at: '2026-04-01T00:00:00Z',
      charge: { amount: 1000, currency: 'thb', customer: 'cust_a' },
    }
    const sub = toPaymentSubscriptionFromSchedule(schedule)
    expect(sub.status).toBe('canceled')
    expect(sub.canceledAt).toBeInstanceOf(Date)
  })
})

describe('OmisePaymentDriver — subscriptions end-to-end with stub client', () => {
  function makeDriver(captured: { lastCreate?: Record<string, unknown> }) {
    const stubClient = {
      schedules: {
        create: async (req: Record<string, unknown>): Promise<OmiseSchedule> => {
          captured.lastCreate = req
          const chargeReq = req.charge as { customer: string; amount: number; currency: string; description?: string }
          return {
            id: 'schd_created',
            status: 'running',
            active: true,
            every: req.every as number,
            period: req.period as string,
            start_date: req.start_date as string,
            end_date: req.end_date as string,
            next_occurrence_dates: ['2026-07-01'],
            created_at: '2026-06-15T00:00:00Z',
            charge: {
              customer: chargeReq.customer,
              amount: chargeReq.amount,
              currency: chargeReq.currency,
              ...(chargeReq.description ? { description: chargeReq.description } : {}),
            },
          }
        },
        retrieve: async (): Promise<OmiseSchedule> => ({
          id: 'schd_created',
          status: 'expired',
          active: false,
          every: 1,
          period: 'month',
          ended_at: '2026-07-15T00:00:00Z',
          charge: { customer: 'cust_x', amount: 39900, currency: 'thb' },
        }),
        destroy: async () => ({ deleted: true }),
      },
      customers: {
        schedules: async () => ({
          data: [
            {
              id: 'schd_listed',
              status: 'running',
              active: true,
              every: 1,
              period: 'month',
              charge: { customer: 'cust_x', amount: 1000, currency: 'thb' },
            },
          ],
        }),
      },
    }
    return new OmisePaymentDriver({
      instanceName: 'omise',
      config: {
        driver: 'omise',
        publicKey: 'pkey_test_x',
        secretKey: 'skey_test_x',
        webhookSecret: 'whsec',
        client: stubClient as never,
      },
    })
  }

  test('subscriptions.create passes spec fields through to Omise schedules.create', async () => {
    const captured: { lastCreate?: Record<string, unknown> } = {}
    const driver = makeDriver(captured)
    const sub = await driver.subscriptions.create({
      customer: 'cust_x',
      price: omisePriceSpec({ amount: 39900, currency: 'thb', period: 'month', description: 'Pro monthly' }),
    })
    expect(sub.id).toBe('schd_created')
    expect(sub.status).toBe('active')
    const create = captured.lastCreate
    expect(create?.every).toBe(1)
    expect(create?.period).toBe('month')
    expect((create?.charge as { amount: number }).amount).toBe(39900)
    expect((create?.charge as { description?: string }).description).toBe('Pro monthly')
  })

  test('subscriptions.cancel returns the post-destroy state', async () => {
    const driver = makeDriver({})
    const sub = await driver.subscriptions.cancel('schd_created')
    expect(sub.status).toBe('canceled')
    expect(sub.canceledAt).toBeInstanceOf(Date)
  })

  test('subscriptions.list({ customer }) routes through customers.schedules', async () => {
    const driver = makeDriver({})
    const page = await driver.subscriptions.list({ customer: 'cust_x' })
    expect(page.data).toHaveLength(1)
    expect(page.data[0]?.id).toBe('schd_listed')
  })
})

describe('omiseNormalize — schedule events', () => {
  test('maps schedule.create → subscription.created', () => {
    const out = omiseNormalize({
      id: 'evnt_schd',
      object: 'event',
      key: 'schedule.create',
      data: {
        object: {
          id: 'schd_x',
          status: 'running',
          active: true,
          every: 1,
          period: 'month',
          charge: { customer: 'cust_y', amount: 1000, currency: 'thb' },
        },
      },
    })
    expect(out?.type).toBe('subscription.created')
    expect(out?.data.subscriptionId).toBe('schd_x')
    expect(out?.data.customerId).toBe('cust_y')
    const fields = (out as { _fields?: { status?: string } } | null)?._fields
    expect(fields?.status).toBe('active')
  })

  test('maps schedule.destroy → subscription.canceled', () => {
    const out = omiseNormalize({
      id: 'evnt_schd_x',
      object: 'event',
      key: 'schedule.destroy',
      data: {
        object: {
          id: 'schd_x',
          status: 'expired',
          active: false,
          every: 1,
          period: 'month',
          ended_at: '2026-07-15T00:00:00Z',
          charge: { customer: 'cust_y', amount: 1000, currency: 'thb' },
        },
      },
    })
    expect(out?.type).toBe('subscription.canceled')
  })
})
