/**
 * Slice 7.4 — `payment.links.*` resource.
 *
 *   - MockDriver: round-trips create / retrieve / list / deactivate.
 *   - StripePaymentDriver: requires `items` (Price ids); rejects
 *     ad-hoc amount; deactivate flips `active: false`.
 *   - OmisePaymentDriver: requires amount+currency+title+description;
 *     rejects `items`; deactivate throws ProviderUnsupportedError.
 */

import { describe, expect, test } from 'bun:test'
import {
  MockDriver,
  PaymentManager,
  ProviderUnsupportedError,
} from '../src/index.ts'
import { StripePaymentDriver } from '../src/stripe/index.ts'
import { OmisePaymentDriver } from '../src/omise/index.ts'

describe('PaymentManager — payment.links accessor', () => {
  test('routes to the default driver', async () => {
    const manager = new PaymentManager({
      config: { default: 'mock', providers: { mock: { driver: 'mock' } } },
    })
    manager.extend('mock', ({ instanceName }) => new MockDriver({ instanceName }))
    const link = await manager.links.create({ amount: 1000, currency: 'usd' })
    expect(link.id.startsWith('plink_')).toBe(true)
    expect(link.url).toContain('mock.payment/link/')
  })

  test('exposes links capability flags', () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    expect(driver.capabilities.has('links.create')).toBe(true)
    expect(driver.capabilities.has('links.deactivate')).toBe(true)
  })
})

describe('MockDriver — links lifecycle', () => {
  test('create + retrieve round-trip', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const link = await driver.links.create({
      amount: 1000,
      currency: 'usd',
      title: 'Coffee mug',
      reusable: false,
    })
    expect(link.amount).toBe(1000)
    expect(link.reusable).toBe(false)
    expect(link.active).toBe(true)
    const fetched = await driver.links.retrieve(link.id)
    expect(fetched.id).toBe(link.id)
  })

  test('deactivate flips active', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const link = await driver.links.create({ amount: 500, currency: 'usd' })
    const after = await driver.links.deactivate(link.id)
    expect(after.active).toBe(false)
  })

  test('list returns every link', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    await driver.links.create({ amount: 100, currency: 'usd' })
    await driver.links.create({ amount: 200, currency: 'usd' })
    const page = await driver.links.list()
    expect(page.data.length).toBeGreaterThanOrEqual(2)
  })
})

describe('StripePaymentDriver — links', () => {
  function makeDriver(captured: { lastCreate?: Record<string, unknown>; lastUpdate?: { id: string; params: Record<string, unknown> } }) {
    const stub = {
      paymentLinks: {
        create: async (params: Record<string, unknown>) => {
          captured.lastCreate = params
          return { id: 'plink_x', object: 'payment_link', url: 'https://buy.stripe.com/test_x', active: true, metadata: {} }
        },
        update: async (id: string, params: Record<string, unknown>) => {
          captured.lastUpdate = { id, params }
          return { id, object: 'payment_link', url: 'https://buy.stripe.com/test_x', active: false, metadata: {} }
        },
        retrieve: async (id: string) => ({ id, object: 'payment_link', url: 'https://buy.stripe.com/test_x', active: true, metadata: {} }),
        list: async () => ({ data: [{ id: 'plink_x', object: 'payment_link', url: 'https://buy.stripe.com/test_x', active: true, metadata: {} }], has_more: false }),
      },
    }
    return new StripePaymentDriver({
      instanceName: 'stripe',
      config: { driver: 'stripe', secret: 'sk_test', client: stub as never },
    })
  }

  test('requires items — rejects ad-hoc amount with ProviderUnsupportedError', async () => {
    const driver = makeDriver({})
    await expect(
      driver.links.create({ amount: 1000, currency: 'usd' }),
    ).rejects.toThrow(/items/)
  })

  test('with items, passes line_items with quantity default 1', async () => {
    const captured: { lastCreate?: Record<string, unknown> } = {}
    const driver = makeDriver(captured)
    await driver.links.create({ items: [{ price: 'price_xxx' }] })
    const li = captured.lastCreate?.line_items as Array<{ price: string; quantity: number }> | undefined
    expect(li?.[0]?.price).toBe('price_xxx')
    expect(li?.[0]?.quantity).toBe(1)
  })

  test('afterCompletionRedirect maps to after_completion.redirect.url', async () => {
    const captured: { lastCreate?: Record<string, unknown> } = {}
    const driver = makeDriver(captured)
    await driver.links.create({
      items: [{ price: 'price_xxx', quantity: 2 }],
      afterCompletionRedirect: 'https://app.example.com/thanks',
    })
    const after = captured.lastCreate?.after_completion as { type: string; redirect: { url: string } } | undefined
    expect(after?.type).toBe('redirect')
    expect(after?.redirect.url).toBe('https://app.example.com/thanks')
  })

  test('deactivate calls update with active:false', async () => {
    const captured: { lastUpdate?: { id: string; params: Record<string, unknown> } } = {}
    const driver = makeDriver(captured)
    const after = await driver.links.deactivate('plink_x')
    expect(captured.lastUpdate?.id).toBe('plink_x')
    expect(captured.lastUpdate?.params.active).toBe(false)
    expect(after.active).toBe(false)
  })

  test('declares both link capabilities', () => {
    const driver = makeDriver({})
    expect(driver.capabilities.has('links.create')).toBe(true)
    expect(driver.capabilities.has('links.deactivate')).toBe(true)
  })
})

