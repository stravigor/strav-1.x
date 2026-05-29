/**
 * Build a Stripe `payment_method_data` (plus matching
 * `payment_method_options` extras) from a `PaymentMethodSpec`.
 *
 * Returns `null` when the spec is a card token (the caller passes
 * `payment_method: <token>` directly), or `undefined` when the
 * driver should reject the kind via `ProviderUnsupportedError`.
 *
 * Stripe supports a different set of methods than Omise — this
 * function is the single place where the mapping lives so the
 * capability set + the create-call wiring stay in sync.
 */

import type Stripe from 'stripe'
import type { PaymentMethodSpec } from '../../dto/index.ts'

export interface StripeMethodWiring {
  payment_method_data: Stripe.PaymentIntentCreateParams.PaymentMethodData
  payment_method_options?: Stripe.PaymentIntentCreateParams.PaymentMethodOptions
}

export type StripeMethodBuildResult =
  | { kind: 'card_token' }
  | { kind: 'unsupported' }
  | { kind: 'wired'; wiring: StripeMethodWiring }

/**
 * Closed set of `PaymentMethodSpec.kind` values Stripe accepts.
 * `card` is handled separately (caller passes the token id);
 * everything else routes through `payment_method_data.type`.
 */
const STRIPE_TYPES: Partial<Record<PaymentMethodSpec['kind'], string>> = {
  promptpay: 'promptpay',
  paynow: 'paynow',
  alipay: 'alipay',
  wechat_pay: 'wechat_pay',
  grabpay: 'grabpay',
  kakaopay: 'kakao_pay',
  konbini: 'konbini',
}

export function buildStripeMethodWiring(
  spec: PaymentMethodSpec,
): StripeMethodBuildResult {
  if (spec.kind === 'card') return { kind: 'card_token' }
  const stripeType = STRIPE_TYPES[spec.kind]
  if (!stripeType) return { kind: 'unsupported' }

  const data = { type: stripeType } as Stripe.PaymentIntentCreateParams.PaymentMethodData

  const wiring: StripeMethodWiring = { payment_method_data: data }

  // Per-kind extras. WeChat needs a client hint; Konbini takes
  // a confirmation_number setting via payment_method_options.
  if (spec.kind === 'wechat_pay') {
    wiring.payment_method_options = {
      wechat_pay: { client: 'web' },
    } as Stripe.PaymentIntentCreateParams.PaymentMethodOptions
  }

  return { kind: 'wired', wiring }
}

/**
 * The `PaymentCapability` flag corresponding to a spec kind. Used
 * by the driver to declare its supported set + by tests.
 */
export const STRIPE_SUPPORTED_METHOD_KINDS: ReadonlyArray<PaymentMethodSpec['kind']> = [
  'card',
  'promptpay',
  'paynow',
  'alipay',
  'wechat_pay',
  'grabpay',
  'kakaopay',
  'konbini',
]
