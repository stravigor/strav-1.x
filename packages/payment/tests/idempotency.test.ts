/**
 * Slice 7.5 — idempotency keys.
 *
 *   - Stripe driver declares `idempotency` capability and forwards
 *     the key as the SDK's second arg (`{ idempotencyKey }`).
 *   - Omise driver does NOT declare the capability; calls go
 *     through, but the key is silently dropped (no surprise
 *     errors; apps that need dedup build it app-side and check
 *     `driver.capabilities.has('idempotency')` before relying on
 *     it).
 *   - MockDriver declares the capability and round-trips the key,
 *     returning the prior charge on a repeat key.
 */

import { describe, expect, test } from 'bun:test'
import { MockDriver } from '../src/index.ts'
import { StripePaymentDriver } from '../src/drivers/stripe/index.ts'
import { OmisePaymentDriver } from '../src/drivers/omise/index.ts'

describe('Capability flag', () => {
  test('Stripe declares idempotency', () => {
    const driver = new StripePaymentDriver({
      instanceName: 'stripe',
      config: { driver: 'stripe', secret: 'sk_test', client: {} as never },
    })
    expect(driver.capabilities.has('idempotency')).toBe(true)
  })

  test('Omise does NOT declare idempotency', () => {
    const driver = new OmisePaymentDriver({
      instanceName: 'omise',
      config: {
        driver: 'omise',
        publicKey: 'pkey_test',
        secretKey: 'skey_test',
        client: {} as never,
      },
    })
    expect(driver.capabilities.has('idempotency')).toBe(false)
  })

  test('Mock declares idempotency', () => {
    expect(new MockDriver({ instanceName: 'mock' }).capabilities.has('idempotency')).toBe(true)
  })
})

describe('Stripe — forwards idempotencyKey to SDK second arg', () => {
  function makeDriver(captured: { calls: Array<{ method: string; key?: string }> }) {
    function rec<TReturn>(method: string, value: TReturn) {
      return async (_params: unknown, opts?: { idempotencyKey?: string }) => {
        captured.calls.push({ method, key: opts?.idempotencyKey })
        return value as TReturn
      }
    }
    const stub = {
      customers: {
        create: rec('customers.create', {
          id: 'cus_x',
          object: 'customer',
          email: 'a@b.co',
          created: 1_700_000_000,
          metadata: {},
        }),
      },
      paymentIntents: {
        create: rec('paymentIntents.create', {
          id: 'pi_x',
          object: 'payment_intent',
          amount: 1000,
          currency: 'usd',
          status: 'succeeded',
          latest_charge: 'ch_y',
          metadata: {},
          created: 1_700_000_000,
        }),
      },
      charges: {
        retrieve: async () => ({
          id: 'ch_y',
          amount: 1000,
          currency: 'usd',
          status: 'succeeded',
          customer: null,
          payment_method: 'pm_card_visa',
          metadata: {},
          created: 1_700_000_000,
          refunded: false,
          amount_refunded: 0,
          failure_code: null,
          failure_message: null,
        }),
      },
      subscriptions: {
        create: rec('subscriptions.create', {
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
          metadata: {},
        }),
      },
      refunds: {
        create: rec('refunds.create', {
          id: 're_x',
          object: 'refund',
          charge: 'ch_y',
          amount: 1000,
          currency: 'usd',
          status: 'succeeded',
          reason: null,
          created: 1_700_000_000,
        }),
      },
      paymentLinks: {
        create: rec('paymentLinks.create', {
          id: 'plink_x',
          object: 'payment_link',
          url: 'https://buy.stripe.com/test_x',
          active: true,
          metadata: {},
        }),
      },
      checkout: {
        sessions: {
          create: rec('checkout.sessions.create', {
            id: 'cs_x',
            object: 'checkout.session',
            mode: 'payment',
            status: 'open',
            url: 'https://checkout.stripe.com/x',
            created: 1_700_000_000,
            expires_at: 1_700_100_000,
            metadata: {},
          }),
        },
      },
    }
    return new StripePaymentDriver({
      instanceName: 'stripe',
      config: { driver: 'stripe', secret: 'sk_test', client: stub as never },
    })
  }

  test('customers.create', async () => {
    const captured = { calls: [] as Array<{ method: string; key?: string }> }
    const driver = makeDriver(captured)
    await driver.customers.create({ email: 'a@b.co', idempotencyKey: 'k-cust' })
    expect(captured.calls).toEqual([{ method: 'customers.create', key: 'k-cust' }])
  })

  test('charges.create', async () => {
    const captured = { calls: [] as Array<{ method: string; key?: string }> }
    const driver = makeDriver(captured)
    await driver.charges.create({
      amount: 1000,
      currency: 'usd',
      paymentMethod: 'pm_card_visa',
      idempotencyKey: 'k-charge',
    })
    expect(captured.calls.find((c) => c.method === 'paymentIntents.create')?.key).toBe('k-charge')
  })

  test('subscriptions.create', async () => {
    const captured = { calls: [] as Array<{ method: string; key?: string }> }
    const driver = makeDriver(captured)
    await driver.subscriptions.create({
      customer: 'cus_x',
      price: 'price_y',
      idempotencyKey: 'k-sub',
    })
    expect(captured.calls).toEqual([{ method: 'subscriptions.create', key: 'k-sub' }])
  })

  test('charges.refund', async () => {
    const captured = { calls: [] as Array<{ method: string; key?: string }> }
    const driver = makeDriver(captured)
    await driver.charges.refund({ charge: 'ch_y', idempotencyKey: 'k-refund' })
    expect(captured.calls).toEqual([{ method: 'refunds.create', key: 'k-refund' }])
  })

  test('links.create', async () => {
    const captured = { calls: [] as Array<{ method: string; key?: string }> }
    const driver = makeDriver(captured)
    await driver.links.create({
      items: [{ price: 'price_a' }],
      idempotencyKey: 'k-link',
    })
    expect(captured.calls).toEqual([{ method: 'paymentLinks.create', key: 'k-link' }])
  })

  test('checkout.create', async () => {
    const captured = { calls: [] as Array<{ method: string; key?: string }> }
    const driver = makeDriver(captured)
    await driver.checkout.create({
      mode: 'payment',
      items: [{ price: 'price_a' }],
      successUrl: 'https://a/',
      cancelUrl: 'https://b/',
      idempotencyKey: 'k-checkout',
    })
    expect(captured.calls).toEqual([{ method: 'checkout.sessions.create', key: 'k-checkout' }])
  })

  test('no key set → no idempotencyKey on second arg', async () => {
    const captured = { calls: [] as Array<{ method: string; key?: string }> }
    const driver = makeDriver(captured)
    await driver.customers.create({ email: 'a@b.co' })
    expect(captured.calls[0]?.key).toBeUndefined()
  })
})