describe('OmisePaymentDriver — links', () => {
  function makeDriver(captured: { lastCreate?: Record<string, unknown> }) {
    const stub = {
      links: {
        create: async (params: Record<string, unknown>) => {
          captured.lastCreate = params
          return {
            id: 'link_x',
            amount: params.amount as number,
            currency: params.currency as string,
            title: params.title as string,
            description: params.description as string,
            used: false,
            multiple: (params.multiple as boolean | undefined) ?? false,
            payment_uri: 'https://pay.omise.co/link_x',
            created_at: '2026-05-15T00:00:00Z',
          }
        },
        retrieve: async (id: string) => ({
          id,
          amount: 1000,
          currency: 'thb',
          title: 'x',
          description: 'y',
          used: false,
          multiple: false,
          payment_uri: 'https://pay.omise.co/' + id,
          created_at: '2026-05-15T00:00:00Z',
        }),
        list: async () => ({
          data: [
            {
              id: 'link_used',
              amount: 1000,
              currency: 'thb',
              title: 'x',
              description: 'y',
              used: true,
              multiple: false,
              payment_uri: 'https://pay.omise.co/link_used',
              created_at: '2026-05-01T00:00:00Z',
            },
          ],
        }),
      },
    }
    return new OmisePaymentDriver({
      instanceName: 'omise',
      config: {
        driver: 'omise',
        publicKey: 'pkey_test',
        secretKey: 'skey_test',
        client: stub as never,
      },
    })
  }

  test('rejects items input (no Prices catalogue)', async () => {
    const driver = makeDriver({})
    await expect(
      driver.links.create({ items: [{ price: 'price_xxx' }] }),
    ).rejects.toThrow(/items/)
  })

  test('requires amount + currency + title + description', async () => {
    const driver = makeDriver({})
    await expect(
      driver.links.create({ amount: 1000, currency: 'thb' }),
    ).rejects.toThrow(/title/)
    await expect(
      driver.links.create({ amount: 1000, currency: 'thb', title: 'X' }),
    ).rejects.toThrow(/description/)
  })

  test('happy path: passes amount/currency/title/description through', async () => {
    const captured: { lastCreate?: Record<string, unknown> } = {}
    const driver = makeDriver(captured)
    const link = await driver.links.create({
      amount: 39900,
      currency: 'thb',
      title: 'Pro plan',
      description: 'Monthly billing',
    })
    expect(captured.lastCreate?.amount).toBe(39900)
    expect(captured.lastCreate?.title).toBe('Pro plan')
    expect(link.url).toBe('https://pay.omise.co/link_x')
    expect(link.reusable).toBe(false)
  })

  test('reusable maps to multiple', async () => {
    const captured: { lastCreate?: Record<string, unknown> } = {}
    const driver = makeDriver(captured)
    await driver.links.create({
      amount: 100,
      currency: 'thb',
      title: 'x',
      description: 'y',
      reusable: true,
    })
    expect(captured.lastCreate?.multiple).toBe(true)
  })

  test('list maps used && !multiple → active: false', async () => {
    const driver = makeDriver({})
    const page = await driver.links.list()
    expect(page.data[0]?.active).toBe(false)
  })

  test('deactivate throws ProviderUnsupportedError (no Omise endpoint)', async () => {
    const driver = makeDriver({})
    await expect(driver.links.deactivate('link_x')).rejects.toThrow(
      ProviderUnsupportedError,
    )
  })

  test('declares links.create but not links.deactivate', () => {
    const driver = makeDriver({})
    expect(driver.capabilities.has('links.create')).toBe(true)
    expect(driver.capabilities.has('links.deactivate')).toBe(false)
  })
})
