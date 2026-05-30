/**
 * Slice 7.1 — async payment-method types + capability flags +
 * MockDriver wiring. Real-driver next-action mapping lands in
 * slices 7.2 (Stripe) and 7.3 (Omise); here we verify:
 *
 *   - `paymentMethod` accepts both shapes (string id, structured spec).
 *   - MockDriver produces the right `nextAction` per spec kind.
 *   - Stripe + Omise drivers reject non-card specs with
 *     `ProviderUnsupportedError` (placeholder until 7.2/7.3 wire
 *     them up).
 *   - Capability flags expose the right input + output sets.
 */

import { describe, expect, test } from 'bun:test'
import {
  MockDriver,
  ProviderUnsupportedError,
  extractCardToken,
  paymentMethodKind,
} from '../src/index.ts'
import { StripePaymentDriver } from '../src/drivers/stripe/index.ts'
import { OmisePaymentDriver } from '../src/drivers/omise/index.ts'

describe('payment_method_helpers', () => {
  test('extractCardToken collapses both back-compat shapes', () => {
    expect(extractCardToken('pm_xxx')).toBe('pm_xxx')
    expect(extractCardToken({ kind: 'card', token: 'tokn_yyy' })).toBe('tokn_yyy')
    expect(extractCardToken({ kind: 'promptpay' })).toBeNull()
    expect(extractCardToken(undefined)).toBeNull()
  })

  test('paymentMethodKind classifies each shape', () => {
    expect(paymentMethodKind(undefined)).toBe('unspecified')
    expect(paymentMethodKind('pm_xxx')).toBe('card')
    expect(paymentMethodKind({ kind: 'card', token: 't' })).toBe('card')
    expect(paymentMethodKind({ kind: 'promptpay' })).toBe('promptpay')
    expect(paymentMethodKind({ kind: 'truemoney', phoneNumber: '+66' })).toBe('truemoney')
  })
})

describe('MockDriver — async payment methods', () => {
  test('card spec settles synchronously with no nextAction', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const charge = await driver.charges.create({
      amount: 1000,
      currency: 'usd',
      paymentMethod: { kind: 'card', token: 'tokn_x' },
    })
    expect(charge.status).toBe('succeeded')
    expect(charge.nextAction).toBeNull()
    expect(charge.paymentMethodId).toBe('tokn_x')
  })

  test('string paymentMethod is treated as a card token', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const charge = await driver.charges.create({
      amount: 1000,
      currency: 'usd',
      paymentMethod: 'pm_legacy',
    })
    expect(charge.status).toBe('succeeded')
    expect(charge.paymentMethodId).toBe('pm_legacy')
    expect(charge.nextAction).toBeNull()
  })

  test('promptpay spec produces a display_qr next action', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const charge = await driver.charges.create({
      amount: 39900,
      currency: 'thb',
      paymentMethod: { kind: 'promptpay' },
    })
    expect(charge.status).toBe('requires_action')
    expect(charge.nextAction?.kind).toBe('display_qr')
    if (charge.nextAction?.kind === 'display_qr') {
      expect(charge.nextAction.qrData).toContain('mock-qr:promptpay')
      expect(charge.nextAction.qrImageUrl).toBeDefined()
    }
  })

  test('truemoney spec produces a redirect next action with returnUrl', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const charge = await driver.charges.create({
      amount: 5000,
      currency: 'thb',
      paymentMethod: { kind: 'truemoney', phoneNumber: '+66812345678' },
      returnUrl: 'https://app.example.com/billing/done',
    })
    expect(charge.status).toBe('requires_action')
    expect(charge.nextAction?.kind).toBe('redirect')
    if (charge.nextAction?.kind === 'redirect') {
      expect(charge.nextAction.url).toBe('https://app.example.com/billing/done')
    }
  })

  test('konbini spec produces a voucher next action', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const charge = await driver.charges.create({
      amount: 2500,
      currency: 'jpy',
      paymentMethod: { kind: 'konbini' },
    })
    expect(charge.nextAction?.kind).toBe('voucher')
    if (charge.nextAction?.kind === 'voucher') {
      expect(charge.nextAction.reference).toMatch(/^KON-/)
    }
  })

  test('capture promotes a requires_action charge to succeeded and clears nextAction', async () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    const charge = await driver.charges.create({
      amount: 1000,
      currency: 'usd',
      paymentMethod: 'pm_x',
      capture: false,
    })
    expect(charge.status).toBe('requires_action')
    const captured = await driver.charges.capture(charge.id)
    expect(captured.status).toBe('succeeded')
    expect(captured.nextAction).toBeNull()
  })

  test('declares full method + nextAction capability set by default', () => {
    const driver = new MockDriver({ instanceName: 'mock' })
    for (const cap of [
      'charges.method.card',
      'charges.method.promptpay',
      'charges.method.paynow',
      'charges.method.truemoney',
      'charges.method.alipay',
      'charges.method.wechat_pay',
      'charges.method.konbini',
      'charges.nextAction.display_qr',
      'charges.nextAction.redirect',
      'charges.nextAction.voucher',
      'charges.nextAction.authorize',
    ] as const) {
      expect(driver.capabilities.has(cap)).toBe(true)
    }
  })
})

describe('StripePaymentDriver — rejects non-Stripe-supported methods', () => {
  function makeDriver() {
    return new StripePaymentDriver({
      instanceName: 'stripe',
      config: {
        driver: 'stripe',
        secret: 'sk_test_x',
        // Tests don't reach the network; we only exercise the
        // input-validation branch.
        client: {} as never,
      },
    })
  }

  test('Stripe-only kinds (truemoney / fps / rabbit_linepay) throw', async () => {
    const driver = makeDriver()
    await expect(
      driver.charges.create({
        amount: 1000,
        currency: 'thb',
        paymentMethod: { kind: 'truemoney', phoneNumber: '+66' },
        returnUrl: 'https://app/done',
      }),
    ).rejects.toThrow(ProviderUnsupportedError)
    await expect(
      driver.charges.create({
        amount: 1000,
        currency: 'hkd',
        paymentMethod: { kind: 'fps' },
        returnUrl: 'https://app/done',
      }),
    ).rejects.toThrow(ProviderUnsupportedError)
  })
})

describe('OmisePaymentDriver — rejects non-Omise-supported methods', () => {
  function makeDriver() {
    return new OmisePaymentDriver({
      instanceName: 'omise',
      config: {
        driver: 'omise',
        publicKey: 'pkey_test_x',
        secretKey: 'skey_test_x',
        client: {} as never,
      },
    })
  }

  test('Stripe-only kinds (paynow / konbini / kakaopay / fps) throw', async () => {
    const driver = makeDriver()
    await expect(
      driver.charges.create({
        amount: 1000,
        currency: 'sgd',
        paymentMethod: { kind: 'paynow' },
        returnUrl: 'https://app/done',
      }),
    ).rejects.toThrow(ProviderUnsupportedError)
    await expect(
      driver.charges.create({
        amount: 1000,
        currency: 'jpy',
        paymentMethod: { kind: 'konbini' },
        returnUrl: 'https://app/done',
      }),
    ).rejects.toThrow(ProviderUnsupportedError)
  })
})
