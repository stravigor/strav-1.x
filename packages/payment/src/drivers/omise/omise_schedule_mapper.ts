/**
 * Map an Omise `schedule` onto a `PaymentSubscription`.
 *
 * Omise + framework data models differ; we make the following
 * choices:
 *
 *   - **`status`** — Omise statuses: `running`, `active`,
 *     `expiring`, `expired`, `deleted`, `suspended`. We collapse
 *     active recurrences to `active`, expired / deleted to
 *     `canceled`, suspended to `paused`.
 *
 *   - **`currentPeriodStart` / `currentPeriodEnd`** — Omise gives
 *     `start_date` + `end_date` + an array `next_occurrence_dates`.
 *     We treat the most recently passed occurrence as period
 *     start, and the next upcoming occurrence as period end.
 *
 *   - **`priceId`** — synthesized via `omisePriceSpec` so the
 *     round-trip stays portable. Apps reading the DTO see the
 *     same spec they sent on `create`.
 *
 *   - **`trialStart` / `trialEnd`** — always null. Omise schedules
 *     don't have a trial concept.
 *
 *   - **`cancelAt` / `canceledAt`** — `end_date` becomes
 *     `cancelAt`; `ended_at` becomes `canceledAt` once the
 *     schedule has actually stopped.
 */

import type { PaymentSubscription, SubscriptionStatus } from '../../dto/index.ts'
import { omisePriceSpec, type OmisePeriod } from './omise_price_spec.ts'

export interface OmiseScheduleCharge {
  amount: number
  currency: string
  customer: string | { id: string }
  card?: string | { id: string } | null
  description?: string
  metadata?: Record<string, unknown>
}

export interface OmiseSchedule {
  id: string
  status?: string
  active?: boolean
  every: number
  period: string
  start_date?: string
  end_date?: string
  start_on?: string
  end_on?: string
  ended_at?: string
  created?: string
  created_at?: string
  next_occurrence_dates?: string[]
  charge?: OmiseScheduleCharge
  metadata?: Record<string, unknown>
}

function statusFor(s: OmiseSchedule): SubscriptionStatus {
  const raw = s.status?.toLowerCase()
  if (raw === 'suspended') return 'paused'
  if (raw === 'expired' || raw === 'deleted') return 'canceled'
  if (s.active === false) return 'canceled'
  return 'active'
}

function parseDate(v: string | undefined): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
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

function periodBoundary(s: OmiseSchedule, now = new Date()): { start: Date; end: Date } {
  const nowMs = now.getTime()
  const upcoming = (s.next_occurrence_dates ?? [])
    .map(parseDate)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())
  const next = upcoming.find((d) => d.getTime() >= nowMs)
  const start =
    upcoming.filter((d) => d.getTime() < nowMs).pop() ??
    parseDate(s.start_date) ??
    parseDate(s.created_at) ??
    now
  const end = next ?? parseDate(s.end_date) ?? start
  return { start, end }
}

export function toPaymentSubscription(s: OmiseSchedule): PaymentSubscription {
  const charge = s.charge
  if (!charge) {
    // Transfer-only schedules don't map onto subscriptions. Surface
    // a meaningful row so apps can still see them, but the price spec
    // can't be reconstructed.
    const { start, end } = periodBoundary(s)
    return {
      id: s.id,
      provider: 'omise',
      customerId: '',
      priceId: '',
      status: statusFor(s),
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAt: parseDate(s.end_date),
      canceledAt: parseDate(s.ended_at),
      trialStart: null,
      trialEnd: null,
      metadata: metadata(s.metadata),
      createdAt: parseDate(s.created_at) ?? parseDate(s.created) ?? new Date(),
      raw: s,
    }
  }
  const customerId =
    typeof charge.customer === 'string' ? charge.customer : charge.customer.id
  const cardId =
    typeof charge.card === 'string'
      ? charge.card
      : charge.card
        ? charge.card.id
        : undefined
  const priceId = omisePriceSpec({
    amount: charge.amount,
    currency: charge.currency,
    period: s.period as OmisePeriod,
    every: s.every,
    ...(charge.description ? { description: charge.description } : {}),
    ...(cardId ? { card: cardId } : {}),
  })
  const { start, end } = periodBoundary(s)
  return {
    id: s.id,
    provider: 'omise',
    customerId,
    priceId,
    status: statusFor(s),
    currentPeriodStart: start,
    currentPeriodEnd: end,
    cancelAt: parseDate(s.end_date),
    canceledAt: parseDate(s.ended_at),
    trialStart: null,
    trialEnd: null,
    metadata: metadata(s.metadata),
    createdAt: parseDate(s.created_at) ?? parseDate(s.created) ?? new Date(),
    raw: s,
  }
}
