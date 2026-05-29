/**
 * Normalized webhook event types. Drivers map their native event
 * shapes (`invoice.paid`, `subscription_created`, …) onto this
 * closed union. Apps register handlers by normalized type; the
 * native event is on `ctx.raw`.
 */

export type PaymentEventType =
  | 'customer.created'
  | 'customer.updated'
  | 'customer.deleted'
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'subscription.trial_will_end'
  | 'charge.succeeded'
  | 'charge.failed'
  | 'charge.refunded'
  | 'invoice.created'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'invoice.voided'
  | 'checkout.completed'
  | 'checkout.expired'
  | 'payment_method.attached'
  | 'payment_method.detached'

export interface NormalizedWebhookEvent {
  /** Driver-assigned id; the dedup key. */
  id: string
  /** Normalized type from the closed union above. */
  type: PaymentEventType
  /**
   * After the dispatcher routes the event, this is the app-chosen
   * **instance name** (the `:provider` route param, matches
   * `payment.use(name)`). Drivers' `normalize` set it to the
   * driver name (`'stripe'` / `'omise'`); the dispatcher
   * overrides with the instance name.
   */
  provider: string
  /**
   * Strav tenant id pulled from the original create call's
   * metadata (`metadata.strav_tenant_id`). When set, the
   * dispatcher wraps ledger writes + user handlers in
   * `TenantManager.withTenant(tenantId, ...)`. Undefined when
   * the originating call didn't stamp a tenant — multi-tenant
   * apps that forget the stamp see ledger writes skipped + a
   * one-shot warning.
   */
  tenantId?: string
  /** Native provider event payload. */
  raw: unknown
  /** Convenience accessors for the most common downstream resources. */
  data: {
    customerId?: string
    subscriptionId?: string
    invoiceId?: string
    chargeId?: string
    checkoutId?: string
    paymentMethodId?: string
  }
}

export interface WebhookHandlerContext {
  event: NormalizedWebhookEvent
  /** Convenience shortcut for `event.id`. */
  eventId: string
  /** Convenience shortcut for `event.type`. */
  eventType: PaymentEventType
  /** Convenience shortcut for `event.provider`. */
  provider: string
  /** Convenience shortcut for `event.tenantId`. */
  tenantId?: string
  /** Convenience shortcut for `event.raw`. */
  raw: unknown
}

export type WebhookHandler = (ctx: WebhookHandlerContext) => void | Promise<void>

export interface WebhookHandlerFilter {
  /** Restrict the handler to one provider. Omitted = fires for any provider that emits the type. */
  provider?: string
}
