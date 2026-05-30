/**
 * Billable mixin tests — exercise the customer / charge / subscription
 * helpers against `MockDriver` + a stubbed `PaymentLedger`. No DB.
 */

import { describe, expect, test } from 'bun:test'
import { Billable, billable, MockDriver, PaymentManager } from '../src/index.ts'
import type { PaymentLedger } from '../src/ledger/payment_ledger.ts'
import type {
  PaymentInvoiceRow,
  PaymentSubscriptionRow,
} from '../src/ledger/payment_ledger_models.ts'

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

/** Tiny stand-in for `PaymentLedger` — only the methods Billable touches. */
function makeLedger(
  seed: {
    subscriptions?: Partial<PaymentSubscriptionRow>[]
    invoices?: Partial<PaymentInvoiceRow>[]
  } = {},
): PaymentLedger {
  return {
    async subscriptionsForCustomer(_provider: string, _cid: string) {
      return (seed.subscriptions ?? []) as PaymentSubscriptionRow[]
    },
    async invoicesForCustomer(_provider: string, _cid: string, _opts?: { limit?: number }) {
      return (seed.invoices ?? []) as PaymentInvoiceRow[]
    },
  } as unknown as PaymentLedger
}

class User extends Billable {
  constructor(public id: string) {
    super()
  }
}

describe('Billable — default storage (payment_customers jsonb)', () => {
  test('paymentCustomerId returns stored id, undefined when absent', () => {
    const u = new User('u_1')
    expect(u.paymentCustomerId('mock')).toBeUndefined()
    u.setPaymentCustomerId('mock', 'cus_1')
    expect(u.paymentCustomerId('mock')).toBe('cus_1')
    expect(u.payment_customers).toEqual({ mock: 'cus_1' })
  })

  test('setPaymentCustomerId merges across providers', () => {
    const u = new User('u_1')
    u.setPaymentCustomerId('mock', 'cus_mock')
    u.setPaymentCustomerId('secondary', 'cus_sec')
    expect(u.payment_customers).toEqual({ mock: 'cus_mock', secondary: 'cus_sec' })
  })
})

describe('Billable — customer / createCustomer / customerOrCreate', () => {
  test('customer() returns null when no id is stored', async () => {
    const manager = makeManager()
    const u = new User('u_1')
    expect(await u.customer(manager)).toBeNull()
  })

  test('createCustomer creates via the manager AND persists the id', async () => {
    const manager = makeManager()
    const u = new User('u_1')
    const created = await u.createCustomer(manager, { email: 'a@b.co', name: 'A' })
    expect(created.id).toMatch(/^cus_/)
    expect(u.paymentCustomerId('mock')).toBe(created.id)
  })

  test('customerOrCreate is idempotent — second call retrieves, not re-creates', async () => {
    const manager = makeManager()
    const u = new User('u_1')
    const first = await u.customerOrCreate(manager, { email: 'a@b.co' })
    const second = await u.customerOrCreate(manager, { email: 'a@b.co' })
    expect(second.id).toBe(first.id)
  })

  test('per-provider isolation — different providers get separate ids', async () => {
    const manager = makeManager()
    const u = new User('u_1')
    await u.createCustomer(manager, { email: 'a@b.co' }) // default = mock
    await u.createCustomer(manager, { email: 'a@b.co' }, 'secondary')
    expect(u.paymentCustomerId('mock')).toBeDefined()
    expect(u.paymentCustomerId('secondary')).toBeDefined()
    expect(u.paymentCustomerId('mock')).not.toBe(u.paymentCustomerId('secondary'))
  })
})

describe('Billable — charge() / subscribe() inject customer id', () => {
  test('charge() throws when no customer id is stored', async () => {
    const manager = makeManager()
    const u = new User('u_1')
    await expect(u.charge(manager, { amount: 100, currency: 'usd' })).rejects.toThrow(
      /no customer id stored/i,
    )
  })

  test('charge() injects stored customer id', async () => {
    const manager = makeManager()
    const u = new User('u_1')
    await u.createCustomer(manager, { email: 'a@b.co' })
    const charge = await u.charge(manager, {
      amount: 4900,
      currency: 'usd',
      paymentMethod: 'pm_card',
    })
    expect(charge.amount).toBe(4900)
    expect(charge.customerId).toBe(u.paymentCustomerId('mock') ?? '')
  })

  test('subscribe() injects stored customer id', async () => {
    const manager = makeManager()
    const u = new User('u_1')
    await u.createCustomer(manager, { email: 'a@b.co' })
    const sub = await u.subscribe(manager, { price: 'price_1' })
    expect(sub.customerId).toBe(u.paymentCustomerId('mock') ?? '')
  })
})

