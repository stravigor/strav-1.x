/**
 * Provider-agnostic webhook route handler.
 *
 * Mount once per app:
 *
 *   router.post('/webhooks/:provider', paymentWebhook())
 *
 * Per request flow:
 *
 *   1. Read the `:provider` route param — picks the driver
 *      instance to verify against.
 *   2. Read the raw body. Signature is computed over the bytes,
 *      so JSON-parsing first invalidates verification.
 *   3. Resolve the signature header — drivers carry their own
 *      header name (`stripe-signature`, `paddle-signature`,
 *      `x-omise-signature`); the handler reads them all.
 *   4. `driver.webhook.verify(rawBody, signature)` — returns the
 *      provider-native event. 400 + retry on failure.
 *   5. Idempotency claim against
 *      `payment_webhook_event(provider, provider_event_id)`. The
 *      first delivery wins; replays return 200 `{ duplicate: true }`.
 *   6. `driver.webhook.normalize(event)` — maps onto a
 *      `NormalizedWebhookEvent`. `null` means the event isn't on
 *      the framework's closed union; the dedup row stays, but no
 *      user handler fires.
 *   7. Dispatch matching handlers from `PaymentWebhookRegistry`.
 *      Handlers run in registration order. Throwing leaves
 *      `processed_at` NULL so dashboards can surface stuck
 *      events; the route returns 500 so the provider retries.
 *   8. Mark `processed_at` on success.
 */

import type { HttpContext } from '@strav/http'
import type { NormalizedWebhookEvent, WebhookHandlerContext } from '../dto/payment_event.ts'
import { PaymentManager } from '../payment_manager.ts'
import { UnknownProviderError, WebhookSignatureError } from '../payment_error.ts'
import { PaymentWebhookEventRepository } from './payment_webhook_event_repository.ts'

export interface PaymentWebhookOptions {
  /** Override the global ledger-sync flag for this route. */
  syncLedger?: boolean
}

const SIGNATURE_HEADERS = [
  'stripe-signature',
  'paddle-signature',
  'x-omise-signature',
  'webhook-signature',
]

export function paymentWebhook(
  options: PaymentWebhookOptions = {},
): (ctx: HttpContext) => Promise<Response> {
  return async (ctx: HttpContext): Promise<Response> => {
    const providerName = ctx.request.params['provider']
    if (!providerName) {
      return ctx.response.json(
        { error: 'Missing :provider route param. Mount as `/webhooks/:provider`.' },
        { status: 400 },
      )
    }

    const manager = ctx.container.resolve(PaymentManager)
    let driver
    try {
      driver = manager.use(providerName)
    } catch (cause) {
      if (cause instanceof UnknownProviderError) {
        return ctx.response.json({ error: cause.message }, { status: 404 })
      }
      throw cause
    }

    const signature = findSignatureHeader(ctx.request.headers)
    if (!signature) {
      return ctx.response.json(
        { error: 'Missing provider signature header.' },
        { status: 400 },
      )
    }

    const rawBody = await ctx.request.raw.text()

    let nativeEvent: unknown
    try {
      nativeEvent = await driver.webhook.verify(rawBody, signature)
    } catch (cause) {
      if (cause instanceof WebhookSignatureError) {
        return ctx.response.json({ error: cause.message }, { status: 400 })
      }
      throw cause
    }

    const normalized = driver.webhook.normalize(nativeEvent)
    const eventIdForDedup = normalized?.id ?? extractEventId(nativeEvent)
    const eventTypeForDedup = normalized?.type ?? extractEventType(nativeEvent) ?? 'unknown'

    if (!eventIdForDedup) {
      return ctx.response.json(
        { error: 'Provider event is missing an id; cannot dedup.' },
        { status: 400 },
      )
    }

    const repo = ctx.container.resolve(PaymentWebhookEventRepository)
    const claimed = await repo.claim(providerName, eventIdForDedup, eventTypeForDedup)
    if (!claimed) {
      return ctx.response.json({ received: true, duplicate: true })
    }

    if (normalized) {
      // The route picks the driver instance by `:provider`. Apps
      // register handlers against the same instance name they
      // configured (`payment.use('asia') ↔ /webhooks/asia`), so
      // we override the normalized event's `provider` field with
      // the instance name. Drivers fill `provider` with their
      // own name (`'stripe'`, `'omise'`) but instance-name routing
      // is what the dispatcher honours.
      const routed: NormalizedWebhookEvent = { ...normalized, provider: providerName }
      const syncLedger = options.syncLedger ?? manager.config.ledger?.syncOnWebhook ?? true

      // Tenant routing — when the event carries a `tenantId`
      // (drivers read `metadata.strav_tenant_id`) AND a
      // TenantManager is wired, scope ledger writes + user
      // handlers via `withTenant`. The `tx` argument is the
      // executor on which `withTenant` set `app.tenant_id`
      // (LOCAL = transaction scope); ledger writes MUST use it
      // so `current_setting('app.tenant_id')` resolves.
      //
      // Events without a `tenantId` skip the ledger write (the
      // tables are tenanted; writing without scope would violate
      // RLS / NOT NULL) but still dispatch to user handlers so
      // apps can reconcile manually.
      if (routed.tenantId && manager.tenantManager) {
        await manager.tenantManager.withTenant(routed.tenantId, async (tx) => {
          if (syncLedger && manager.ledger) {
            await manager.ledger.applyEvent(routed, tx)
          }
          await dispatch(manager, routed)
        })
      } else {
        await dispatch(manager, routed)
      }
    }

    await repo.markProcessed(providerName, eventIdForDedup)
    return ctx.response.json({ received: true, duplicate: false })
  }
}

async function dispatch(
  manager: PaymentManager,
  event: NormalizedWebhookEvent,
): Promise<void> {
  const handlers = manager.webhookRegistry.resolve(event.type, event.provider)
  if (handlers.length === 0) return
  const ctx: WebhookHandlerContext = {
    event,
    eventId: event.id,
    eventType: event.type,
    provider: event.provider,
    ...(event.tenantId ? { tenantId: event.tenantId } : {}),
    raw: event.raw,
  }
  for (const handler of handlers) {
    await handler(ctx)
  }
}

function findSignatureHeader(headers: Headers): string | null {
  for (const name of SIGNATURE_HEADERS) {
    const value = headers.get(name)
    if (value) return value
  }
  return null
}

function extractEventId(event: unknown): string | null {
  if (event && typeof event === 'object' && 'id' in event && typeof (event as { id: unknown }).id === 'string') {
    return (event as { id: string }).id
  }
  return null
}

function extractEventType(event: unknown): string | null {
  if (event && typeof event === 'object' && 'type' in event && typeof (event as { type: unknown }).type === 'string') {
    return (event as { type: string }).type
  }
  return null
}
