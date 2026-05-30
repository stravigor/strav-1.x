/**
 * Slice 7.2 — Stripe async-method wiring.
 *
 *   - `stripeNextAction` covers every framework-relevant variant
 *     of `Stripe.PaymentIntent.NextAction`.
 *   - `buildStripeMethodWiring` produces the right
 *     `payment_method_data.type` per supported spec kind, and
 *     reports `unsupported` for the rest.
 *   - `StripePaymentDriver.charges.create` round-trips a supported
 *     async spec into a `requires_action` charge with the matching
 *     `nextAction`. Tests use a stub Stripe client so no network
 *     is dialled.
 */

import { describe, expect, test } from 'bun:test'
import type Stripe from 'stripe'
import {
  buildStripeMethodWiring,
  STRIPE_SUPPORTED_METHOD_KINDS,
  StripePaymentDriver,
  stripeNextAction,
} from '../src/drivers/stripe/index.ts'
import { ProviderUnsupportedError } from '../src/index.ts'

describe('stripeNextAction', () => {
  test('maps promptpay_display_qr_code → display_qr', () => {
    const na = {
      type: 'promptpay_display_qr_code',
      promptpay_display_qr_code: {
        data: '00020101...59THB...',
        image_url_png: 'https://stripe.com/q/x.png',
      },
    } as unknown as Stripe.PaymentIntent.NextAction
    const out = stripeNextAction(na)
    expect(out?.kind).toBe('display_qr')
    if (out?.kind === 'display_qr') {
      expect(out.qrData).toBe('00020101...59THB...')
      expect(out.qrImageUrl).toBe('https://stripe.com/q/x.png')
    }
  })

  test('maps paynow_display_qr_code → display_qr', () => {
    const na = {
      type: 'paynow_display_qr_code',
      paynow_display_qr_code: { data: 'SGQR...', image_url_png: 'https://x.png' },
    } as unknown as Stripe.PaymentIntent.NextAction
    expect(stripeNextAction(na)?.kind).toBe('display_qr')
  })

  test('maps wechat_pay_display_qr_code → display_qr', () => {
    const na = {
      type: 'wechat_pay_display_qr_code',
      wechat_pay_display_qr_code: { data: 'weixin://...', image_url_png: 'https://x.png' },
    } as unknown as Stripe.PaymentIntent.NextAction
    expect(stripeNextAction(na)?.kind).toBe('display_qr')
  })

  test('maps alipay_handle_redirect → redirect', () => {
    const na = {
      type: 'alipay_handle_redirect',
      alipay_handle_redirect: { url: 'https://alipay.example/...' },
    } as unknown as Stripe.PaymentIntent.NextAction
    const out = stripeNextAction(na)
    expect(out?.kind).toBe('redirect')
    if (out?.kind === 'redirect') {
      expect(out.url).toBe('https://alipay.example/...')
    }
  })

  test('maps redirect_to_url → redirect (3DS / wallet redirects)', () => {
    const na = {
      type: 'redirect_to_url',
      redirect_to_url: { url: 'https://hooks.stripe.com/redirect/...' },
    } as unknown as Stripe.PaymentIntent.NextAction
    const out = stripeNextAction(na)
    expect(out?.kind).toBe('redirect')
  })

  test('maps konbini_display_details → voucher', () => {
    const na = {
      type: 'konbini_display_details',
      konbini_display_details: {
        expires_at: 1_700_000_000,
        hosted_voucher_url: 'https://invoice.stripe.com/voucher/x',
        stores: {
          familymart: { confirmation_number: '1234-5678' },
          lawson: { confirmation_number: '1234-5678' },
          ministop: { confirmation_number: '1234-5678' },
          seicomart: { confirmation_number: '1234-5678' },
        },
      },
    } as unknown as Stripe.PaymentIntent.NextAction
    const out = stripeNextAction(na)
    expect(out?.kind).toBe('voucher')
    if (out?.kind === 'voucher') {
      expect(out.reference).toBe('1234-5678')
      expect(out.barcodeImageUrl).toContain('invoice.stripe.com')
      expect(out.expiresAt).toBeInstanceOf(Date)
    }
  })

  test('use_stripe_sdk (card 3DS challenge) → authorize', () => {
    const na = { type: 'use_stripe_sdk' } as unknown as Stripe.PaymentIntent.NextAction
    expect(stripeNextAction(na)?.kind).toBe('authorize')
  })

  test('returns null for missing next_action', () => {
    expect(stripeNextAction(null)).toBeNull()
    expect(stripeNextAction(undefined)).toBeNull()
  })
})