describe('Billable — ledger reads', () => {
  test('subscriptions() returns [] when no customer id is stored', async () => {
    const u = new User('u_1')
    const subs = await u.subscriptions(makeLedger(), 'mock')
    expect(subs).toEqual([])
  })

  test('invoices() returns [] when no customer id is stored', async () => {
    const u = new User('u_1')
    expect(await u.invoices(makeLedger(), 'mock')).toEqual([])
  })

  test('subscriptions() proxies to PaymentLedger.subscriptionsForCustomer', async () => {
    const u = new User('u_1')
    u.setPaymentCustomerId('mock', 'cus_1')
    const ledger = makeLedger({
      subscriptions: [{ id: 's_1', status: 'active', price_provider_id: 'price_pro' }],
    })
    const subs = await u.subscriptions(ledger, 'mock')
    expect(subs).toHaveLength(1)
    expect(subs[0]!.status).toBe('active')
  })

  test('hasActiveSubscription — true for active, trialing, past_due; false otherwise', async () => {
    const u = new User('u_1')
    u.setPaymentCustomerId('mock', 'cus_1')

    for (const status of ['active', 'trialing', 'past_due']) {
      const ledger = makeLedger({ subscriptions: [{ status, price_provider_id: 'p' }] })
      expect(await u.hasActiveSubscription(ledger, 'mock')).toBe(true)
    }
    for (const status of ['canceled', 'incomplete', 'incomplete_expired']) {
      const ledger = makeLedger({ subscriptions: [{ status, price_provider_id: 'p' }] })
      expect(await u.hasActiveSubscription(ledger, 'mock')).toBe(false)
    }
  })

  test('subscribedToPrice — matches active subscription on the given price id', async () => {
    const u = new User('u_1')
    u.setPaymentCustomerId('mock', 'cus_1')
    const ledger = makeLedger({
      subscriptions: [
        { status: 'active', price_provider_id: 'price_pro' },
        { status: 'canceled', price_provider_id: 'price_team' },
      ],
    })
    expect(await u.subscribedToPrice(ledger, 'price_pro', 'mock')).toBe(true)
    expect(await u.subscribedToPrice(ledger, 'price_team', 'mock')).toBe(false)
    expect(await u.subscribedToPrice(ledger, 'price_unknown', 'mock')).toBe(false)
  })
})

describe('Billable — mixin form', () => {
  // Simulate an app that already extends a base class.
  class AppBase {
    public createdBy = 'app'
    constructor(public id: string) {}
    audit(): string {
      return `${this.createdBy}:${this.id}`
    }
  }

  test('billable(AppBase) returns a class with both AppBase + Billable methods', async () => {
    const Mixed = billable(AppBase)
    const u = new Mixed('u_1')
    expect(u.audit()).toBe('app:u_1') // base method preserved
    expect(u.paymentCustomerId('mock')).toBeUndefined() // Billable method present
    expect(typeof u.charge).toBe('function')

    // Default storage works through the mixin.
    u.setPaymentCustomerId('mock', 'cus_1')
    expect(u.paymentCustomerId('mock')).toBe('cus_1')
  })

  test('mixin form charges through the manager identically to the base form', async () => {
    const Mixed = billable(AppBase)
    const u = new Mixed('u_1')
    const manager = makeManager()
    await u.createCustomer(manager, { email: 'a@b.co' })
    const charge = await u.charge(manager, { amount: 100, currency: 'usd', paymentMethod: 'pm' })
    expect(charge.customerId).toBe(u.paymentCustomerId('mock') ?? '')
  })

  test('subclass override of storage hooks routes through custom field', async () => {
    class UserWithSingleColumn extends billable(AppBase) {
      stripe_customer_id: string | null = null
      override paymentCustomerId(provider: string): string | undefined {
        return provider === 'mock' ? (this.stripe_customer_id ?? undefined) : undefined
      }
      override setPaymentCustomerId(provider: string, id: string): void {
        if (provider === 'mock') this.stripe_customer_id = id
      }
    }

    const u = new UserWithSingleColumn('u_1')
    const manager = makeManager()
    await u.createCustomer(manager, { email: 'a@b.co' })
    expect(u.stripe_customer_id).toMatch(/^cus_/)
    // The default jsonb field stays unset.
    expect((u as unknown as { payment_customers?: unknown }).payment_customers).toBeUndefined()
  })
})
