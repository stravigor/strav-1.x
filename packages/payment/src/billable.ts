/**
 * `billable()` — Cashier-style billing mixin for app models.
 *
 * Layers customer / charge / subscription convenience methods onto a
 * domain model (typically `User`) so the call sites read as:
 *
 *   const user = await users.findOrFail(id)
 *   await user.createCustomer(payments, { email: user.email })
 *   await user.charge(payments, { amount: 4900, currency: 'usd', ... })
 *   const subs = await user.subscriptions(payments.ledger!)
 *
 * **Manager + ledger are passed explicitly per call.** No static
 * singleton, no implicit container lookup — Strav favours explicit
 * injection. The trade-off is a bit more typing at the call site for
 * compile-time clarity about which provider the call touches and
 * which DB the read hits.
 *
 * **Storage contract.** A billable needs somewhere to remember the
 * customer id Stripe / Omise minted for it. The default lives on a
 * `payment_customers: Record<provider, string>` JSON field — apps
 * that already have a `payment_customers` column get persistence for
 * free. Apps with a different schema override `paymentCustomerId()`
 * + `setPaymentCustomerId()` directly:
 *
 *   class User extends billable(Model) {
 *     stripe_customer_id?: string | null
 *     override paymentCustomerId(provider: string): string | undefined {
 *       return provider === 'stripe' ? this.stripe_customer_id ?? undefined : undefined
 *     }
 *     override async setPaymentCustomerId(provider: string, id: string) {
 *       if (provider === 'stripe') this.stripe_customer_id = id
 *     }
 *   }
 *
 * The setter is sync OR async — apps that want to persist immediately
 * `await users.save(this)` inside the setter. Apps that prefer batch
 * saves leave the setter sync and call `save()` themselves.
 *
 * Two factory forms:
 *   - `class User extends Billable { ... }` — the base class itself,
 *     handy for new domain models.
 *   - `class User extends billable(BaseModel) { ... }` — the mixin
 *     form, for apps already extending another base (`Model`,
 *     `AuthenticatableUser`, …).
 */

import type {
  CreateChargeInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  PaymentCharge,
  PaymentCustomer,
  PaymentMethod,
  PaymentSubscription,
} from './dto/index.ts'
import type { PaymentLedger } from './ledger/payment_ledger.ts'
import type { PaymentInvoiceRow, PaymentSubscriptionRow } from './ledger/payment_ledger_models.ts'
import type { PaymentManager } from './payment_manager.ts'

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due'])

export interface BillableStorage {
  /** The provider-side customer id for `provider`, or `undefined` when not yet provisioned. */
  paymentCustomerId(provider: string): string | undefined
  /**
   * Persist `id` as this billable's customer id with `provider`. Sync
   * OR async — apps that hit the DB inside the setter return the
   * persistence promise.
   */
  setPaymentCustomerId(provider: string, id: string): void | Promise<void>
}

/**
 * Base class form — `class User extends Billable { ... }`. Subclasses
 * MUST also declare `static schema = ...` if they extend `Model`
 * (the mixin form does this in the chain automatically).
 *
 * Override `paymentCustomerId()` / `setPaymentCustomerId()` to use a
 * storage layout other than the default `payment_customers` map.
 */
export class Billable implements BillableStorage {
  /**
   * Default storage — apps that have a `payment_customers` jsonb
   * column on their model get this for free. The mixin reads /
   * writes through here unless the subclass overrides.
   */
  payment_customers?: Record<string, string>

  paymentCustomerId(provider: string): string | undefined {
    return this.payment_customers?.[provider]
  }

  setPaymentCustomerId(provider: string, id: string): void {
    this.payment_customers = { ...(this.payment_customers ?? {}), [provider]: id }
  }

  // ─── Customer ─────────────────────────────────────────────────────────

  /**
   * Fetch the current `PaymentCustomer` for `provider` (default:
   * `manager.config.default`). Returns `null` when no customer id is
   * stored — useful for "user hasn't paid yet" branches.
   */
  async customer(manager: PaymentManager, provider?: string): Promise<PaymentCustomer | null> {
    const p = provider ?? manager.config.default
    const cid = this.paymentCustomerId(p)
    if (cid === undefined) return null
    return manager.use(p).customers.retrieve(cid)
  }

  /**
   * Create a customer with `manager.use(provider).customers.create(input)`
   * and persist the returned id via `setPaymentCustomerId(provider, id)`.
   * Apps usually call this once during checkout / onboarding.
   */
  async createCustomer(
    manager: PaymentManager,
    input: CreateCustomerInput,
    provider?: string,
  ): Promise<PaymentCustomer> {
    const p = provider ?? manager.config.default
    const created = await manager.use(p).customers.create(input)
    await this.setPaymentCustomerId(p, created.id)
    return created
  }

  /**
   * Return the existing customer (if any) or create + persist one.
   * Idempotent under retries when `input.idempotencyKey` is set on
   * drivers with the `idempotency` capability.
   */
  async customerOrCreate(
    manager: PaymentManager,
    input: CreateCustomerInput,
    provider?: string,
  ): Promise<PaymentCustomer> {
    const existing = await this.customer(manager, provider)
    if (existing !== null) return existing
    return this.createCustomer(manager, input, provider)
  }

