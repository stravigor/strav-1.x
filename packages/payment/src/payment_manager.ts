/**
 * `PaymentManager` — the facade apps use for payment workflows.
 *
 * Three concept clusters:
 *
 *   - **Drivers.** Apps declare providers in
 *     `config.payment.providers`. The manager constructs each
 *     driver lazily on first `use(name)` + memoizes. Custom
 *     drivers register via `manager.extend(name, factory)`.
 *
 *   - **Resource namespaces.** `customers`, `subscriptions`,
 *     `products`, `prices`, `paymentMethods`, `charges`,
 *     `invoices`, `checkout` — each accessor routes to the
 *     active driver's matching `*Ops` group. The default driver
 *     handles unqualified calls; `payment.use('asia').charges`
 *     routes elsewhere.
 *
 *   - **Webhooks.** `manager.onWebhookEvent(type, handler)` /
 *     `manager.onWebhookEvent(type, filter, handler)` registers
 *     a normalized-event handler. The `paymentWebhook()` route
 *     dispatches into the registry after dedup + normalize.
 *
 * Multitenancy: tenanted ledger tables rely on
 * `app.tenant_id` session settings, the same RLS pattern as
 * `@strav/database`. Apps that wrap calls in
 * `tenants.withTenant(...)` get per-tenant ledger isolation for
 * free.
 */

import type {
  ChargeOps,
  CheckoutOps,
  CustomerOps,
  InvoiceOps,
  LinkOps,
  PaymentDriver,
  PaymentDriverFactory,
  PaymentMethodOps,
  PriceOps,
  ProductOps,
  SubscriptionOps,
  WebhookOps,
} from './payment_driver.ts'
import {
  PaymentConfigError,
  UnknownProviderError,
} from './payment_error.ts'
import type {
  PaymentEventType,
  WebhookHandler,
  WebhookHandlerFilter,
} from './dto/payment_event.ts'
import { PaymentWebhookRegistry } from './webhook/payment_webhook_registry.ts'
import type { TenantManager } from '@strav/database'
import type { PaymentLedger } from './ledger/payment_ledger.ts'
import type { PaymentConfig, ProviderConfig } from './types.ts'

export interface PaymentManagerOptions {
  config: PaymentConfig
  /** Optional ledger — when omitted, `applyEvent` during webhook dispatch no-ops. */
  ledger?: PaymentLedger
  /**
   * Optional tenancy bridge. When set, the webhook dispatcher
   * wraps ledger writes + user handlers in
   * `tenantManager.withTenant(event.tenantId, ...)`. Events
   * arrive without a `tenantId` skip the wrapper (and the
   * ledger write, if ledger sync is on).
   */
  tenantManager?: TenantManager
}

export class PaymentManager {
  readonly config: PaymentConfig
  readonly webhookRegistry = new PaymentWebhookRegistry()
  readonly ledger: PaymentLedger | undefined
  readonly tenantManager: TenantManager | undefined

  private readonly drivers = new Map<string, PaymentDriver>()
  private readonly extensions = new Map<string, PaymentDriverFactory>()

  constructor(options: PaymentManagerOptions) {
    const { config } = options
    if (!config.providers[config.default]) {
      throw new PaymentConfigError(
        `PaymentManager: default provider "${config.default}" is not configured.`,
        {
          context: {
            default: config.default,
            available: Object.keys(config.providers),
          },
        },
      )
    }
    this.config = config
    this.ledger = options.ledger
    this.tenantManager = options.tenantManager
  }

  // ─── Driver routing ───────────────────────────────────────────────────

  /** Resolve a driver by app-chosen instance name (or the default when omitted). */
  use(name?: string): PaymentDriver {
    const key = name ?? this.config.default
    const cached = this.drivers.get(key)
    if (cached) return cached

    const cfg = this.config.providers[key]
    if (!cfg) {
      throw new UnknownProviderError(key, Object.keys(this.config.providers))
    }
    const ext = this.extensions.get(cfg.driver)
    if (!ext) {
      throw new PaymentConfigError(
        `PaymentManager: unknown driver "${cfg.driver}" for provider "${key}". Register it via \`manager.extend("${cfg.driver}", factory)\` or install the matching adapter package.`,
        { context: { driver: cfg.driver, available: [...this.extensions.keys()] } },
      )
    }
    const driver = ext({ instanceName: key, config: cfg as ProviderConfig & { driver: string } })
    this.drivers.set(key, driver)
    return driver
  }

  /**
   * Register a driver factory. Adapter packages
   * (`@strav/payment-stripe`, …) call this from their
   * ServiceProvider's `register()` step. Custom adapters
   * register the same way.
   */
  extend(driverName: string, factory: PaymentDriverFactory): void {
    this.extensions.set(driverName, factory)
  }

  /** Hand-wire a driver instance under an app-chosen name (tests / one-offs). */
  useDriver(instanceName: string, driver: PaymentDriver): void {
    this.drivers.set(instanceName, driver)
  }

  // ─── Resource namespaces (route to the default driver) ───────────────

  get customers(): CustomerOps { return this.use().customers }
  get products(): ProductOps { return this.use().products }
  get prices(): PriceOps { return this.use().prices }
  get subscriptions(): SubscriptionOps { return this.use().subscriptions }
  get paymentMethods(): PaymentMethodOps { return this.use().paymentMethods }
  get charges(): ChargeOps { return this.use().charges }
  get invoices(): InvoiceOps { return this.use().invoices }
  get checkout(): CheckoutOps { return this.use().checkout }
  get links(): LinkOps { return this.use().links }
  get webhook(): WebhookOps { return this.use().webhook }

  // ─── Webhook handler registration ─────────────────────────────────────

  onWebhookEvent(type: PaymentEventType, handler: WebhookHandler): void
  onWebhookEvent(
    type: PaymentEventType,
    filter: WebhookHandlerFilter,
    handler: WebhookHandler,
  ): void
  onWebhookEvent(
    type: PaymentEventType,
    filterOrHandler: WebhookHandlerFilter | WebhookHandler,
    maybeHandler?: WebhookHandler,
  ): void {
    if (typeof filterOrHandler === 'function') {
      this.webhookRegistry.on(type, filterOrHandler)
    } else {
      this.webhookRegistry.on(type, filterOrHandler, maybeHandler!)
    }
  }

  clearWebhookHandlers(): void {
    this.webhookRegistry.clear()
  }
}
