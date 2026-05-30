/**
 * Omise ↔ normalized-DTO mappers. The Omise type surface lives in
 * the SDK namespace; we use structural shapes here to keep the
 * mappers tolerant of SDK version drift.
 */

import type {
  ChargeStatus,
  PaymentCharge,
  PaymentCustomer,
  PaymentMethod,
} from '../../dto/index.ts'
import { omiseNextAction } from './omise_next_action_mapper.ts'

const PROVIDER = 'omise'

interface OmiseTimestamps {
  created_at?: string
  created?: string
}

interface OmiseCustomer extends OmiseTimestamps {
  id: string
  email?: string
  description?: string
  metadata?: Record<string, unknown>
}

interface OmiseCharge extends OmiseTimestamps {
  id: string
  amount: number
  currency: string
  status: 'failed' | 'reversed' | 'expired' | 'pending' | 'successful'
  paid?: boolean
  capture?: boolean
  refunded?: number
  refunded_amount?: number
  customer?: string | OmiseCustomer | null
  card?: OmiseCard | null
  source?: OmiseSource | null
  authorize_uri?: string | null
  return_uri?: string | null
  expires_at?: string
  failure_code?: string | null
  failure_message?: string | null
  metadata?: Record<string, unknown>
}

interface OmiseSource {
  id: string
  type?: string
  flow?: string
  amount?: number
  currency?: string
  scannable_code?: {
    type?: string
    image?: { download_uri?: string }
  }
  references?: { expires_at?: string }
}

interface OmiseCard extends OmiseTimestamps {
  id: string
  brand?: string
  last_digits?: string
  expiration_month?: number
  expiration_year?: number
  customer?: string | null
}

function metadata(m: Record<string, unknown> | undefined): Record<string, string> {
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) {
    if (v === null || v === undefined) continue
    out[k] = String(v)
  }
  return out
}

function createdAt(r: OmiseTimestamps): Date {
  const ts = r.created_at ?? r.created
  return ts ? new Date(ts) : new Date()
}

export function toPaymentCustomer(c: OmiseCustomer): PaymentCustomer {
  return {
    id: c.id,
    provider: PROVIDER,
    email: c.email ?? '',
    metadata: metadata(c.metadata),
    createdAt: createdAt(c),
    raw: c,
  }
}

const CHARGE_STATUS_MAP: Record<OmiseCharge['status'], ChargeStatus> = {
  successful: 'succeeded',
  pending: 'pending',
  failed: 'failed',
  reversed: 'refunded',
  expired: 'failed',
}

export function toPaymentCharge(c: OmiseCharge): PaymentCharge {
  let status: ChargeStatus = CHARGE_STATUS_MAP[c.status] ?? 'pending'
  if ((c.refunded ?? 0) > 0) {
    status = (c.refunded ?? 0) >= c.amount ? 'refunded' : 'partial_refunded'
  }
  return {
    id: c.id,
    provider: PROVIDER,
    customerId: typeof c.customer === 'string' ? c.customer : c.customer?.id ?? null,
    amount: c.amount,
    currency: c.currency.toLowerCase(),
    status,
    paymentMethodId: c.card?.id ?? null,
    failureCode: c.failure_code ?? null,
    failureMessage: c.failure_message ?? null,
    // Source-backed charges (PromptPay / TrueMoney / Alipay /
    // GrabPay / etc.) carry the next-action shape on the
    // attached source (QR image URL) or the charge itself
    // (`authorize_uri`). Card-only / settled charges produce
    // `null`.
    nextAction: omiseNextAction(c),
    metadata: metadata(c.metadata),
    createdAt: createdAt(c),
    raw: c,
  }
}

export function toPaymentMethod(card: OmiseCard): PaymentMethod {
  return {
    id: card.id,
    provider: PROVIDER,
    customerId: card.customer ?? null,
    kind: 'card',
    ...(card.brand ? { brand: card.brand } : {}),
    ...(card.last_digits ? { last4: card.last_digits } : {}),
    ...(card.expiration_month ? { expMonth: card.expiration_month } : {}),
    ...(card.expiration_year ? { expYear: card.expiration_year } : {}),
    metadata: {},
    createdAt: createdAt(card),
    raw: card,
  }
}

interface OmiseLink extends OmiseTimestamps {
  id: string
  amount: number
  currency: string
  title?: string
  description?: string
  used?: boolean
  multiple?: boolean
  payment_uri: string
  metadata?: Record<string, unknown>
}

export function toPaymentLink(l: OmiseLink): import('../../dto/index.ts').PaymentLink {
  return {
    id: l.id,
    provider: PROVIDER,
    url: l.payment_uri,
    amount: l.amount,
    currency: l.currency.toLowerCase(),
    // Omise marks a link as `used` after the first payment when
    // `multiple: false`. We treat `used && !multiple` as inactive
    // since the link can't take more payments.
    active: !(l.used === true && l.multiple !== true),
    reusable: l.multiple === true,
    ...(l.title ? { title: l.title } : {}),
    ...(l.description ? { description: l.description } : {}),
    metadata: metadata(l.metadata),
    createdAt: createdAt(l),
    raw: l,
  }
}

export type { OmiseCard, OmiseCharge, OmiseCustomer, OmiseLink, OmiseSource }
