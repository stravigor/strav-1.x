/**
 * Omise webhook signature verification + event normalization.
 *
 * Omise signs webhook deliveries with HMAC SHA-256 over the raw
 * body using the webhook secret from the Dashboard. The signature
 * is sent in `X-Omise-Signature` as a hex digest. The SDK doesn't
 * bundle a verifier — we implement it here.
 *
 * Event shape: `{ id, object: 'event', key, created_at, data }`
 * where `key` is the event name (`'charge.complete'`,
 * `'customer.create'`, …). We map the common keys onto the
 * framework's `PaymentEventType` union.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { WebhookSignatureError } from '../../payment_error.ts'
import type {
  NormalizedWebhookEvent,
  PaymentEventType,
} from '../../dto/payment_event.ts'
import { readTenantId } from '../../tenant_metadata.ts'
import {
  toPaymentCharge,
  toPaymentCustomer,
  type OmiseCharge,
  type OmiseCustomer,
} from './omise_mappers.ts'
import {
  toPaymentSubscription as toPaymentSubscriptionFromSchedule,
  type OmiseSchedule,
} from './omise_schedule_mapper.ts'

interface OmiseEvent {
  id: string
  object: 'event'
  key: string
  created_at?: string
  created?: string
  data: { object?: unknown; [k: string]: unknown }
}

const TYPE_MAP: Record<string, PaymentEventType> = {
  'customer.create': 'customer.created',
  'customer.update': 'customer.updated',
  'customer.destroy': 'customer.deleted',
  'charge.create': 'charge.succeeded',
  'charge.complete': 'charge.succeeded',
  'charge.update': 'charge.succeeded',
  'charge.capture': 'charge.succeeded',
  'charge.expire': 'charge.failed',
  'refund.create': 'charge.refunded',
  'schedule.create': 'subscription.created',
  'schedule.update': 'subscription.updated',
  'schedule.destroy': 'subscription.canceled',
}

/**
 * Verify an Omise webhook signature against the raw body using
 * the configured secret. Throws `WebhookSignatureError` on
 * mismatch or missing secret. Returns the parsed event payload
 * on success.
 */
export async function omiseVerify(
  rawBody: string,
  signature: string,
  webhookSecret: string | undefined,
): Promise<OmiseEvent> {
  if (!webhookSecret) {
    throw new WebhookSignatureError(
      'OmisePaymentDriver.webhook.verify: `webhookSecret` is not set on the provider config.',
    )
  }
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex')
  const provided = signature.trim()
  // Use Uint8Array views to dodge the Buffer<ArrayBufferLike>
  // mismatch with `timingSafeEqual`'s `ArrayBufferView`-typed
  // params. Hex strings of unequal length are always rejected.
  const expectedBuf = new Uint8Array(Buffer.from(expected, 'hex'))
  const providedBuf = new Uint8Array(Buffer.from(provided, 'hex'))
  if (
    expectedBuf.length === 0 ||
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    throw new WebhookSignatureError(
      'OmisePaymentDriver.webhook.verify: signature mismatch.',
    )
  }
  try {
    return JSON.parse(rawBody) as OmiseEvent
  } catch (cause) {
    throw new WebhookSignatureError(
      'OmisePaymentDriver.webhook.verify: body is not valid JSON.',
      { cause },
    )
  }
}

export function omiseNormalize(event: OmiseEvent): NormalizedWebhookEvent | null {
  const type = TYPE_MAP[event.key]
  if (!type) return null
  const data: NormalizedWebhookEvent['data'] = {}
  let fields: Record<string, unknown> | undefined
  const object = event.data.object

  switch (type) {
    case 'customer.created':
    case 'customer.updated':
      if (object && typeof object === 'object') {
        const dto = toPaymentCustomer(object as OmiseCustomer)
        data.customerId = dto.id
        fields = { ...dto }
      }
      break
    case 'customer.deleted':
      if (object && typeof object === 'object' && 'id' in (object as { id?: string })) {
        data.customerId = (object as { id: string }).id
      }
      break
    case 'charge.succeeded':
    case 'charge.failed':
    case 'charge.refunded':
      if (object && typeof object === 'object') {
        const dto = toPaymentCharge(object as OmiseCharge)
        data.chargeId = dto.id
        if (dto.customerId) data.customerId = dto.customerId
      }
      break
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.canceled':
      if (object && typeof object === 'object') {
        const dto = toPaymentSubscriptionFromSchedule(object as OmiseSchedule)
        data.subscriptionId = dto.id
        if (dto.customerId) data.customerId = dto.customerId
        fields = { ...dto }
      }
      break
  }

  // Same convention as Stripe: read `strav_tenant_id` off the
  // event's underlying resource metadata. Omise echoes metadata
  // verbatim on every event the framework cares about.
  const resourceMeta =
    (object as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? null
  const tenantId = readTenantId(resourceMeta)

  const normalized: NormalizedWebhookEvent = {
    id: event.id,
    type,
    provider: 'omise',
    raw: event,
    data,
    ...(tenantId ? { tenantId } : {}),
  }
  if (fields) {
    ;(normalized as { _fields?: unknown })._fields = fields
  }
  return normalized
}

export type { OmiseEvent }
