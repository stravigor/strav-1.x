/**
 * Build an Omise source-creation request from a `PaymentMethodSpec`.
 *
 * Omise's async flow is two-step: create a `source` (type +
 * amount + currency + per-kind extras), then create a `charge`
 * that references the source. This module owns the mapping from
 * framework spec kind → Omise source `type` string + the extras
 * each kind needs (e.g. `phone_number` for TrueMoney).
 *
 * `card` short-circuits to the existing single-step flow.
 * Unsupported kinds return `'unsupported'` and the driver throws
 * `ProviderUnsupportedError`.
 */

import type { PaymentMethodSpec } from '../../dto/index.ts'

export interface OmiseSourceRequest {
  type: string
  amount: number
  currency: string
  /** TrueMoney: customer mobile in international format. */
  phone_number?: string
  /** Optional billing-display name. */
  name?: string
  /** Optional email for sources that ask for it. */
  email?: string
}

export type OmiseMethodBuildResult =
  | { kind: 'card_token' }
  | { kind: 'unsupported' }
  | { kind: 'source'; request: Omit<OmiseSourceRequest, 'amount' | 'currency'> }

/**
 * Closed map of supported `PaymentMethodSpec.kind` values to the
 * Omise source `type` strings. Driver capabilities + the create
 * path both derive from this table so they stay in sync.
 */
const OMISE_TYPES: Partial<Record<PaymentMethodSpec['kind'], string>> = {
  promptpay: 'promptpay',
  truemoney: 'truemoney',
  alipay: 'alipay',
  wechat_pay: 'wechat_pay',
  grabpay: 'grabpay',
  rabbit_linepay: 'rabbit_linepay',
}

export function buildOmiseMethodSpec(
  spec: PaymentMethodSpec,
  amount: number,
  currency: string,
): OmiseMethodBuildResult {
  if (spec.kind === 'card') return { kind: 'card_token' }
  const omiseType = OMISE_TYPES[spec.kind]
  if (!omiseType) return { kind: 'unsupported' }

  const request: Omit<OmiseSourceRequest, 'amount' | 'currency'> = { type: omiseType }
  if (spec.kind === 'truemoney') {
    request.phone_number = spec.phoneNumber
  }
  return { kind: 'source', request }
}

/** Flag the source's `flow` — used by the next-action mapper. */
export function omiseSourceFlowFor(kind: PaymentMethodSpec['kind']): 'offline' | 'redirect' | 'unknown' {
  switch (kind) {
    case 'promptpay':
      return 'offline'
    case 'truemoney':
    case 'alipay':
    case 'wechat_pay':
    case 'grabpay':
    case 'rabbit_linepay':
      return 'redirect'
    default:
      return 'unknown'
  }
}

export const OMISE_SUPPORTED_METHOD_KINDS: ReadonlyArray<PaymentMethodSpec['kind']> = [
  'card',
  'promptpay',
  'truemoney',
  'alipay',
  'wechat_pay',
  'grabpay',
  'rabbit_linepay',
]