describe('buildStripeMethodWiring', () => {
  test('card spec → card_token (caller passes payment_method directly)', () => {
    expect(buildStripeMethodWiring({ kind: 'card', token: 'pm_x' })).toEqual({
      kind: 'card_token',
    })
  })

  test('promptpay spec → wired with payment_method_data.type=promptpay', () => {
    const r = buildStripeMethodWiring({ kind: 'promptpay' })
    expect(r.kind).toBe('wired')
    if (r.kind === 'wired') {
      expect(r.wiring.payment_method_data.type).toBe('promptpay')
    }
  })

  test('wechat_pay adds payment_method_options.wechat_pay.client', () => {
    const r = buildStripeMethodWiring({ kind: 'wechat_pay' })
    expect(r.kind).toBe('wired')
    if (r.kind === 'wired') {
      expect(r.wiring.payment_method_data.type).toBe('wechat_pay')
      expect(r.wiring.payment_method_options).toBeDefined()
    }
  })

  test('truemoney → unsupported (Omise only)', () => {
    expect(buildStripeMethodWiring({ kind: 'truemoney', phoneNumber: '+66' })).toEqual({
      kind: 'unsupported',
    })
  })

  test('fps → unsupported (Omise only)', () => {
    expect(buildStripeMethodWiring({ kind: 'fps' })).toEqual({ kind: 'unsupported' })
  })

  test('rabbit_linepay → unsupported (Omise only)', () => {
    expect(buildStripeMethodWiring({ kind: 'rabbit_linepay' })).toEqual({
      kind: 'unsupported',
    })
  })

  test('declares 8 supported kinds', () => {
    expect(STRIPE_SUPPORTED_METHOD_KINDS).toContain('card')
    expect(STRIPE_SUPPORTED_METHOD_KINDS).toContain('promptpay')
    expect(STRIPE_SUPPORTED_METHOD_KINDS).toContain('konbini')
    expect(STRIPE_SUPPORTED_METHOD_KINDS).not.toContain('truemoney')
    expect(STRIPE_SUPPORTED_METHOD_KINDS).not.toContain('fps')
  })
})

