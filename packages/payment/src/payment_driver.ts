/**
 * `PaymentDriver` — the driver contract every adapter implements.
 *
 * One `PaymentDriver` represents a configured provider instance
 * (`config.payment.providers['stripe']`). The manager holds one
 * driver per configured name and routes resource calls into it.
 *
 * Methods drivers don't support throw `ProviderUnsupportedError`
 * synchronously. The driver's `capabilities` set declares the
 * supported method names — apps that branch on capability avoid
 * the throw by checking first.
 */

import type {
  CancelSubscriptionOptions,
  CreateChargeInput,
  CreateCheckoutInput,
  CreateCustomerInput,
  CreatePaymentLinkInput,
  CreatePriceInput,
  CreateProductInput,
  CreateRefundInput,
  CreateSubscriptionInput,
  ListCustomersOptions,
  ListInvoicesOptions,
  ListPaymentLinksOptions,
  ListPaymentMethodsOptions,
  ListPricesOptions,
  ListProductsOptions,
  ListSubscriptionsOptions,
  NormalizedWebhookEvent,
  PaginatedCustomers,
  PaginatedInvoices,
  PaginatedPaymentLinks,
  PaginatedPaymentMethods,
  PaginatedPrices,
  PaginatedProducts,
  PaginatedSubscriptions,
  PaymentCharge,
  PaymentCheckoutSession,
  PaymentCustomer,
  PaymentInvoice,
  PaymentLink,
  PaymentMethod,
  PaymentPrice,
  PaymentProduct,
  PaymentRefund,
  PaymentSubscription,
  UpdateCustomerInput,
  UpdateSubscriptionInput,
} from './dto/index.ts'
import type { PaymentCapability } from './payment_capabilities.ts'

export interface CustomerOps {
  create(input: CreateCustomerInput): Promise<PaymentCustomer>
  retrieve(id: string): Promise<PaymentCustomer>
  update(id: string, input: UpdateCustomerInput): Promise<PaymentCustomer>
  list(options?: ListCustomersOptions): Promise<PaginatedCustomers>
  delete(id: string): Promise<void>
}

export interface ProductOps {
  create(input: CreateProductInput): Promise<PaymentProduct>
  retrieve(id: string): Promise<PaymentProduct>
  update(id: string, input: Partial<CreateProductInput>): Promise<PaymentProduct>
  list(options?: ListProductsOptions): Promise<PaginatedProducts>
}

export interface PriceOps {
  create(input: CreatePriceInput): Promise<PaymentPrice>
  retrieve(id: string): Promise<PaymentPrice>
  list(options?: ListPricesOptions): Promise<PaginatedPrices>
}

export interface SubscriptionOps {
  create(input: CreateSubscriptionInput): Promise<PaymentSubscription>
  retrieve(id: string): Promise<PaymentSubscription>
  update(id: string, input: UpdateSubscriptionInput): Promise<PaymentSubscription>
  cancel(id: string, options?: CancelSubscriptionOptions): Promise<PaymentSubscription>
  list(options?: ListSubscriptionsOptions): Promise<PaginatedSubscriptions>
}

export interface PaymentMethodOps {
  /** Attach a payment method (typically a tokenized card) to a customer. */
  attach(paymentMethodId: string, customerId: string): Promise<PaymentMethod>
  /**
   * Detach a payment method. `customerId` is optional for providers
   * that can look up the customer from the payment method itself
   * (Stripe), required for providers that store cards under a
   * customer scope (Omise). Drivers throw `ProviderUnsupportedError`
   * when they need `customerId` and the caller omits it.
   */
  detach(paymentMethodId: string, customerId?: string): Promise<PaymentMethod>
  list(customerId: string, options?: ListPaymentMethodsOptions): Promise<PaginatedPaymentMethods>
}

export interface ChargeOps {
  create(input: CreateChargeInput): Promise<PaymentCharge>
  retrieve(id: string): Promise<PaymentCharge>
  capture(id: string, options?: { amount?: number }): Promise<PaymentCharge>
  refund(input: CreateRefundInput): Promise<PaymentRefund>
}

export interface InvoiceOps {
  retrieve(id: string): Promise<PaymentInvoice>
  list(options?: ListInvoicesOptions): Promise<PaginatedInvoices>
  finalize(id: string): Promise<PaymentInvoice>
  void(id: string): Promise<PaymentInvoice>
}

export interface CheckoutOps {
  create(input: CreateCheckoutInput): Promise<PaymentCheckoutSession>
  retrieve(id: string): Promise<PaymentCheckoutSession>
}

export interface LinkOps {
  create(input: CreatePaymentLinkInput): Promise<PaymentLink>
  retrieve(id: string): Promise<PaymentLink>
  list(options?: ListPaymentLinksOptions): Promise<PaginatedPaymentLinks>
  /** Stop accepting new payments via this link. Throws `ProviderUnsupportedError` on drivers that can't (Omise). */
  deactivate(id: string): Promise<PaymentLink>
}

export interface WebhookOps {
  /**
   * Verify the provider signature against the raw body. Returns
   * the parsed provider-native event. Throws
   * `WebhookSignatureError` on failure.
   */
  verify(rawBody: string, signature: string): Promise<unknown>
  /**
   * Map a provider-native event onto the framework's
   * `NormalizedWebhookEvent`. Drivers translate the closed
   * union of types they support; events outside the union map
   * to `null` and the dispatcher skips user handlers (but still
   * records the dedup row).
   */
  normalize(event: unknown): NormalizedWebhookEvent | null
}

export interface PaymentDriver {
  /** Driver identifier — matches the `driver:` discriminator in `ProviderConfig`. */
  readonly name: string
  /** App-chosen instance name (`config.payment.providers[name]`). */
  readonly instanceName: string
  /** Declared feature set. Apps check this to branch around `ProviderUnsupportedError`. */
  readonly capabilities: ReadonlySet<PaymentCapability>

  readonly customers: CustomerOps
  readonly products: ProductOps
  readonly prices: PriceOps
  readonly subscriptions: SubscriptionOps
  readonly paymentMethods: PaymentMethodOps
  readonly charges: ChargeOps
  readonly invoices: InvoiceOps
  readonly checkout: CheckoutOps
  readonly links: LinkOps
  readonly webhook: WebhookOps
}

/** Factory the manager invokes for each configured provider. */
export type PaymentDriverFactory = (config: {
  /** App-chosen instance name (`'stripe'`, `'asia'`, …). */
  instanceName: string
  /** Provider-config object with `driver:` + driver-specific fields. */
  config: Record<string, unknown> & { driver: string }
}) => PaymentDriver
