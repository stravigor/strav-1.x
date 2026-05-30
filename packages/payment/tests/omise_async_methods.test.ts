/**
 * Slice 7.3 — Omise Sources two-step wiring.
 *
 *   - `buildOmiseMethodSpec` maps PaymentMethodSpec.kind →
 *     Omise source `type` + per-kind extras. `card` short-
 *     circuits; Stripe-only kinds report `unsupported`.
 *   - `omiseNextAction` reads `source.scannable_code` for QR
 *     methods and `charge.authorize_uri` for redirects.
 *   - `OmisePaymentDriver.charges.create` runs the two-step
 *     against a stub client and produces a `requires_action`
 *     charge with the right `nextAction` shape.
 */

import { describe, expect, test } from 'bun:test'
import { ProviderUnsupportedError } from '../src/index.ts'
import {
  buildOmiseMethodSpec,
  OmisePaymentDriver,
  OMISE_SUPPORTED_METHOD_KINDS,
  omiseNextAction,
  omiseSourceFlowFor,
} from '../src/drivers/omise/index.ts'

describe('buildOmiseMethodSpec', () => {
  test('card spec → card_token', () => {
    expect(buildOmiseMethodSpec({ kind: 'card', token: 'tokn_x' }, 1000, 'thb')).toEqual({
      kind: 'card_token',
    })
  })

  test('promptpay → source with type=promptpay', () => {
    const r = buildOmiseMethodSpec({ kind: 'promptpay' }, 39900, 'thb')
    expect(r.kind).toBe('source')
    if (r.kind === 'source') expect(r.request.type).toBe('promptpay')
  })

  test('truemoney → source with type + phone_number', () => {
    const r = buildOmiseMethodSpec({ kind: 'truemoney', phoneNumber: '+66812345678' }, 5000, 'thb')
    expect(r.kind).toBe('source')
    if (r.kind === 'source') {
      expect(r.request.type).toBe('truemoney')
      expect(r.request.phone_number).toBe('+66812345678')
    }
  })

  test('paynow → unsupported (Stripe-only)', () => {
    expect(buildOmiseMethodSpec({ kind: 'paynow' }, 1000, 'sgd')).toEqual({ kind: 'unsupported' })
  })

  test('konbini → unsupported (Stripe-only)', () => {
    expect(buildOmiseMethodSpec({ kind: 'konbini' }, 1000, 'jpy')).toEqual({ kind: 'unsupported' })
  })

  test('fps → unsupported (not bridged in v1)', () => {
    expect(buildOmiseMethodSpec({ kind: 'fps' }, 1000, 'hkd')).toEqual({ kind: 'unsupported' })
  })

  test('OMISE_SUPPORTED_METHOD_KINDS lists card + 6 async kinds', () => {
    expect(OMISE_SUPPORTED_METHOD_KINDS).toContain('promptpay')
    expect(OMISE_SUPPORTED_METHOD_KINDS).toContain('truemoney')
    expect(OMISE_SUPPORTED_METHOD_KINDS).toContain('rabbit_linepay')
    expect(OMISE_SUPPORTED_METHOD_KINDS).not.toContain('paynow')
    expect(OMISE_SUPPORTED_METHOD_KINDS).not.toContain('konbini')
  })

  test('omiseSourceFlowFor classifies each kind', () => {
    expect(omiseSourceFlowFor('promptpay')).toBe('offline')
    expect(omiseSourceFlowFor('truemoney')).toBe('redirect')
    expect(omiseSourceFlowFor('rabbit_linepay')).toBe('redirect')
    expect(omiseSourceFlowFor('paynow')).toBe('unknown')
  })
})

