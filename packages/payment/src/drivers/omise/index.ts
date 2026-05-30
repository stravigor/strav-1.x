// Public API of `@strav/payment/omise`.
//
// Subpath barrel for the Omise driver. Apps import the
// ServiceProvider and register it in `bootstrap/providers.ts`:
//
// ```ts
// import { OmisePaymentProvider } from '@strav/payment/omise'
//
// export default [PaymentProvider, OmisePaymentProvider, ...]
// ```
//
// Capability scope is narrower than Stripe — products / prices /
// subscriptions / invoices / checkout throw
// `ProviderUnsupportedError`. See `docs/payment/omise.md` (when
// it lands) for the full capability matrix.

export type { OmiseProviderConfig } from './omise_config.ts'
export {
  OmisePaymentDriver,
  type OmiseDriverOptions,
} from './omise_driver.ts'
export {
  toPaymentCharge,
  toPaymentCustomer,
  toPaymentLink,
  toPaymentMethod,
} from './omise_mappers.ts'
export {
  buildOmiseMethodSpec,
  OMISE_SUPPORTED_METHOD_KINDS,
  omiseSourceFlowFor,
  type OmiseMethodBuildResult,
  type OmiseSourceRequest,
} from './omise_method_spec.ts'
export {
  omiseNextAction,
  type OmiseChargeLike,
  type OmiseSourceLike,
} from './omise_next_action_mapper.ts'
export {
  OMISE_PRICE_SPEC_PREFIX,
  omisePriceSpec,
  parseOmisePriceSpec,
  type OmisePeriod,
  type OmisePriceSpec,
} from './omise_price_spec.ts'
export {
  toPaymentSubscription as toPaymentSubscriptionFromSchedule,
  type OmiseSchedule,
} from './omise_schedule_mapper.ts'
export { OmisePaymentProvider } from './omise_provider.ts'
export {
  omiseNormalize,
  omiseVerify,
  type OmiseEvent,
} from './omise_webhook.ts'