  // ─── Charges + subscriptions + payment methods ────────────────────────

  /**
   * One-shot charge against this billable's customer. The mixin
   * injects `customer` from storage so callers omit it.
   *
   * Apps that explicitly want to charge a different customer reach
   * `manager.charges.create(...)` directly — the mixin is sugar, not
   * a gate.
   */
  async charge(
    manager: PaymentManager,
    input: Omit<CreateChargeInput, 'customer'>,
    provider?: string,
  ): Promise<PaymentCharge> {
    const p = provider ?? manager.config.default
    return manager.use(p).charges.create({
      ...input,
      customer: this.requireCustomerId(p),
    })
  }

  /** Subscribe this billable to `price`. Same omitted-customer ergonomics as `charge()`. */
  async subscribe(
    manager: PaymentManager,
    input: Omit<CreateSubscriptionInput, 'customer'>,
    provider?: string,
  ): Promise<PaymentSubscription> {
    const p = provider ?? manager.config.default
    return manager.use(p).subscriptions.create({
      ...input,
      customer: this.requireCustomerId(p),
    })
  }

  /** Payment methods attached to this billable's customer. */
  async paymentMethods(manager: PaymentManager, provider?: string): Promise<PaymentMethod[]> {
    const p = provider ?? manager.config.default
    const cid = this.paymentCustomerId(p)
    if (cid === undefined) return []
    const result = await manager.use(p).paymentMethods.list(cid)
    return result.data
  }

  // ─── Ledger reads ─────────────────────────────────────────────────────

  /**
   * Subscriptions stored in the local ledger for this billable's
   * customer (newest first). Returns an empty array when there's no
   * customer id yet.
   *
   * Reads `payment_subscription` joined by `(provider,
   * customer_provider_id)`. Honours the tenant the caller is in
   * (RLS).
   */
  async subscriptions(ledger: PaymentLedger, provider: string): Promise<PaymentSubscriptionRow[]> {
    const cid = this.paymentCustomerId(provider)
    if (cid === undefined) return []
    return ledger.subscriptionsForCustomer(provider, cid)
  }

  /** Invoices for this billable's customer (newest first, default 50). */
  async invoices(
    ledger: PaymentLedger,
    provider: string,
    options: { limit?: number } = {},
  ): Promise<PaymentInvoiceRow[]> {
    const cid = this.paymentCustomerId(provider)
    if (cid === undefined) return []
    return ledger.invoicesForCustomer(provider, cid, options)
  }

  /**
   * `true` when the billable has at least one subscription whose
   * status is `active` / `trialing` / `past_due`. Cancelled, ended,
   * and incomplete don't count.
   */
  async hasActiveSubscription(ledger: PaymentLedger, provider: string): Promise<boolean> {
    const subs = await this.subscriptions(ledger, provider)
    return subs.some((s) => ACTIVE_SUBSCRIPTION_STATUSES.has(s.status))
  }

  /**
   * `true` when the billable has an active subscription on the
   * given `priceProviderId`. Useful for entitlement checks
   * (`if (await user.subscribedToPrice(ledger, 'price_pro')) { ... }`).
   */
  async subscribedToPrice(
    ledger: PaymentLedger,
    priceProviderId: string,
    provider: string,
  ): Promise<boolean> {
    const subs = await this.subscriptions(ledger, provider)
    return subs.some(
      (s) => s.price_provider_id === priceProviderId && ACTIVE_SUBSCRIPTION_STATUSES.has(s.status),
    )
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private requireCustomerId(provider: string): string {
    const cid = this.paymentCustomerId(provider)
    if (cid === undefined) {
      throw new Error(
        `Billable: no customer id stored for provider "${provider}". Call createCustomer() / customerOrCreate() first.`,
      )
    }
    return cid
  }
}

// Constructor type used by the mixin form.
// biome-ignore lint/suspicious/noExplicitAny: mixin signatures need any[] constructor args.
type Ctor<T = object> = new (...args: any[]) => T

/**
 * Mixin form — `class User extends billable(Model) { ... }`.
 *
 * Layers every `Billable` method onto `Base` and threads the same
 * default-storage contract. Apps with a `payment_customers` jsonb
 * column work zero-config; apps with a different layout override the
 * two storage hooks on the subclass.
 *
 * Why both this and the `Billable` base class — apps that need a
 * fresh class extend `Billable` directly; apps that already extend
 * `Model` / a domain base reach for `billable(Model)`. The two share
 * the same Billable prototype so behaviour is identical.
 */
export function billable<TBase extends Ctor>(Base: TBase): TBase & Ctor<Billable> {
  abstract class _Billable extends (Base as Ctor) {}
  // Copy every Billable method (own props of the prototype) onto the
  // mixin chain. We mutate the chain directly instead of `extends
  // Billable` because Billable doesn't share `Base`'s ancestry —
  // multiple-extends isn't a thing in JS.
  for (const key of Object.getOwnPropertyNames(Billable.prototype)) {
    if (key === 'constructor') continue
    const desc = Object.getOwnPropertyDescriptor(Billable.prototype, key)
    if (desc !== undefined) {
      Object.defineProperty(_Billable.prototype, key, desc)
    }
  }
  return _Billable as unknown as TBase & Ctor<Billable>
}
