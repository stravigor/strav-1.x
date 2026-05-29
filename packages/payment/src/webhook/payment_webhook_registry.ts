/**
 * Handler registry for normalized payment webhook events.
 *
 * Apps register handlers at boot:
 *
 *   payment.onWebhookEvent('subscription.created', (ctx) => { ... })
 *   payment.onWebhookEvent('charge.succeeded', { provider: 'stripe' }, (ctx) => { ... })
 *
 * Handlers fire in registration order. A thrown handler aborts
 * the rest and surfaces a 500 (the provider retries). Multiple
 * handlers per `(eventType, provider?)` are fine.
 *
 * Filter semantics: when `filter.provider` is set, the handler
 * only fires for that provider; when omitted, the handler fires
 * for any provider that emits the type.
 */

import type {
  PaymentEventType,
  WebhookHandler,
  WebhookHandlerFilter,
} from '../dto/payment_event.ts'

interface RegisteredHandler {
  filter: WebhookHandlerFilter
  handler: WebhookHandler
}

export class PaymentWebhookRegistry {
  private readonly handlers = new Map<PaymentEventType, RegisteredHandler[]>()

  on(eventType: PaymentEventType, handler: WebhookHandler): void
  on(
    eventType: PaymentEventType,
    filter: WebhookHandlerFilter,
    handler: WebhookHandler,
  ): void
  on(
    eventType: PaymentEventType,
    filterOrHandler: WebhookHandlerFilter | WebhookHandler,
    maybeHandler?: WebhookHandler,
  ): void {
    const { filter, handler } =
      typeof filterOrHandler === 'function'
        ? { filter: {}, handler: filterOrHandler }
        : { filter: filterOrHandler, handler: maybeHandler! }
    const existing = this.handlers.get(eventType) ?? []
    existing.push({ filter, handler })
    this.handlers.set(eventType, existing)
  }

  /** Remove every registered handler. Tests use this to keep cases isolated. */
  clear(): void {
    this.handlers.clear()
  }

  /** Resolve the handlers that match a given `(type, provider)` pair. */
  resolve(eventType: PaymentEventType, provider: string): readonly WebhookHandler[] {
    const matches = this.handlers.get(eventType)
    if (!matches) return []
    return matches
      .filter((m) => !m.filter.provider || m.filter.provider === provider)
      .map((m) => m.handler)
  }
}