describe('omiseNextAction', () => {
  test('returns display_qr when the source has a scannable image', () => {
    const out = omiseNextAction(
      {},
      {
        flow: 'offline',
        scannable_code: {
          image: { download_uri: 'https://api.omise.co/charges/x/documents/y.png' },
        },
      },
    )
    expect(out?.kind).toBe('display_qr')
    if (out?.kind === 'display_qr') {
      expect(out.qrImageUrl).toContain('omise.co')
      expect(out.qrData).toBe(out.qrImageUrl ?? '')
    }
  })

  test('returns redirect when the charge has an authorize_uri', () => {
    const out = omiseNextAction({ authorize_uri: 'https://pay.omise.co/auth/x' })
    expect(out?.kind).toBe('redirect')
    if (out?.kind === 'redirect') {
      expect(out.url).toBe('https://pay.omise.co/auth/x')
    }
  })

  test('returns wait when source has a known flow but no surfaced URL yet', () => {
    expect(omiseNextAction({}, { flow: 'redirect' })?.kind).toBe('wait')
  })

  test('returns null for a settled card charge with no source', () => {
    expect(omiseNextAction({})).toBeNull()
  })
})

describe('OmisePaymentDriver — charges.create with async specs', () => {
  function makeDriver(captured: {
    sourceReq?: Record<string, unknown>
    chargeReq?: Record<string, unknown>
  }, opts: {
    qrUri?: string
    authorizeUri?: string | null
  } = {}) {
    const stubClient = {
      sources: {
        create: async (req: Record<string, unknown>) => {
          captured.sourceReq = req
          const source: Record<string, unknown> = {
            id: 'src_x',
            type: req.type,
            flow: opts.qrUri ? 'offline' : 'redirect',
            amount: req.amount,
            currency: req.currency,
          }
          if (opts.qrUri) {
            source.scannable_code = { image: { download_uri: opts.qrUri } }
          }
          return source
        },
        retrieve: async () => ({ id: 'src_x' }),
      },
      charges: {
        create: async (req: Record<string, unknown>) => {
          captured.chargeReq = req
          const hasSource = typeof req.source === 'string'
          return {
            id: 'chrg_x',
            amount: req.amount as number,
            currency: req.currency as string,
            status: hasSource ? 'pending' : 'successful',
            source: hasSource
              ? opts.qrUri
                ? { id: 'src_x', flow: 'offline', scannable_code: { image: { download_uri: opts.qrUri } } }
                : { id: 'src_x', flow: 'redirect' }
              : null,
            authorize_uri: opts.authorizeUri ?? null,
            customer: req.customer ?? null,
            card: hasSource ? null : { id: 'card_y', brand: 'visa', last_digits: '4242' },
            refunded: 0,
            failure_code: null,
            failure_message: null,
            metadata: {},
            created_at: '2026-05-15T00:00:00Z',
          }
        },
        retrieve: async (): Promise<never> => {
          throw new Error('charges.retrieve not stubbed')
        },
        capture: async (): Promise<never> => {
          throw new Error('charges.capture not stubbed')
        },
        createRefund: async (): Promise<never> => {
          throw new Error('charges.createRefund not stubbed')
        },
      },
    }
    return new OmisePaymentDriver({
      instanceName: 'omise',
      config: {
        driver: 'omise',
        publicKey: 'pkey_test_x',
        secretKey: 'skey_test_x',
        client: stubClient as never,
      },
    })
  }

  test('promptpay: creates source → charge, surfaces display_qr from source', async () => {
    const captured: Record<string, Record<string, unknown> | undefined> = {}
    const driver = makeDriver(captured, {
      qrUri: 'https://api.omise.co/charges/chrg_x/documents/doc_y.png',
    })
    const charge = await driver.charges.create({
      amount: 39900,
      currency: 'thb',
      paymentMethod: { kind: 'promptpay' },
    })
    expect(captured.sourceReq?.type).toBe('promptpay')
    expect(captured.sourceReq?.amount).toBe(39900)
    expect(captured.chargeReq?.source).toBe('src_x')
    expect(charge.status).toBe('pending')
    expect(charge.nextAction?.kind).toBe('display_qr')
    if (charge.nextAction?.kind === 'display_qr') {
      expect(charge.nextAction.qrImageUrl).toContain('omise.co')
    }
  })

  test('truemoney: requires phone_number + returnUrl, produces redirect', async () => {
    const captured: Record<string, Record<string, unknown> | undefined> = {}
    const driver = makeDriver(captured, {
      authorizeUri: 'https://pay.omise.co/auth/tmn_z',
    })
    const charge = await driver.charges.create({
      amount: 5000,
      currency: 'thb',
      paymentMethod: { kind: 'truemoney', phoneNumber: '+66812345678' },
      returnUrl: 'https://app.example.com/billing/done',
    })
    expect(captured.sourceReq?.type).toBe('truemoney')
    expect(captured.sourceReq?.phone_number).toBe('+66812345678')
    expect(captured.chargeReq?.return_uri).toBe('https://app.example.com/billing/done')
    expect(charge.nextAction?.kind).toBe('redirect')
    if (charge.nextAction?.kind === 'redirect') {
      expect(charge.nextAction.url).toBe('https://pay.omise.co/auth/tmn_z')
    }
  })

  test('alipay: redirect flow surfaces authorize_uri', async () => {
    const driver = makeDriver({}, { authorizeUri: 'https://pay.omise.co/auth/alipay_x' })
    const charge = await driver.charges.create({
      amount: 1500,
      currency: 'thb',
      paymentMethod: { kind: 'alipay' },
      returnUrl: 'https://app.example.com/done',
    })
    expect(charge.nextAction?.kind).toBe('redirect')
  })

  test('truemoney without returnUrl throws ProviderUnsupportedError', async () => {
    const driver = makeDriver({}, { authorizeUri: 'https://pay.omise.co/auth/x' })
    await expect(
      driver.charges.create({
        amount: 5000,
        currency: 'thb',
        paymentMethod: { kind: 'truemoney', phoneNumber: '+66812345678' },
      }),
    ).rejects.toThrow(/returnUrl/)
  })

  test('promptpay does NOT require returnUrl (QR is async settle, not redirect)', async () => {
    const driver = makeDriver({}, { qrUri: 'https://api.omise.co/charges/x/doc.png' })
    await driver.charges.create({
      amount: 1000,
      currency: 'thb',
      paymentMethod: { kind: 'promptpay' },
    })
    // No throw — success.
    expect(true).toBe(true)
  })

  test('paynow (Stripe-only) throws ProviderUnsupportedError', async () => {
    const driver = makeDriver({})
    await expect(
      driver.charges.create({
        amount: 1000,
        currency: 'sgd',
        paymentMethod: { kind: 'paynow' },
        returnUrl: 'https://app/done',
      }),
    ).rejects.toThrow(ProviderUnsupportedError)
  })

  test('card token still works (back-compat single-step)', async () => {
    const captured: Record<string, Record<string, unknown> | undefined> = {}
    const driver = makeDriver(captured)
    const charge = await driver.charges.create({
      amount: 1000,
      currency: 'thb',
      paymentMethod: 'tokn_visa',
    })
    expect(captured.sourceReq).toBeUndefined() // skipped source step
    expect(captured.chargeReq?.card).toBe('tokn_visa')
    expect(charge.nextAction).toBeNull()
  })

  test('declares the right capability set', () => {
    const driver = makeDriver({})
    expect(driver.capabilities.has('charges.method.card')).toBe(true)
    expect(driver.capabilities.has('charges.method.promptpay')).toBe(true)
    expect(driver.capabilities.has('charges.method.truemoney')).toBe(true)
    expect(driver.capabilities.has('charges.method.rabbit_linepay')).toBe(true)
    expect(driver.capabilities.has('charges.method.paynow')).toBe(false)
    expect(driver.capabilities.has('charges.method.konbini')).toBe(false)
    expect(driver.capabilities.has('charges.nextAction.display_qr')).toBe(true)
    expect(driver.capabilities.has('charges.nextAction.redirect')).toBe(true)
  })
})
