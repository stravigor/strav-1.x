// Public API of `@strav/payment`.
//
// V1: provider-agnostic payment abstraction — normalized DTOs +
// multi-provider routing + ledger schema + webhook dispatcher.
// Composes with `@strav/database` for the ledger tables and
// `@strav/http` for the webhook route.
//
// Drivers ship as separate adapter packages:
//   `@strav/payment-stripe`, `@strav/payment-paddle`,
//   `@strav/payment-omise`. The `MockDriver` in `./drivers` is
//   for tests and as the reference implementation.

export type * from './dto/index.ts'
export {
  extractCardToken,
  MockDriver,
  type MockDriverOptions,
  paymentMethodKind,
  unsupported,
} from './drivers/index.ts'
export {
  applyPaymentLedgerMigration,
  type ApplyPaymentLedgerMigrationOptions,
  PaymentCustomerRow,
  PaymentInvoiceRow,
  PaymentLedger,
  PaymentSubscriptionRow,
  paymentCustomerSchema,
  paymentInvoiceSchema,
  paymentSubscriptionSchema,
} from './ledger/index.ts'
export type { PaymentCapability } from './payment_capabilities.ts'
export type {
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
export {
  PaymentConfigError,
  PaymentError,
  PaymentProviderError,
  ProviderUnsupportedError,
  UnknownProviderError,
  WebhookIdempotencyError,
  WebhookSignatureError,
} from './payment_error.ts'
export {
  PaymentManager,
  type PaymentManagerOptions,
} from './payment_manager.ts'
export { PaymentProvider } from './payment_provider.ts'
export {
  readTenantId,
  TENANT_METADATA_KEY,
  tenantedMetadata,
} from './tenant_metadata.ts'
export type {
  LedgerConfig,
  PaymentConfig,
  ProviderConfig,
} from './types.ts'
export {
  paymentWebhook,
  type PaymentWebhookOptions,
  PaymentWebhookEvent,
  PaymentWebhookEventRepository,
  paymentWebhookEventSchema,
  PaymentWebhookRegistry,
} from './webhook/index.ts'