describe('StripePaymentDriver — charges.create with async specs', () => {
  function makeDriver(capturedIntent: { last?: Record<string, unknown> }, intentResponse: Record<string, unknown>) {
    const stub = {
      paymentIntents: {
        create: async (params: Record<string, unknown>) => {
          capturedIntent.last = params
          return intentResponse
        },
      },
      charges: {
        retrieve: async (id: string) => ({
          id,
          object: 'charge',
          amount: 39900,
          amount_refunded: 0,
          refunded: false,
          currency: 'thb',
          status: 'succeeded',
          customer: 'cus_y',
          payment_method: 'pm_card_visa',
          failure_code: null,
          failure_message: null,
          metadata: {},
          created: 1_700_000_000,
        }),
      },
    }
    return new StripePaymentDriver({
      instanceName: 'stripe',
      config: { driver: 'stripe', secret: 'sk_test_x', client: stub as never },
    })
  }

  test('promptpay routes through payment_method_data and surfaces a display_qr next action', async () => {
    const captured: { last?: Record<string, unknown> } = {}
    const driver = makeDriver(captured, {
      id: 'pi_x',
      object: 'payment_intent',
      amount: 39900,
      currency: 'thb',
      customer: null,
      payment_method: null,
      status: 'requires_action',
      metadata: {},
      created: 1_700_000_000,
      next_action: {
        type: 'promptpay_display_qr_code',
        promptpay_display_qr_code: { data: '0002...59THB', image_url_png: 'https://x.png' },
      },
    })
    const charge = await driver.charges.create({
      amount: 39900,
      currency: 'thb',
      paymentMethod: { kind: 'promptpay' },
      returnUrl: 'https://app.example.com/done',
    })
    const data = captured.last?.payment_method_data as { type: string } | undefined
    expect(data?.type).toBe('promptpay')
    expect(captured.last?.return_url).toBe('https://app.example.com/done')
    expect(charge.status).toBe('requires_action')
    expect(charge.nextAction?.kind).toBe('display_qr')
  })

  test('wechat_pay routes payment_method_options.wechat_pay.client = web', async () => {
    const captured: { last?: Record<string, unknown> } = {}
    const driver = makeDriver(captured, {
      id: 'pi_x',
      object: 'payment_intent',
      amount: 1000,
      currency: 'cny',
      status: 'requires_action',
      metadata: {},
      created: 1_700_000_000,
      next_action: {
        type: 'wechat_pay_display_qr_code',
        wechat_pay_display_qr_code: { data: 'weixin://x', image_url_png: 'https://x.png' },
      },
    })
    await driver.charges.create({
      amount: 1000,
      currency: 'cny',
      paymentMethod: { kind: 'wechat_pay' },
      returnUrl: 'https://app.example.com/done',
    })
    const opts = captured.last?.payment_method_options as { wechat_pay?: { client?: string } } | undefined
    expect(opts?.wechat_pay?.client).toBe('web')
  })

  test('konbini surfaces voucher reference + hosted URL', async () => {
    const driver = makeDriver({}, {
      id: 'pi_x',
      object: 'payment_intent',
      amount: 2500,
      currency: 'jpy',
      status: 'requires_action',
      metadata: {},
      created: 1_700_000_000,
      next_action: {
        type: 'konbini_display_details',
        konbini_display_details: {
          expires_at: 1_700_500_000,
          hosted_voucher_url: 'https://invoice.stripe.com/voucher/x',
          stores: { familymart: { confirmation_number: '1234-5678' } },
        },
      },
    })
    const charge = await driver.charges.create({
      amount: 2500,
      currency: 'jpy',
      paymentMethod: { kind: 'konbini' },
      returnUrl: 'https://app.example.com/done',
    })
    expect(charge.nextAction?.kind).toBe('voucher')
    if (charge.nextAction?.kind === 'voucher') {
      expect(charge.nextAction.reference).toBe('1234-5678')
    }
  })

  test('async method without returnUrl throws ProviderUnsupportedError', async () => {
    const driver = makeDriver({}, {})
    await expect(
      driver.charges.create({
        amount: 39900,
        currency: 'thb',
        paymentMethod: { kind: 'promptpay' },
      }),
    ).rejects.toThrow(/returnUrl/)
  })

  test('truemoney throws (Omise-only method)', async () => {
    const driver = makeDriver({}, {})
    await expect(
      driver.charges.create({
        amount: 5000,
        currency: 'thb',
        paymentMethod: { kind: 'truemoney', phoneNumber: '+66812345678' },
        returnUrl: 'https://app.example.com/done',
      }),
    ).rejects.toThrow(ProviderUnsupportedError)
  })

  test('card token still works (back-compat)', async () => {
    const captured: { last?: Record<string, unknown> } = {}
    const driver = makeDriver(captured, {
      id: 'pi_x',
      object: 'payment_intent',
      amount: 1000,
      currency: 'usd',
      status: 'succeeded',
      latest_charge: 'ch_y',
      metadata: {},
      created: 1_700_000_000,
    })
    const charge = await driver.charges.create({
      amount: 1000,
      currency: 'usd',
      paymentMethod: 'pm_card_visa',
    })
    expect(captured.last?.payment_method).toBe('pm_card_visa')
    expect(charge.status).toBe('succeeded')
    expect(charge.nextAction).toBeNull()
  })

  test('declares the right capability set', () => {
    const driver = makeDriver({}, {})
    expect(driver.capabilities.has('charges.method.card')).toBe(true)
    expect(driver.capabilities.has('charges.method.promptpay')).toBe(true)
    expect(driver.capabilities.has('charges.method.konbini')).toBe(true)
    expect(driver.capabilities.has('charges.method.truemoney')).toBe(false)
    expect(driver.capabilities.has('charges.method.fps')).toBe(false)
    expect(driver.capabilities.has('charges.nextAction.display_qr')).toBe(true)
    expect(driver.capabilities.has('charges.nextAction.voucher')).toBe(true)
  })
})