describe('Omise — silently accepts the key (no dedup guarantee)', () => {
  test('charges.create with idempotencyKey does NOT throw, key is dropped', async () => {
    let recordedCardField: string | undefined
    const stub = {
      charges: {
        create: async (req: Record<string, unknown>) => {
          recordedCardField = req.idempotency_key as string | undefined
          return {
            id: 'chrg_x',
            amount: req.amount as number,
            currency: req.currency as string,
            status: 'successful',
            source: null,
            authorize_uri: null,
            customer: null,
            card: { id: 'card_y', brand: 'visa', last_digits: '4242' },
            refunded: 0,
            failure_code: null,
            failure_message: null,
            metadata: {},
            created_at: '2026-05-15T00:00:00Z',
          }
        },
        retrieve: async (): Promise<never> => { throw new Error('not stubbed') },
        capture: async (): Promise<never> => { throw new Error('not stubbed') },
        createRefund: async (): Promise<never> => { throw new Error('not stubbed') },
      },
    }
    const driver = new OmisePaymentDriver({
      instanceName: 'omise',
      config: {
        driver: 'omise',
        publicKey: 'pkey_test',
        secretKey: 'skey_test',
        client: stub as never,
      },
    })
    const charge = await driver.charges.create({
      amount: 1000,
      currency: 'thb',
      paymentMethod: 'tokn_x',
      idempotencyKey: 'k-omise',
    })
    expect(charge.status).toBe('succeeded')
    // The key never reached the Omise request — driver dropped it
    // because Omise's SDK exposes no header injection point.
    expect(recordedCardField).toBeUndefined()
  })
})

describe('Mock — round-trips key + dedups repeat calls', () => {
  test('repeat charges.create with same key returns the prior charge', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const first = await driver.charges.create({
      amount: 1000,
      currency: 'usd',
      paymentMethod: 'pm_x',
      idempotencyKey: 'k-mock-1',
    })
    const second = await driver.charges.create({
      amount: 1000,
      currency: 'usd',
      paymentMethod: 'pm_x',
      idempotencyKey: 'k-mock-1',
    })
    expect(second.id).toBe(first.id)
  })

  test('different keys produce different charges', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const a = await driver.charges.create({
      amount: 1000,
      currency: 'usd',
      paymentMethod: 'pm_x',
      idempotencyKey: 'k-a',
    })
    const b = await driver.charges.create({
      amount: 1000,
      currency: 'usd',
      paymentMethod: 'pm_x',
      idempotencyKey: 'k-b',
    })
    expect(a.id).not.toBe(b.id)
  })
})
