/**
 * Omise has no `prices` catalog — but the framework's
 * `SubscriptionOps.create` takes a `price: string` (Stripe's model).
 *
 * We bridge that gap with an in-band encoded "price spec" that
 * carries everything the Omise schedules API needs: amount,
 * currency, recurrence period, count per period, optional
 * description, optional default card.
 *
 * Apps build the spec with `omisePriceSpec({...})` and pass the
 * result as `subscriptions.create({ price: spec, ... })`. The
 * driver parses on the way in and rebuilds on the way out (so
 * `PaymentSubscription.priceId` round-trips cleanly).
 *
 * Wire format: `omise_spec:<base64-url JSON>`. The prefix lets
 * the driver detect the format and reject opaque ids that look
 * like Stripe `price_…` early with a clear error.
 *
 * Period values match Omise's API: `'day' | 'week' | 'month'`.
 */

export type OmisePeriod = 'day' | 'week' | 'month'

export interface OmisePriceSpec {
  amount: number
  currency: string
  period: OmisePeriod
  /** Every N periods between charges. Default 1. */
  every?: number
  description?: string
  /** Default card on the customer. Apps that want to charge a specific token id pass it here. */
  card?: string
}

const PREFIX = 'omise_spec:'

export function omisePriceSpec(spec: OmisePriceSpec): string {
  if (!Number.isFinite(spec.amount) || spec.amount <= 0) {
    throw new TypeError('omisePriceSpec: `amount` must be a positive number (in minor units).')
  }
  if (!spec.currency) {
    throw new TypeError('omisePriceSpec: `currency` is required.')
  }
  if (!spec.period) {
    throw new TypeError('omisePriceSpec: `period` is required (day | week | month).')
  }
  const payload = {
    a: spec.amount,
    c: spec.currency.toLowerCase(),
    p: spec.period,
    ...(spec.every !== undefined ? { e: spec.every } : {}),
    ...(spec.description ? { d: spec.description } : {}),
    ...(spec.card ? { card: spec.card } : {}),
  }
  return PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function parseOmisePriceSpec(value: string): OmisePriceSpec | null {
  if (!value.startsWith(PREFIX)) return null
  const rest = value.slice(PREFIX.length)
  let parsed: { a: number; c: string; p: OmisePeriod; e?: number; d?: string; card?: string }
  try {
    const json = Buffer.from(rest, 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (
    typeof parsed.a !== 'number' ||
    typeof parsed.c !== 'string' ||
    typeof parsed.p !== 'string'
  ) {
    return null
  }
  return {
    amount: parsed.a,
    currency: parsed.c,
    period: parsed.p,
    ...(parsed.e !== undefined ? { every: parsed.e } : {}),
    ...(parsed.d ? { description: parsed.d } : {}),
    ...(parsed.card ? { card: parsed.card } : {}),
  }
}

export const OMISE_PRICE_SPEC_PREFIX = PREFIX
