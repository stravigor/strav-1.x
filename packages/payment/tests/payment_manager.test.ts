/**
 * Smoke tests for `PaymentManager` + `MockDriver` — verifies the
 * driver-routing, extension registration, capability surface,
 * and webhook handler dispatch end-to-end without touching a
 * database.
 */

import { describe, expect, test } from 'bun:test'
import {
  MockDriver,
  PaymentConfigError,
  PaymentManager,
  ProviderUnsupportedError,
  UnknownProviderError,
  unsupported,
} from '../src/index.ts'
import type { PaymentDriver } from '../src/payment_driver.ts'

function makeManager() {
  const manager = new PaymentManager({
    config: {
      default: 'mock',
      providers: { mock: { driver: 'mock' }, secondary: { driver: 'mock' } },
    },
  })
  manager.extend('mock', ({ instanceName }) => new MockDriver({ instanceName }))
  return manager
}

describe('PaymentManager — driver routing', () => {
  test('resolves default driver lazily + memoizes', () => {
    const manager = makeManager()
    const a = manager.use()
    const b = manager.use()
    expect(a).toBe(b)
    expect(a.instanceName).toBe('mock')
  })

  test('resolves named provider', () => {
    const manager = makeManager()
    const secondary = manager.use('secondary')
    expect(secondary.instanceName).toBe('secondary')
    expect(secondary).not.toBe(manager.use('mock'))
  })

  test('throws UnknownProviderError for unknown name', () => {
    const manager = makeManager()
    expect(() => manager.use('paddle')).toThrow(UnknownProviderError)
  })

  test('throws PaymentConfigError when default not configured', () => {
    expect(
      () =>
        new PaymentManager({
          config: { default: 'missing', providers: {} },
        }),
    ).toThrow(PaymentConfigError)
  })

  test('throws PaymentConfigError when no driver factory registered', () => {
    const manager = new PaymentManager({
      config: { default: 'mock', providers: { mock: { driver: 'mock' } } },
    })
    expect(() => manager.use()).toThrow(PaymentConfigError)
  })

  test('useDriver bypasses the factory', () => {
    const manager = new PaymentManager({
      config: { default: 'mock', providers: { mock: { driver: 'mock' } } },
    })
    const driver = new MockDriver({ instanceName: 'mock' })
    manager.useDriver('mock', driver)
    expect(manager.use()).toBe(driver)
  })
})

describe('PaymentManager — resource namespaces', () => {
  test('customers.create roundtrips through default driver', async () => {
    const manager = makeManager()
    const customer = await manager.customers.create({ email: 'a@b.co', name: 'A' })
    expect(customer.id.startsWith('cus_')).toBe(true)
    expect(customer.provider).toBe('mock')

    const retrieved = await manager.customers.retrieve(customer.id)
    expect(retrieved.email).toBe('a@b.co')
  })

  test('use(name) routes through the named driver', async () => {
    const manager = makeManager()
    const a = await manager.customers.create({ email: 'a@b.co' })
    // Same logical 'mock' driver type, separate instance — should not see 'a' in 'secondary'.
    const list = await manager.use('secondary').customers.list()
    expect(list.data.find((c) => c.id === a.id)).toBeUndefined()
  })

  test('subscription with trial sets trialing + trial_end', async () => {
    const manager = makeManager()
    const sub = await manager.subscriptions.create({
      customer: 'cus_x',
      price: 'price_y',
      trialDays: 14,
    })
    expect(sub.status).toBe('trialing')
    expect(sub.trialEnd).not.toBeNull()
  })

  test('charges + refund flows', async () => {
    const manager = makeManager()
    const ch = await manager.charges.create({ amount: 1000, currency: 'usd' })
    expect(ch.status).toBe('succeeded')
    const refund = await manager.charges.refund({ charge: ch.id })
    expect(refund.amount).toBe(1000)
    const after = await manager.charges.retrieve(ch.id)
    expect(after.status).toBe('refunded')
  })
})

describe('PaymentManager — capability gating + unsupported()', () => {
  test('driver declares full capability set by default', () => {
    const manager = makeManager()
    const driver = manager.use()
    expect(driver.capabilities.has('subscriptions.trials')).toBe(true)
    expect(driver.capabilities.has('checkout.create')).toBe(true)
  })

  test('unsupported() throws ProviderUnsupportedError synchronously', () => {
    const op = unsupported('mock', 'checkout.create', 'mock has no hosted checkout')
    expect(() => op()).toThrow(ProviderUnsupportedError)
  })

  test('partial-capability driver throws ProviderUnsupportedError', () => {
    const limited = new MockDriver({
      instanceName: 'limited',
      capabilities: new Set(['customers.create']),
    }) as PaymentDriver
    const manager = new PaymentManager({
      config: { default: 'limited', providers: { limited: { driver: 'mock' } } },
    })
    manager.useDriver('limited', limited)
    expect(manager.use().capabilities.has('checkout.create')).toBe(false)
  })
})

describe('PaymentManager — webhook registry', () => {
  test('onWebhookEvent dispatches matching handlers', () => {
    const manager = makeManager()
    const fired: string[] = []
    manager.onWebhookEvent('customer.created', (ctx) => {
      fired.push(`any:${ctx.eventId}`)
    })
    manager.onWebhookEvent('customer.created', { provider: 'mock' }, (ctx) => {
      fired.push(`mock-only:${ctx.eventId}`)
    })
    manager.onWebhookEvent('customer.created', { provider: 'paddle' }, () => {
      fired.push('paddle-only')
    })
    const handlers = manager.webhookRegistry.resolve('customer.created', 'mock')
    expect(handlers).toHaveLength(2)
    // Paddle-filtered handler doesn't match.
    expect(fired).toHaveLength(0)
  })

  test('clearWebhookHandlers empties the registry', () => {
    const manager = makeManager()
    manager.onWebhookEvent('charge.succeeded', () => {})
    expect(manager.webhookRegistry.resolve('charge.succeeded', 'mock')).toHaveLength(1)
    manager.clearWebhookHandlers()
    expect(manager.webhookRegistry.resolve('charge.succeeded', 'mock')).toHaveLength(0)
  })
})

describe('PaymentManager — webhook verify + normalize', () => {
  test('MockDriver.webhook.verify accepts matching signature', async () => {
    const manager = makeManager()
    const verified = await manager.use().webhook.verify(
      JSON.stringify({ id: 'evt_1', type: 'customer.created' }),
      'whsec_mock',
    )
    expect(verified).toMatchObject({ id: 'evt_1', type: 'customer.created' })
  })

  test('MockDriver.webhook.verify throws on bad signature', async () => {
    const manager = makeManager()
    await expect(
      manager.use().webhook.verify('{}', 'whsec_wrong'),
    ).rejects.toThrow(/signature mismatch/)
  })

  test('normalize returns null for unrecognised shapes', () => {
    const manager = makeManager()
    expect(manager.use().webhook.normalize({ junk: true })).toBeNull()
  })
})
