/**
 * Unit tests for the Omise driver — webhook verify + normalize +
 * the capability gating + ProviderUnsupportedError surface. No
 * network is touched; the Omise client is stubbed via `config.client`.
 */

import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  OmisePaymentDriver,
  omiseNormalize,
  omiseVerify,
} from '../src/omise/index.ts'
import {
  ProviderUnsupportedError,
  WebhookSignatureError,
} from '../src/index.ts'

const SECRET = 'whsec_omise_test'

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

describe('omiseVerify', () => {
  test('accepts a valid HMAC signature', async () => {
    const body = JSON.stringify({ id: 'evt_1', object: 'event', key: 'charge.complete', data: {} })
    const result = await omiseVerify(body, sign(body), SECRET)
    expect(result.id).toBe('evt_1')
  })

  test('rejects a bad signature', async () => {
    const body = '{}'
    await expect(omiseVerify(body, sign('different'), SECRET)).rejects.toThrow(
      WebhookSignatureError,
    )
  })

  test('rejects when webhookSecret is unset', async () => {
    await expect(omiseVerify('{}', 'sig', undefined)).rejects.toThrow(
      /webhookSecret/,
    )
  })

  test('rejects malformed JSON even when signature matches', async () => {
    const body = 'not-json'
    await expect(omiseVerify(body, sign(body), SECRET)).rejects.toThrow(
      /not valid JSON/,
    )
  })
})

describe('omiseNormalize', () => {
  test('maps customer.create → customer.created', () => {
    const out = omiseNormalize({
      id: 'evnt_1',
      object: 'event',
      key: 'customer.create',
      data: {
        object: {
          id: 'cust_x',
          email: 'a@b.co',
          created_at: '2026-05-01T00:00:00Z',
        },
      },
    })
    expect(out?.type).toBe('customer.created')
    expect(out?.data.customerId).toBe('cust_x')
    expect((out as { _fields?: { email?: string } } | null)?._fields?.email).toBe('a@b.co')
  })

  test('maps charge.complete → charge.succeeded with refund detection', () => {
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
          refunded: 0,
          created_at: '2026-05-01T00:00:00Z',
        },
      },
    })
    expect(out?.type).toBe('charge.succeeded')
    expect(out?.data.chargeId).toBe('chrg_x')
    expect(out?.data.customerId).toBe('cust_y')
  })

  test('returns null for unmapped event keys', () => {
    const out = omiseNormalize({
      id: 'evnt_3',
      object: 'event',
      key: 'transfer.create',
      data: {},
    })
    expect(out).toBeNull()
  })
})

describe('OmisePaymentDriver — capability gating', () => {
  function makeDriver() {
    return new OmisePaymentDriver({
      instanceName: 'omise',
      config: {
        driver: 'omise',
        publicKey: 'pkey_test_x',
        secretKey: 'skey_test_x',
        webhookSecret: SECRET,
        client: {} as never,
      },
    })
  }

  test('declares only supported capabilities', () => {
    const driver = makeDriver()
    expect(driver.capabilities.has('charges.create')).toBe(true)
    expect(driver.capabilities.has('customers.create')).toBe(true)
    // Subscriptions: bridged via Omise schedules.
    expect(driver.capabilities.has('subscriptions.create')).toBe(true)
    expect(driver.capabilities.has('subscriptions.cancel')).toBe(true)
    // …but trials + changePlan + update are NOT supported (schedules are immutable, no trial concept).
    expect(driver.capabilities.has('subscriptions.trials')).toBe(false)
    expect(driver.capabilities.has('subscriptions.changePlan')).toBe(false)
    expect(driver.capabilities.has('subscriptions.update')).toBe(false)
    expect(driver.capabilities.has('checkout.create')).toBe(false)
    expect(driver.capabilities.has('invoices.list')).toBe(false)
    expect(driver.capabilities.has('products.create')).toBe(false)
  })

  test('products.create throws ProviderUnsupportedError', () => {
    const driver = makeDriver()
    expect(() => driver.products.create({ name: 'x' })).toThrow(ProviderUnsupportedError)
  })

  test('subscriptions.update throws ProviderUnsupportedError (immutable schedules)', () => {
    const driver = makeDriver()
    expect(() => driver.subscriptions.update('sched_x', {})).toThrow(ProviderUnsupportedError)
  })

  test('subscriptions.create rejects non-spec price strings', async () => {
    const driver = makeDriver()
    await expect(
      driver.subscriptions.create({ customer: 'cust_x', price: 'price_xxx' }),
    ).rejects.toThrow(/omisePriceSpec/)
  })

  test('subscriptions.create rejects trialDays (Omise schedules have no trial concept)', async () => {
    const driver = makeDriver()
    await expect(
      driver.subscriptions.create({
        customer: 'cust_x',
        price: 'omise_spec:eyJhIjoxMDAwLCJjIjoidGhiIiwicCI6Im1vbnRoIn0',
        trialDays: 7,
      }),
    ).rejects.toThrow(/trial/i)
  })

  test('subscriptions.list without customer throws ProviderUnsupportedError', async () => {
    const driver = makeDriver()
    await expect(driver.subscriptions.list({})).rejects.toThrow(ProviderUnsupportedError)
  })

  test('checkout.create throws ProviderUnsupportedError', () => {
    const driver = makeDriver()
    expect(() =>
      driver.checkout.create({
        mode: 'payment',
        items: [{ price: 'p' }],
        successUrl: 'http://a',
        cancelUrl: 'http://b',
      }),
    ).toThrow(ProviderUnsupportedError)
  })

  test('paymentMethods.detach throws when customerId omitted', async () => {
    const driver = makeDriver()
    await expect(driver.paymentMethods.detach('card_x')).rejects.toThrow(
      ProviderUnsupportedError,
    )
  })

  test('paymentMethods.detach succeeds when customerId is supplied', async () => {
    const calls: Array<{ customer: string; card: string }> = []
    const driver = new OmisePaymentDriver({
      instanceName: 'omise',
      config: {
        driver: 'omise',
        publicKey: 'pkey_test_x',
        secretKey: 'skey_test_x',
        webhookSecret: SECRET,
        client: {
          customers: {
            destroyCard: async (customer: string, card: string) => {
              calls.push({ customer, card })
              return {
                id: card,
                brand: 'visa',
                last_digits: '4242',
                customer: null,
                created_at: '2026-05-01T00:00:00Z',
              }
            },
          },
        } as never,
      },
    })
    const result = await driver.paymentMethods.detach('card_x', 'cust_y')
    expect(calls).toEqual([{ customer: 'cust_y', card: 'card_x' }])
    expect(result.id).toBe('card_x')
    expect(result.customerId).toBeNull()
  })
})
