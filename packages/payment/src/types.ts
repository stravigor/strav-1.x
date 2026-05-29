/**
 * `@strav/payment` — runtime config shapes.
 *
 * `PaymentConfig` is the `config.payment` shape apps declare in
 * `config/payment.ts`. Multi-provider by default: a `providers`
 * map keyed by app-chosen name, each with a `driver` discriminator
 * the framework resolves to a concrete `PaymentDriver`. Apps that
 * want a single provider just register one entry.
 *
 * `ProviderConfig` is intentionally free-form (`[key: string]:
 * unknown`) so each adapter package owns its own config shape
 * (`StripeConfig`, `PaddleConfig`, `OmiseConfig`) without forcing
 * the core to know every vendor field.
 */

export interface PaymentConfig {
  /** Key into `providers`. The default routing target for unqualified `payment.*` calls. */
  default: string
  providers: Record<string, ProviderConfig>
  ledger?: LedgerConfig
}

export interface ProviderConfig {
  /**
   * Driver identifier — must match a built-in (`'stripe'`,
   * `'paddle'`, `'omise'`) or a name registered via
   * `manager.extend(name, factory)`.
   */
  driver: string
  /** Driver-specific fields — see each adapter's `*Config`. */
  [key: string]: unknown
}

export interface LedgerConfig {
  /**
   * Mirror provider state (customers / subscriptions / invoices)
   * into the local ledger tables. Default `true`. When false,
   * only the webhook dedup table is used; apps own their own
   * ledger.
   */
  enabled?: boolean
  /**
   * When `enabled`, upsert into the ledger on every webhook
   * delivery (before user handlers fire). Default `true`. Apps
   * that prefer eventual consistency via a background job set
   * this to `false` and run their own sync.
   */
  syncOnWebhook?: boolean
}
