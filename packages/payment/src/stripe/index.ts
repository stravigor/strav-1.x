// Public API of `@strav/payment/stripe`.
//
// Subpath barrel for the Stripe driver. Apps import from here to
// register the adapter:
//
// ```ts
// import { StripePaymentProvider } from '@strav/payment/stripe'
//
// export default [PaymentProvider, StripePaymentProvider, ...]
// ```
//
// `StripePaymentDriver` + mapper exports are advanced — used by
// tests and by apps that hand-wire a driver instance via
// `manager.useDriver(name, driver)`.

export {
  toPaymentCharge,
  toPaymentCheckoutSession,
  toPaymentCustomer,
  toPaymentInvoice,
  toPaymentLink,
  toPaymentMethod,
  toPaymentPrice,
  toPaymentProduct,
  toPaymentSubscription,
} from './mappers/stripe_mappers.ts'
export {
  buildStripeMethodWiring,
  STRIPE_SUPPORTED_METHOD_KINDS,
  type StripeMethodBuildResult,
  type StripeMethodWiring,
} from './mappers/stripe_method_spec.ts'
export { stripeNextAction } from './mappers/stripe_next_action_mapper.ts'
export type { StripeProviderConfig } from './stripe_config.ts'
export {
  StripePaymentDriver,
  type StripeDriverOptions,
} from './stripe_driver.ts'
export { StripePaymentProvider } from './stripe_provider.ts'
export { stripeNormalize } from './webhook/stripe_normalize.ts'
